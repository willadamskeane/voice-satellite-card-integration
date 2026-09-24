"""Live transcription session minting, without a Home Assistant install."""

import ast
import importlib.util
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).parents[1] / 'custom_components/voice_satellite'

spec = importlib.util.spec_from_file_location('stt_live', ROOT / 'stt_live.py')
stt_live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stt_live)


class FakeResponse:
    def __init__(self, status, payload):
        self.status, self._payload = status, payload

    async def json(self, content_type=None):
        return self._payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, status=200, payload=None):
        self.requests = []
        self.response = FakeResponse(status, payload if payload is not None else {
            'value': 'ek_test', 'expires_at': 1790000120, 'session': {'type': 'transcription'},
        })

    def post(self, url, json=None, headers=None):
        self.requests.append({'url': url, 'json': json, 'headers': headers})
        return self.response


def config_entries(*entries):
    return SimpleNamespace(async_entries=lambda domain: [
        SimpleNamespace(data=data) for d, data in entries if d == domain
    ])


class SessionRequestTest(unittest.TestCase):
    def test_live_model_takes_languages_and_keywords_and_no_turn_detection(self):
        body = stt_live.build_session_request('gpt-live-transcribe', 'en-US', ['Hearth', ' ', 'Billy'])
        audio = body['session']['audio']['input']
        self.assertEqual(body['session']['type'], 'transcription')
        self.assertEqual(audio['format'], {'type': 'audio/pcm', 'rate': 24000})
        self.assertEqual(audio['transcription'], {
            'model': 'gpt-live-transcribe', 'languages': ['en'], 'keywords': ['Hearth', 'Billy'],
        })
        self.assertIsNone(audio['turn_detection'])
        self.assertEqual(audio['noise_reduction'], {'type': 'far_field'})
        self.assertLessEqual(body['expires_after']['seconds'], 300)

    def test_turn_models_take_a_single_language(self):
        body = stt_live.build_session_request('gpt-4o-mini-transcribe', 'en-GB', ['ignored'])
        self.assertEqual(body['session']['audio']['input']['transcription'], {
            'model': 'gpt-4o-mini-transcribe', 'language': 'en',
        })

    def test_rejects_unknown_models(self):
        with self.assertRaises(stt_live.SttLiveError) as caught:
            stt_live.build_session_request('gpt-5')
        self.assertEqual(caught.exception.code, 'invalid_model')


class ApiKeyTest(unittest.TestCase):
    def test_reads_the_openai_conversation_entry(self):
        hass = SimpleNamespace(config_entries=config_entries(
            ('openai_conversation', {'api_key': 'sk-real'}), ('other', {'api_key': 'nope'}),
        ))
        self.assertEqual(stt_live.find_openai_api_key(hass), 'sk-real')

    def test_explains_a_missing_integration(self):
        hass = SimpleNamespace(config_entries=config_entries())
        with self.assertRaises(stt_live.SttLiveError) as caught:
            stt_live.find_openai_api_key(hass)
        self.assertEqual(caught.exception.code, 'no_api_key')


class MintTest(unittest.IsolatedAsyncioTestCase):
    async def test_returns_only_the_ephemeral_secret(self):
        session = FakeSession()
        result = await stt_live.async_mint_client_secret(session, 'sk-real', {'session': {}})
        self.assertEqual(result, {'client_secret': 'ek_test', 'expires_at': 1790000120})
        self.assertEqual(session.requests[0]['headers'], {'Authorization': 'Bearer sk-real'})
        self.assertEqual(session.requests[0]['url'], stt_live.OPENAI_CLIENT_SECRETS_URL)

    async def test_surfaces_openai_errors(self):
        session = FakeSession(403, {'error': {'code': 'model_not_found', 'message': 'no access'}})
        with self.assertRaises(stt_live.SttLiveError) as caught:
            await stt_live.async_mint_client_secret(session, 'sk-real', {})
        self.assertEqual((caught.exception.code, str(caught.exception)), ('model_not_found', 'no access'))


def load_handler(session):
    module = ast.parse((ROOT / '__init__.py').read_text())
    handler = next(node for node in module.body
                   if isinstance(node, ast.AsyncFunctionDef) and node.name == 'ws_stt_live_session')
    handler.decorator_list = []
    handler.body = [node for node in handler.body if not isinstance(node, ast.ImportFrom)]
    namespace = {
        '_LOGGER': logging.getLogger('test_stt_live'),
        '_find_entity': lambda hass, entity_id: hass.entities.get(entity_id),
        'async_get_clientsession': lambda hass: session,
        'find_openai_api_key': stt_live.find_openai_api_key,
        'build_session_request': stt_live.build_session_request,
        'async_mint_client_secret': stt_live.async_mint_client_secret,
        'SttLiveError': stt_live.SttLiveError,
        'OPENAI_REALTIME_URL': stt_live.OPENAI_REALTIME_URL,
    }
    exec(compile(ast.Module(body=[handler], type_ignores=[]), str(ROOT / '__init__.py'), 'exec'), namespace)
    return namespace['ws_stt_live_session']


class CommandTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.responses = []
        self.connection = SimpleNamespace(
            send_error=lambda *args: self.responses.append(('error', *args)),
            send_result=lambda *args: self.responses.append(('ok', *args)),
        )
        self.hass = SimpleNamespace(
            entities={'assist_satellite.kiosk': object()},
            config_entries=config_entries(('openai_conversation', {'api_key': 'sk-real'})),
        )
        self.msg = {'id': 7, 'entity_id': 'assist_satellite.kiosk', 'model': 'gpt-live-transcribe', 'language': 'en-US'}

    async def test_sends_the_secret_and_connection_details_never_the_key(self):
        await load_handler(FakeSession())(self.hass, self.connection, self.msg)
        kind, msg_id, result = self.responses[0]
        self.assertEqual((kind, msg_id), ('ok', 7))
        self.assertEqual(result['client_secret'], 'ek_test')
        self.assertEqual(result['url'], stt_live.OPENAI_REALTIME_URL)
        self.assertEqual(result['sample_rate'], 24000)
        self.assertNotIn('sk-real', repr(result))

    async def test_unknown_satellite_is_rejected_before_calling_openai(self):
        session = FakeSession()
        await load_handler(session)(self.hass, self.connection, {**self.msg, 'entity_id': 'assist_satellite.other'})
        self.assertEqual(self.responses[0][:3], ('error', 7, 'not_found'))
        self.assertEqual(session.requests, [])

    async def test_openai_refusal_becomes_an_error_reply(self):
        session = FakeSession(404, {'error': {'code': 'model_not_found', 'message': 'no access'}})
        await load_handler(session)(self.hass, self.connection, self.msg)
        self.assertEqual(self.responses[0][:3], ('error', 7, 'model_not_found'))


if __name__ == '__main__':
    unittest.main()
