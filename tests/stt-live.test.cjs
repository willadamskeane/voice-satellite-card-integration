// Run with: node --experimental-vm-modules --test tests/stt-live.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function load() {
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    console, btoa, JSON, Math, Number, String, Int16Array, Float32Array, Uint8Array, Promise,
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const file = path.join(root, 'src/stt-live/index.js');
  const module = new vm.SourceTextModule(readFileSync(file, 'utf8'), { context, identifier: file });
  await module.link(() => { throw new Error('no imports expected'); });
  await module.evaluate();
  return { ...module.namespace, timers };
}

class FakeSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.sent = []; this.closed = false;
    FakeSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function connection(result = { client_secret: 'ek_1', url: 'wss://example/realtime', model: 'gpt-live-transcribe' }) {
  const calls = [];
  return {
    calls,
    sendMessagePromise(msg) { calls.push(msg); return result instanceof Error ? Promise.reject(result) : Promise.resolve(result); },
  };
}

function speech(ms, rate = 16000) {
  const samples = new Float32Array((rate * ms) / 1000);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return samples;
}

const decodedSamples = (msg) => Buffer.from(msg.audio, 'base64').length / 2;

test('resampling 16 kHz to 24 kHz keeps the length ratio and is seamless across chunks', async () => {
  const { PcmResampler } = await load();
  const whole = speech(1000);
  const one = new PcmResampler(16000).push(whole);
  const split = new PcmResampler(16000);
  const parts = [];
  for (let i = 0; i < whole.length; i += 1234) parts.push(...split.push(whole.subarray(i, i + 1234)));
  assert.ok(Math.abs(one.length - 24000) <= 2, `got ${one.length} samples`);
  assert.equal(parts.length, one.length);
  assert.deepEqual(parts, Array.from(one));
  assert.ok(parts.every(Number.isFinite));
});

test('mints a session with the satellite, model and language, and connects with the secret', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const conn = connection();
  const t = new LiveTranscriber({ connection: conn, entityId: 'assist_satellite.kiosk', model: 'gpt-live-transcribe', language: 'en-US', WebSocketImpl: FakeSocket });
  t.start(); await flush();
  assert.deepEqual({ ...conn.calls[0] }, { type: 'voice_satellite/stt_live_session', entity_id: 'assist_satellite.kiosk', model: 'gpt-live-transcribe', language: 'en-US' });
  assert.deepEqual([...FakeSocket.instances[0].protocols], ['realtime', 'openai-insecure-api-key.ek_1']);
});

test('audio spoken while connecting is sent once the socket opens, in ~100 ms batches', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const t = new LiveTranscriber({ connection: connection(), entityId: 'e', WebSocketImpl: FakeSocket });
  t.start(); await flush();
  for (let i = 0; i < 5; i++) t.pushAudio(speech(100), 16000);
  const ws = FakeSocket.instances[0];
  assert.equal(ws.sent.length, 0);
  ws.open();
  const appends = ws.sent.filter((m) => m.type === 'input_audio_buffer.append');
  assert.ok(appends.length >= 4);
  const total = appends.reduce((n, m) => n + decodedSamples(m), 0);
  assert.ok(Math.abs(total - 12000) <= 2400, `sent ${total} samples`);
});

test('partial text follows the deltas and commit resolves with the final transcript', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const partials = [];
  const t = new LiveTranscriber({ connection: connection(), entityId: 'e', WebSocketImpl: FakeSocket, onPartial: (s) => partials.push(s) });
  t.start(); await flush();
  const ws = FakeSocket.instances[0];
  ws.open();
  t.pushAudio(speech(150), 16000);
  ws.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Turn on' });
  ws.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: ' the lights' });
  const final = t.commit();
  assert.equal(ws.sent.at(-1).type, 'input_audio_buffer.commit');
  assert.equal(ws.sent.at(-2).type, 'input_audio_buffer.append', 'the tail of the audio is flushed before the commit');
  ws.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' Turn on the lights. ' });
  assert.equal(await final, 'Turn on the lights.');
  assert.deepEqual(partials, ['Turn on', 'Turn on the lights', 'Turn on the lights.']);
  t.pushAudio(speech(200), 16000);
  assert.equal(ws.sent.at(-1).type, 'input_audio_buffer.commit', 'audio after the commit is not sent');
});

test('a commit requested before the socket opens is sent after the queued audio', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const t = new LiveTranscriber({ connection: connection(), entityId: 'e', WebSocketImpl: FakeSocket });
  t.start(); await flush();
  t.pushAudio(speech(300), 16000);
  const final = t.commit();
  const ws = FakeSocket.instances[0];
  ws.open();
  assert.deepEqual(ws.sent.map((m) => m.type).slice(-1), ['input_audio_buffer.commit']);
  assert.ok(ws.sent.filter((m) => m.type === 'input_audio_buffer.append').length >= 1);
  ws.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hi' });
  assert.equal(await final, 'hi');
});

test('a refused session reports the error and commit resolves to null at once', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const errors = [];
  const refused = Object.assign(new Error('no access'), { code: 'model_not_found' });
  const t = new LiveTranscriber({ connection: connection(refused), entityId: 'e', WebSocketImpl: FakeSocket, onError: (c, m) => errors.push([c, m]) });
  await t.start();
  assert.deepEqual(errors, [['model_not_found', 'no access']]);
  assert.equal(FakeSocket.instances.length, 0);
  assert.equal(await t.commit(), null);
});

test('a transcription failure or dropped socket resolves a pending commit to null', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const t = new LiveTranscriber({ connection: connection(), entityId: 'e', WebSocketImpl: FakeSocket });
  t.start(); await flush();
  const ws = FakeSocket.instances[0];
  ws.open();
  const final = t.commit();
  ws.emit({ type: 'conversation.item.input_audio_transcription.failed', error: { code: 'x', message: 'bad audio' } });
  assert.equal(await final, null);
  assert.ok(ws.closed);
});

test('commit gives up after its timeout so Home Assistant text can be used', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber, timers } = await load();
  const t = new LiveTranscriber({ connection: connection(), entityId: 'e', WebSocketImpl: FakeSocket });
  t.start(); await flush();
  FakeSocket.instances[0].open();
  const final = t.commit(1500);
  const [id, timer] = [...timers.entries()].at(-1);
  assert.equal(timer.delay, 1500);
  timers.delete(id); timer.fn();
  assert.equal(await final, null);
});

test('closing before the session is minted never opens a socket', async () => {
  FakeSocket.instances = [];
  const { LiveTranscriber } = await load();
  const t = new LiveTranscriber({ connection: connection(), entityId: 'e', WebSocketImpl: FakeSocket });
  const started = t.start();
  t.close();
  await started;
  assert.equal(FakeSocket.instances.length, 0);
});
