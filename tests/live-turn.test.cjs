// Run with: node --experimental-vm-modules --test tests/live-turn.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const noop = () => {};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const plain = (value) => JSON.parse(JSON.stringify(value));

class FakeTranscriber {
  static instances = [];
  constructor(opts) {
    this.opts = opts; this.pushed = 0; this.closed = false; this.committed = false;
    FakeTranscriber.instances.push(this);
    this.final = new Promise((resolve) => { this.resolveFinal = resolve; });
  }
  start() { this.started = true; return Promise.resolve(); }
  pushAudio() { this.pushed++; }
  commit() { this.committed = true; return this.final; }
  close() { this.closed = true; }
}

async function fixture({ live = true } = {}) {
  FakeTranscriber.instances = [];
  const context = vm.createContext({
    __VERSION__: 'test', console,
    setTimeout: () => 0, clearTimeout: noop,
  });
  const modules = new Map();
  const stubs = {
    'src/wake-word/native-handoff.js': { resumeNativeWake: async () => {} },
    'src/pipeline/kiosk-transport.js': { nativePipelinePreferred: () => false, subscribeKioskPipelineRun: noop },
    'src/audio/chime.js': { CHIME_WAKE: {}, getChimeDuration: () => 0 },
    'src/session/events.js': { onTTSComplete: noop },
    'src/shared/tool-name.js': { humanizeToolName: (x) => x },
    'src/stt-live/index.js': { LiveTranscriber: FakeTranscriber },
  };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const stub = stubs[path.relative(root, filename)];
    const module = stub
      ? new vm.SyntheticModule(Object.keys(stub), function () {
        for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
      }, { context, identifier: filename })
      : new vm.SourceTextModule(readFileSync(filename, 'utf8'), { context, identifier: filename });
    modules.set(filename, module);
    return module;
  }
  const module = load(path.join(root, 'src/pipeline/index.js'));
  await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await module.evaluate();

  const runs = [];
  const chat = { live: [], shown: [], showLiveTranscription(t) { this.live.push(t); }, showTranscription(t) { this.shown.push(t); }, clear: noop };
  const calls = { stopSending: 0, finishes: 0 };
  const card = {
    config: { satellite_entity: 'assist_satellite.test', stt_live_transcription: live },
    hass: { language: 'en', states: { 'assist_satellite.test': { attributes: { muted: false } } } },
    logger: { log: noop, error: noop }, currentState: 'IDLE',
    toast: { show: noop, dismiss: noop }, chat,
    ui: { hideBar: noop, hideBlurOverlay: noop, showStartButton: noop },
    mediaPlayer: { resumeAfterInterrupt: noop }, tts: { storeStreamingUrl: noop, isPlaying: false },
    setState(state) { this.currentState = state; },
    audio: {
      _mediaStream: {}, liveSink: null,
      stopSending() { calls.stopSending++; }, stopBuffering: noop,
      startMicrophone: async () => {}, startSending: noop,
    },
    connection: {
      addEventListener: noop, removeEventListener: noop,
      async subscribeMessage(callback, message) {
        runs.push({ message: plain(message), callback });
        callback({ type: 'init', handler_id: message.intent_input ? null : 1 });
        return async () => {};
      },
    },
  };
  const pipeline = new module.namespace.PipelineManager(card);
  pipeline.finishRunEnd = () => { calls.finishes++; };
  card.pipeline = pipeline;
  card.onPipelineMessage = (m) => {
    if (m.type === 'run-start') pipeline.handleRunStart(m.data || {});
    if (m.type === 'stt-vad-end') pipeline.handleSttVadEnd();
    if (m.type === 'stt-end') pipeline.handleSttEnd(m.data);
    if (m.type === 'run-end') pipeline.handleRunEnd();
    if (m.type === 'error') pipeline.handleError(m.data);
  };
  const emit = (type, data) => card.onPipelineMessage({ type, data });
  return { card, pipeline, runs, chat, calls, emit };
}

async function startSttTurn(f, extra = {}) {
  await f.pipeline.start({ start_stage: 'stt', end_stage: 'tts', conversation_id: 'conv-1', wake_word_slot: 2, ...extra });
  f.emit('run-start', {});
  return FakeTranscriber.instances.at(-1);
}

