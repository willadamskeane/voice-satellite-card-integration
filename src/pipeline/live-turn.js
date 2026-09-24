/**
 * Live transcription turns (`stt_live_transcription`).
 *
 * The STT run still goes to Home Assistant from the `stt` stage, which keeps
 * the cross-device wake dedupe, HA's end-of-speech detection and HA's own
 * transcript as a fallback, but it now ends after STT. The same audio is
 * streamed to an OpenAI transcription session (src/stt-live) whose partial
 * text is shown while the user speaks. When HA reports the end of speech the
 * live turn is committed, and the first usable transcript (live, else HA's)
 * starts a text run from the `intent` stage with the turn's conversation id,
 * pipeline slot and extra prompt. Starting that run replaces the STT run.
 *
 * A handed-off turn stays registered until the intent run's run-start: the
 * old STT subscription can still deliver stt-end / run-end / error while the
 * new run is being set up, and those must not end the interaction.
 */

import { LiveTranscriber } from '../stt-live/index.js';

/** How long to wait for the live transcript after the end of speech. */
export const LIVE_FINAL_TIMEOUT_MS = 1500;

/** @param {object} card */
export function liveTranscriptionEnabled(card) {
  return card.config?.stt_live_transcription === true;
}

/**
 * Turn an STT-stage audio run into a live turn. Mutates `runConfig` so the
 * HA run ends after STT, and remembers how the turn should continue.
 * @param {import('./index.js').PipelineManager} mgr
 * @param {object} runConfig
 * @param {object} [deps]  test seam for the transcriber class
 */
export function beginLiveTurn(mgr, runConfig, deps = {}) {
  endLiveTurn(mgr);
  const card = mgr.card;
  const turn = {
    continuation: {
      end_stage: runConfig.end_stage,
      conversation_id: runConfig.conversation_id,
      extra_system_prompt: runConfig.extra_system_prompt,
      wake_word_slot: runConfig.wake_word_slot,
      pipeline_id: runConfig.pipeline_id,
    },
    handedOff: false,
    liveFinal: undefined, // undefined: pending, null: unavailable, string: final
    haText: null,
    commit: null,
  };
  runConfig.end_stage = 'stt';

  const Transcriber = deps.Transcriber || LiveTranscriber;
  turn.transcriber = new Transcriber({
    connection: card.connection,
    entityId: card.config.satellite_entity,
    model: card.config.stt_live_model || undefined,
    language: card.hass?.language,
    logger: mgr.log,
    onPartial: (text) => {
      if (mgr.liveTurn === turn && !turn.handedOff) card.chat.showLiveTranscription(text);
    },
    onError: (code) => {
      mgr.log.log('stt-live', `Live transcription unavailable (${code}) - using Home Assistant's transcript`);
    },
  });
  mgr.liveTurn = turn;
  card.audio.liveSink = (samples, rate) => turn.transcriber.pushAudio(samples, rate);
  turn.transcriber.start();
  mgr.log.log('stt-live', 'Live transcription turn started');
  return turn;
}

/**
 * HA heard the end of speech: end the live turn and hand off as soon as its
 * transcript arrives.
 * @param {import('./index.js').PipelineManager} mgr
 */
export function handleLiveVadEnd(mgr) {
  const turn = mgr.liveTurn;
  if (!turn || turn.commit) return;
  mgr.card.audio.liveSink = null;
  turn.commit = turn.transcriber.commit(LIVE_FINAL_TIMEOUT_MS).then((text) => {
    turn.liveFinal = text || null;
    if (turn.liveFinal) handOff(mgr, turn, turn.liveFinal);
    else if (turn.haText) handOff(mgr, turn, turn.haText);
    else if (turn.haDone) finishWithoutSpeech(mgr, turn);
  });
}

/**
 * HA's transcript arrived. Used only if the live one is unavailable.
 * @param {import('./index.js').PipelineManager} mgr
 * @returns {boolean} true if the live turn took over this stt-end
 */
