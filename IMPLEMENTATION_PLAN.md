# Live transcription with OpenAI (gpt-live-transcribe)

Show the user's words on screen while they speak, and hand the intent stage a
better and faster transcript, without giving up what HA's pipeline already does
well (wake handoff, cross-device wake dedupe, end-of-speech detection).

Design (hybrid):

- The STT turn still runs through `voice_satellite/run_pipeline` from the `stt`
  stage, now with `end_stage: 'stt'`. HA keeps the dedupe (`wake_word_phrase`),
  VAD (`stt-vad-start` / `stt-vad-end`) and produces its own transcript as a
  fallback.
- The same PCM is also streamed to an OpenAI transcription session
  (`gpt-live-transcribe`, no server VAD, far-field noise reduction) over a
  browser WebSocket authenticated with an ephemeral client secret minted by the
  integration. Deltas update a live user chat bubble.
- On `stt-vad-end` the card commits the OpenAI buffer. The first usable final
  transcript (OpenAI `completed`, else HA `stt-end`) starts a text run from the
  `intent` stage with the same conversation id, pipeline slot and extra prompt.
- Off by default (`stt_live_transcription: false`), so behaviour is unchanged
  unless enabled.

## Stage 1: Feasibility spike
**Goal**: Confirm the undocumented parts of the API before building on them.
**Success Criteria**: A browser WebSocket authenticated with an ephemeral key
receives `delta` events while audio streams and a `completed` event after
`input_audio_buffer.commit`; commit-to-completed latency measured.
**Tests**: Scripted spike (not shipped): mint key server-side, stream a speech
clip at real-time pace from a browser, record event timings.
**Status**: In Progress. Confirmed (2026-09-23): `POST /v1/realtime/client_secrets`
with `session.type: transcription` mints `ek_…` keys; WebSocket
`wss://api.openai.com/v1/realtime?intent=transcription` with subprotocols
`['realtime', 'openai-insecure-api-key.<ek>']` works; `turn_detection: null` +
manual `input_audio_buffer.commit` works. `gpt-4o-mini-transcribe` streams its
deltas only after the commit (commit→completed 450–640 ms, exact transcript on
a clean clip). The user's OpenAI project blocks `gpt-live-transcribe`,
`gpt-realtime-whisper`, `gpt-4o-transcribe` and `gpt-transcribe`
(`model_not_found`); waiting on the user to allow `gpt-live-transcribe`, then
re-run to confirm deltas arrive during speech.

## Stage 2: Ephemeral key command (Python)
**Goal**: `voice_satellite/stt_live_session` websocket command returns a
short-lived client secret for a satellite entity; the real key never leaves HA.
**Success Criteria**: Works for a non-admin kiosk user; key source is the
OpenAI Conversation config entry (or an explicit key in options); clear errors
when unavailable.
**Tests**: Python unit tests in the style of `tests/test_timer_controls.py`.
**Status**: Complete. `stt_live.py` + `voice_satellite/stt_live_session`; tests in `tests/test_stt_live.py`.

## Stage 3: Live transcription client (JS)
**Goal**: `src/stt-live/` module: connect, buffer audio until open, resample
16 kHz Float32 to 24 kHz PCM16, append, commit, surface delta / completed /
failed, close.
**Success Criteria**: Handles slow connect, failure and teardown without
leaking sockets; never blocks the HA path.
**Tests**: node tests with a fake WebSocket and fake timers.
**Status**: Complete. `src/stt-live/index.js` (`LiveTranscriber`, `PcmResampler`), tests in `tests/stt-live.test.cjs`. Verified end to end against OpenAI with 16 kHz Float32 input at real-time pace (gpt-4o-mini-transcribe, exact transcript, commit→final 534 ms).

## Stage 4: Pipeline integration
**Goal**: With `stt_live_transcription` on, every STT turn (wake, seamless wake,
follow-up, start_conversation, ask_question) uses the hybrid flow; live user
bubble in full and mini cards; transcript choice and intent text run;
server text run honours `wake_word_slot`; Kiosk native pipeline delegation
bypassed in this mode (audio must reach the page).
**Success Criteria**: Existing tests pass; new tests cover transcript choice,
fallback to HA text, and no-speech runs.
**Tests**: node tests on PipelineManager / session events; Python test for the
text run slot.
**Status**: Not Started

## Stage 5: Deploy and tune on the kiosk
**Goal**: Install the fork on HA, enable the mode on the ThinkSmart View,
measure end-of-speech-to-response latency and accuracy against the current
setup, tune VAD / prompt keywords.
**Success Criteria**: Words appear while speaking; faster than HA Cloud STT.
**Tests**: Pipeline debug timings before/after; real spoken commands.
**Status**: Not Started
