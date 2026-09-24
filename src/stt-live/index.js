/**
 * Live transcription over an OpenAI Realtime transcription session.
 *
 * The pipeline's STT turn keeps running through Home Assistant (wake dedupe,
 * end-of-speech detection, and its own transcript as a fallback). The same
 * microphone audio is streamed here too, so the user's words can be shown
 * while they speak and a better transcript can be handed to the intent stage.
 *
 * The integration mints a short-lived client secret
 * (`voice_satellite/stt_live_session`), so the browser never holds the API
 * key. Turn detection is off: the caller commits the turn when Home
 * Assistant reports the end of speech.
 *
 * Nothing here may block or break the Home Assistant path: every failure is
 * reported through `onError` and makes `commit()` resolve to null.
 */

const TARGET_RATE = 24000;
/** Send audio in ~100 ms batches. */
const BATCH_SAMPLES = TARGET_RATE / 10;
/** Audio queued while connecting (~10 s); older audio is dropped first. */
const MAX_QUEUED_SAMPLES = TARGET_RATE * 10;

/**
 * Streaming linear resampler from `inRate` to 24 kHz 16-bit PCM. Keeps its
 * position between chunks so chunk boundaries don't click or drift.
 */
export class PcmResampler {
  constructor(inRate) {
    this._step = inRate / TARGET_RATE;
    this._pos = 0; // position of the next output sample, in input samples
    this._prev = 0; // last input sample of the previous chunk (index -1)
  }

