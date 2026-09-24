"""Short-lived OpenAI transcription credentials for live transcription.

The card streams the user's speech to an OpenAI Realtime transcription session
so it can show the words while they are spoken. The browser must never hold
the real API key, so the integration mints an ephemeral client secret
(`POST /v1/realtime/client_secrets`) scoped to a transcription-only session and
hands only that to the card. The key is taken from the OpenAI Conversation
integration, so no second copy of it is stored.
"""

from __future__ import annotations

from typing import Any

OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
OPENAI_CONVERSATION_DOMAIN = "openai_conversation"

# Realtime transcription models. The "live" models stream words while audio
# arrives and take `languages` / `keywords`; the others transcribe each
# committed turn and take a single `language` and a `prompt`.
LIVE_MODELS = ("gpt-live-transcribe", "gpt-realtime-whisper")
MODELS = (*LIVE_MODELS, "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe")
DEFAULT_MODEL = "gpt-live-transcribe"

# Long enough to connect after the wake word; the session itself stays open
# once connected.
SECRET_TTL_SECONDS = 120
SAMPLE_RATE = 24000


class SttLiveError(Exception):
    """Minting a transcription session failed; `code` is sent to the card."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def build_session_request(
    model: str,
    language: str | None = None,
    keywords: list[str] | None = None,
) -> dict[str, Any]:
    """The client_secrets request body for a transcription-only session.

    Turn detection is off: the card ends each turn with
    `input_audio_buffer.commit` when Home Assistant's pipeline reports the end
    of speech, and the live models don't support server VAD at all.
    """
    if model not in MODELS:
        raise SttLiveError("invalid_model", f"Unsupported transcription model: {model}")
    lang = (language or "").split("-")[0].lower() or None
    transcription: dict[str, Any] = {"model": model}
    if model in (*LIVE_MODELS, "gpt-transcribe"):
        if lang:
            transcription["languages"] = [lang]
        words = [word for word in (keywords or []) if isinstance(word, str) and word.strip()]
        if words and model != "gpt-realtime-whisper":
            transcription["keywords"] = words[:100]
    elif lang:
        transcription["language"] = lang
    return {
        "expires_after": {"anchor": "created_at", "seconds": SECRET_TTL_SECONDS},
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    # a wall tablet hears the room, not a headset
                    "noise_reduction": {"type": "far_field"},
                    "transcription": transcription,
                    "turn_detection": None,
                }
            },
        },
    }


def find_openai_api_key(hass) -> str:
    """The API key of the first OpenAI Conversation config entry."""
    for entry in hass.config_entries.async_entries(OPENAI_CONVERSATION_DOMAIN):
        key = entry.data.get("api_key")
        if key:
            return key
    raise SttLiveError(
        "no_api_key",
        "Live transcription needs the OpenAI Conversation integration to be set up.",
    )


async def async_mint_client_secret(session, api_key: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST the session request; return {client_secret, expires_at}."""
    async with session.post(
        OPENAI_CLIENT_SECRETS_URL,
        json=body,
        headers={"Authorization": f"Bearer {api_key}"},
    ) as response:
        payload = await response.json(content_type=None)
        if response.status != 200:
            error = (payload or {}).get("error") or {}
            raise SttLiveError(
                error.get("code") or f"http_{response.status}",
                error.get("message") or f"OpenAI returned HTTP {response.status}",
            )
    return {"client_secret": payload["value"], "expires_at": payload["expires_at"]}
