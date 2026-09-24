/**
 * Kiosk Satellite delegated pipeline transport.
 *
 * Presents the same shape as subscribePipelineRun (an async subscribe that
 * resolves to an unsubscribe function, delivering every subscription event
 * to one callback), but the actual run lives on the app's own Home
 * Assistant websocket and the STT audio upload happens natively. The
 * synthetic init event arrives through the same forwarded stream, so
 * PipelineManager's init/handler-ID bookkeeping runs unchanged.
 */

import * as kiosk from '../kiosk/index.js';

/**
 * Whether a delegated run should even be attempted: the app detected the
 * wake word natively (so it owns the mic the run needs), it exposes the
 * pipeline API, and delegation has not been latched off after a mid-flight
 * failure this page load.
 *
 * The latch exists for the one genuinely broken shape: the delegated mic
 * came up but the run subscription failed (HA unreachable from the app
 * while reachable from the page). Retrying delegation every turn would
 * fail every turn; the page-load latch keeps the fallback sticky and a
 * reload retries.
 *
 * @param {object} card - Card/session instance
 */
export function nativePipelinePreferred(card) {
  // Live transcription needs the audio in the page, so the app may stream
  // it here but not upload it natively.
  return card.config?.stt_live_transcription !== true
    && card._nativeWakeActive === true
    && !card._ksPipelineBroken
    && kiosk.supportsNativePipeline();
}

/**
 * Subscribe a pipeline run through the app.
 *
 * @param {object} card - Card instance (logger access)
 * @param {string} entityId - Satellite entity ID
 * @param {object} runConfig - Same payload subscribePipelineRun sends
 * @param {(message: object) => void} onMessage - Event callback (verbatim
 *   subscription events, the synthetic init included)
 * @param {() => void} onClosed - The app's websocket died mid-run; the
 *   subscription is gone and the caller should restart the turn, exactly
 *   like the dashboard-socket reconnect handler does
 * @returns {Promise<Function|null>} Unsubscribe function, or null when the
 *   app declined (setting off, HA unreachable, older app) - the caller
 *   falls back to the dashboard connection
 */
export async function subscribeKioskPipelineRun(card, entityId, runConfig, onMessage, onClosed) {
  const res = await kiosk.pipelineRun({ entity_id: entityId, ...runConfig });
  if (!res) return null;
  const { runId } = res;

  const offEvents = kiosk.onPipelineEvent((detail) => {
    if (detail.runId !== runId) return;
    onMessage(detail.message || {});
  });
  const offClosed = kiosk.onPipelineClosed((detail) => {
    if (detail.runId !== runId) return;
    card.logger.log('pipeline', `Kiosk transport closed mid-run (${detail.reason || 'unknown'})`);
    if (onClosed) onClosed();
  });

  let done = false;
  return async () => {
    if (done) return;
    done = true;
    offEvents();
    offClosed();
    await kiosk.pipelineStop(runId);
  };
}