  /** @param {Float32Array} input @returns {Int16Array} */
  push(input) {
    const out = [];
    const n = input.length;
    let pos = this._pos;
    while (pos < n - 1 || (pos < n && Number.isInteger(pos))) {
      // floating-point drift can land a hair before the previous sample
      const i = Math.max(-1, Math.floor(pos));
      const frac = Math.max(0, pos - i);
      const a = i < 0 ? this._prev : input[i];
      const b = i + 1 < n ? input[i + 1] : input[i];
      out.push(a + (b - a) * frac);
      pos += this._step;
    }
    this._pos = pos - n;
    if (n) this._prev = input[n - 1];
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) {
      const s = Math.max(-1, Math.min(1, out[k]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }
}

function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class LiveTranscriber {
  /**
   * @param {object} opts
   * @param {object} opts.connection  HA websocket connection (sendMessagePromise)
   * @param {string} opts.entityId    satellite entity
   * @param {string} [opts.model]
   * @param {string} [opts.language]  e.g. the pipeline's stt_language
   * @param {string[]} [opts.keywords]
   * @param {object} [opts.logger]
   * @param {Function} [opts.WebSocketImpl]
   * @param {(text: string) => void} [opts.onPartial]  running transcript of the turn
   * @param {(code: string, message: string) => void} [opts.onError]
   */
  constructor(opts) {
    this._opts = opts;
    this._log = opts.logger || { log() {}, error() {} };
    this._WS = opts.WebSocketImpl || globalThis.WebSocket;
    this._ws = null;
    this._open = false;
    this._closed = false;
    this._failed = false;
    this._resampler = null;
    this._inRate = 0;
    this._queue = []; // Int16Array chunks not yet sent
    this._queued = 0;
    this._pending = []; // resampled samples waiting to fill a batch
    this._pendingCount = 0;
    this._partial = '';
    this._final = null;
    this._commitRequested = false;
    this._finalWaiters = [];
  }

  /** Running transcript of the current turn. */
  get text() { return this._final ?? this._partial; }

  get failed() { return this._failed; }

  /** Mint a session and connect. Resolves once connected (or failed). */
  async start() {
    const { connection, entityId, model, language, keywords } = this._opts;
    let session;
    try {
      session = await connection.sendMessagePromise({
        type: 'voice_satellite/stt_live_session',
        entity_id: entityId,
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
        ...(keywords && keywords.length ? { keywords } : {}),
      });
    } catch (e) {
      this._fail(e?.code || 'session_failed', e?.message || 'Could not start live transcription');
      return;
    }
    if (this._closed) return;
    await new Promise((resolve) => {
      let ws;
      try {
        ws = new this._WS(session.url, ['realtime', `openai-insecure-api-key.${session.client_secret}`]);
      } catch (e) {
        this._fail('connect_failed', e?.message || String(e));
        resolve();
        return;
      }
      this._ws = ws;
      ws.onopen = () => {
        if (this._closed) { ws.close(); resolve(); return; }
        this._open = true;
        this._log.log('stt-live', `Connected (${session.model})`);
        this._flushQueue();
        if (this._commitRequested) this._sendCommit();
        resolve();
      };
      ws.onmessage = (event) => this._onMessage(event.data);
      ws.onerror = () => { this._fail('socket_error', 'Live transcription connection failed'); resolve(); };
      ws.onclose = (event) => {
        const wasOpen = this._open;
        this._open = false;
        if (!this._closed && this._final === null) {
          this._fail('closed', event?.reason || `Connection closed (${event?.code})`);
        }
        if (!wasOpen) resolve();
      };
    });
  }

  /**
   * Feed microphone audio.
   * @param {Float32Array} samples
   * @param {number} sampleRate
   */
  pushAudio(samples, sampleRate) {
    if (this._closed || this._failed || this._commitRequested || !samples?.length) return;
    if (!this._resampler || this._inRate !== sampleRate) {
      this._resampler = new PcmResampler(sampleRate);
      this._inRate = sampleRate;
    }
    const pcm = this._resampler.push(samples);
    if (!pcm.length) return;
    this._pending.push(pcm);
    this._pendingCount += pcm.length;
    if (this._pendingCount >= BATCH_SAMPLES) this._enqueue(this._drainPending());
  }

  /**
   * End the turn and wait for the final transcript.
   * @param {number} timeoutMs
   * @returns {Promise<string|null>} the transcript, or null on failure/timeout
   */
  commit(timeoutMs = 2000) {
    if (this._final !== null) return Promise.resolve(this._final);
    if (this._failed || this._closed) return Promise.resolve(null);
    if (!this._commitRequested) {
      this._commitRequested = true;
      if (this._pendingCount) this._enqueue(this._drainPending());
      if (this._open) this._sendCommit();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._finalWaiters = this._finalWaiters.filter((w) => w !== waiter);
        this._log.log('stt-live', `No final transcript within ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);
      const waiter = (text) => { clearTimeout(timer); resolve(text); };
      this._finalWaiters.push(waiter);
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._resolveFinal(this._final);
    try { this._ws?.close(); } catch (_) { /* already closing */ }
    this._ws = null;
    this._queue = [];
    this._pending = [];
  }

  _drainPending() {
    const out = new Int16Array(this._pendingCount);
    let offset = 0;
    for (const chunk of this._pending) { out.set(chunk, offset); offset += chunk.length; }
    this._pending = [];
    this._pendingCount = 0;
    return out;
  }

  _enqueue(pcm) {
    if (this._open) { this._send(pcm); return; }
    this._queue.push(pcm);
    this._queued += pcm.length;
    while (this._queued > MAX_QUEUED_SAMPLES && this._queue.length > 1) {
      this._queued -= this._queue.shift().length;
    }
  }

  _flushQueue() {
    for (const pcm of this._queue) this._send(pcm);
    this._queue = [];
    this._queued = 0;
  }

  _send(pcm) {
    try {
      this._ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(pcm) }));
    } catch (e) {
      this._fail('send_failed', e?.message || String(e));
    }
  }

  _sendCommit() {
    try {
      this._ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch (e) {
      this._fail('send_failed', e?.message || String(e));
    }
  }

  _onMessage(data) {
    let event;
    try { event = JSON.parse(data); } catch (_) { return; }
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (this._final !== null || !event.delta) return;
        this._partial += event.delta;
        this._opts.onPartial?.(this._partial);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this._final = (event.transcript || '').trim();
        this._opts.onPartial?.(this._final);
        this._resolveFinal(this._final);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this._fail(event.error?.code || 'transcription_failed', event.error?.message || 'Transcription failed');
        break;
      case 'error':
        this._fail(event.error?.code || 'error', event.error?.message || 'Live transcription error');
        break;
      default:
        break;
    }
  }

  _fail(code, message) {
    if (this._failed || this._closed) return;
    this._failed = true;
    this._log.error('stt-live', `${code}: ${message}`);
    this._opts.onError?.(code, message);
    this._resolveFinal(null);
    try { this._ws?.close(); } catch (_) { /* already closing */ }
  }

  _resolveFinal(text) {
    const waiters = this._finalWaiters;
    this._finalWaiters = [];
    for (const waiter of waiters) waiter(text);
  }
}