test('an STT turn ends after STT in HA and streams the same audio live', async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  assert.equal(f.runs[0].message.start_stage, 'stt');
  assert.equal(f.runs[0].message.end_stage, 'stt');
  assert.equal(t.opts.entityId, 'assist_satellite.test');
  assert.equal(t.opts.language, 'en');
  f.card.audio.liveSink(new Float32Array(1600), 16000);
  assert.equal(t.pushed, 1);
  t.opts.onPartial('Turn on');
  assert.deepEqual(f.chat.live, ['Turn on']);
});

test('the live transcript is handed to the intent stage with the turn context', async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  f.emit('stt-vad-end', {});
  assert.ok(t.committed);
  t.resolveFinal('Turn on the study lights.');
  await flush();
  const intentRun = f.runs[1].message;
  assert.equal(intentRun.start_stage, 'intent');
  assert.equal(intentRun.end_stage, 'tts');
  assert.equal(intentRun.intent_input, 'Turn on the study lights.');
  assert.equal(intentRun.conversation_id, 'conv-1');
  assert.equal(intentRun.wake_word_slot, 2);
  assert.deepEqual(f.chat.shown, ['Turn on the study lights.']);
  assert.ok(t.closed);
  assert.ok(f.calls.stopSending > 0, 'audio to the finished STT run stops');
});

test("late events from the replaced STT run don't end the interaction", async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  f.emit('stt-vad-end', {});
  t.resolveFinal('What time is it?');
  await flush();
  f.runs[0].callback({ type: 'stt-end', data: { stt_output: { text: 'what time' } } });
  f.emit('stt-end', { stt_output: { text: 'what time' } });
  f.emit('error', { code: 'stt-stream-failed' });
  f.emit('run-end', {});
  assert.equal(f.calls.finishes, 0);
  assert.deepEqual(f.chat.shown, ['What time is it?']);
  // the intent run starts: the turn's transcript is reported for it
  f.emit('run-start', {});
  assert.equal(f.pipeline.currentSttText, 'What time is it?');
  assert.equal(f.pipeline.liveTurn, null);
});

test("Home Assistant's transcript is used when the live one fails", async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  f.emit('stt-vad-end', {});
  t.resolveFinal(null);
  await flush();
  assert.equal(f.runs.length, 1, 'waits for HA');
  f.emit('stt-end', { stt_output: { text: 'lights off' } });
  await flush();
  assert.equal(f.runs[1].message.intent_input, 'lights off');
});

test("an early Home Assistant transcript waits for the live one", async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  f.emit('stt-vad-end', {});
  f.emit('stt-end', { stt_output: { text: 'turn of the lights' } });
  await flush();
  assert.equal(f.runs.length, 1);
  t.resolveFinal('Turn off the lights.');
  await flush();
  assert.equal(f.runs[1].message.intent_input, 'Turn off the lights.');
});

test('a turn with no speech from either source ends normally', async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  f.emit('stt-vad-end', {});
  f.emit('stt-end', { stt_output: { text: '' } });
  f.emit('run-end', {});
  assert.equal(f.calls.finishes, 0, 'still waiting for the live transcript');
  t.resolveFinal(null);
  await flush();
  assert.equal(f.runs.length, 1, 'no intent run');
  assert.equal(f.calls.finishes, 1);
  assert.ok(t.closed);
});

test('an HA error before any transcript closes the live session', async () => {
  const f = await fixture();
  const t = await startSttTurn(f);
  f.emit('error', { code: 'stt-stream-failed', message: 'x' });
  assert.ok(t.closed);
  assert.equal(f.pipeline.liveTurn, null);
});

test('ask_question keeps its Home Assistant STT turn', async () => {
  const f = await fixture();
  f.pipeline._askQuestionCallback = noop;
  await f.pipeline.start({ start_stage: 'stt', end_stage: 'stt' });
  assert.equal(FakeTranscriber.instances.length, 0);
});

test('with live transcription off, STT turns are unchanged', async () => {
  const f = await fixture({ live: false });
  await f.pipeline.start({ start_stage: 'stt', end_stage: 'tts' });
  assert.equal(FakeTranscriber.instances.length, 0);
  assert.equal(f.runs[0].message.end_stage, 'tts');
  assert.equal(f.card.audio.liveSink, null);
});