export function handleLiveSttEnd(mgr, text) {
  const turn = mgr.liveTurn;
  if (!turn) return false;
  if (turn.handedOff) return true; // the STT run's late transcript
  turn.haText = text || null;
  turn.haDone = true;
  // No end-of-speech event came through: commit now.
  if (!turn.commit) handleLiveVadEnd(mgr);
  if (turn.liveFinal === null) {
    if (turn.haText) handOff(mgr, turn, turn.haText);
    else finishWithoutSpeech(mgr, turn);
  }
  return true;
}

/**
 * Home Assistant's STT failed with a "nothing recognized" error during a live
 * turn. The live session decides: its words are handed to the intent stage as
 * usual; if it heard nothing either, the turn was noise (typically a false
 * wake in a room with music or a TV) and must end without an error toast.
 * @param {import('./index.js').PipelineManager} mgr
 * @returns {Promise<'handed-off'|'no-speech'|null>} null when no live turn applies
 */
export async function handleLiveSttFailure(mgr) {
  const turn = mgr.liveTurn;
  if (!turn || turn.handedOff || turn.finished) return null;
  if (!turn.commit) handleLiveVadEnd(mgr); // commits and hands off if words arrive
  await turn.commit;
  return turn.handedOff ? 'handed-off' : 'no-speech';
}

/**
 * Whether the live turn takes over this run-end: after a handoff it belongs
 * to the replaced STT run; before one, the turn is still deciding and ends
 * the interaction itself if nothing was said.
 */
export function liveTurnOwnsRunEnd(mgr) {
  const turn = mgr.liveTurn;
  if (!turn || turn.finished) return false;
  if (!turn.handedOff) turn.runEnded = true;
  return true;
}

/** Errors from the replaced STT run arrive after the handoff: ignore them. */
export function liveTurnSwallowsError(mgr) {
  return !!mgr.liveTurn?.handedOff;
}

/**
 * The intent run started: the handoff is complete.
 * @returns {string|null} the transcript to report for this turn
 */
export function handleLiveRunStart(mgr) {
  const turn = mgr.liveTurn;
  if (!turn?.handedOff) return null;
  mgr.liveTurn = null;
  return turn.text;
}

/** Stop streaming and close the live session. */
export function endLiveTurn(mgr) {
  const turn = mgr.liveTurn;
  if (!turn) return;
  mgr.liveTurn = null;
  if (mgr.card.audio) mgr.card.audio.liveSink = null;
  turn.transcriber.close();
}

function handOff(mgr, turn, text) {
  if (turn.handedOff || mgr.liveTurn !== turn) return;
  turn.handedOff = true;
  turn.text = text;
  const source = text === turn.liveFinal ? 'live' : 'Home Assistant';
  mgr.log.log('stt-live', `Handing "${text}" (${source} transcript) to the intent stage`);
  mgr.currentSttText = text;
  mgr.card.chat.showTranscription(text);
  // HA's STT stage is over: stop feeding it and the live session
  mgr.card.audio.liveSink = null;
  mgr.card.audio.stopSending();
  mgr.card.audio.stopBuffering?.({ clear: true });
  turn.transcriber.close();
  const { continuation } = turn;
  mgr.start({
    start_stage: 'intent',
    end_stage: continuation.end_stage,
    intent_input: text,
    conversation_id: continuation.conversation_id,
    extra_system_prompt: continuation.extra_system_prompt,
    wake_word_slot: continuation.wake_word_slot,
    pipeline_id: continuation.pipeline_id,
  }).catch((e) => {
    mgr.log.error('stt-live', `Intent run failed to start: ${e?.message || e}`);
    if (mgr.liveTurn === turn) mgr.liveTurn = null;
    mgr.restart(mgr.calculateRetryDelay());
  });
}

/** Nothing was said: leave the interaction the way an empty STT turn does. */
function finishWithoutSpeech(mgr, turn) {
  if (turn.finished || mgr.liveTurn !== turn) return;
  turn.finished = true;
  mgr.log.log('stt-live', 'No transcript from either source - ending the turn');
  endLiveTurn(mgr);
  // the STT run already ended while we waited: process that run-end now
  if (turn.runEnded) mgr.handleRunEnd();
}
