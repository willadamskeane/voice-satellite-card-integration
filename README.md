<h1 align="center" style="border-bottom: none">
   <img alt="Voice Satellite for Home Assistant" src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/banner.png" width="650" />
</h1>

<p align="center">
<a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=jxlarrea&repository=voice-satellite-card-integration"><img src="https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge" alt="hacs_badge"></a>
<img src="https://img.shields.io/github/stars/jxlarrea/voice-satellite-card-integration?style=for-the-badge&label=Stars&color=yellow" alt="Stars">
<a href="https://github.com/jxlarrea/voice-satellite-card-integration/releases"><img src="https://img.shields.io/github/downloads/jxlarrea/voice-satellite-card-integration/total?style=for-the-badge&label=Downloads&color=blue" alt="Downloads"></a>
<a href="https://github.com/jxlarrea/voice-satellite-card-integration/releases"><img src="https://shields.io/github/v/release/jxlarrea/voice-satellite-card-integration?style=for-the-badge&color=purple" alt="version"></a>
<a href="https://github.com/jxlarrea/voice-satellite-card-integration/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/jxlarrea/voice-satellite-card-integration/release.yml?style=for-the-badge&label=Build" alt="Build"></a>
</p>

<p align="center">
<a href="https://buymeacoffee.com/jxlarrea"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
</p>

## About this fork

This is [Will Adams-Keane](https://github.com/willadamskeane)'s fork of [jxlarrea/voice-satellite-card-integration](https://github.com/jxlarrea/voice-satellite-card-integration). It runs on a Lenovo ThinkSmart View wall tablet (Kiosk Satellite app, far-field mic) with an OpenAI conversation agent. There, Home Assistant Cloud speech-to-text was slow and often wrong, nothing showed what the tablet had heard until the user finished speaking, and every false wake left a "Voice Satellite error" toast on screen until someone tapped it.

**`main` carries the fork**, merged with upstream releases as they come out. Versions are upstream's with a suffix (`2026.9.13-live.1` is based on upstream 2026.9.13). To install it with HACS, add `https://github.com/willadamskeane/voice-satellite-card-integration` as a custom repository (type Integration) instead of the default Voice Satellite entry, so HACS offers this fork's releases rather than upstream's.

### What's different

**Live transcription with OpenAI** (opt-in: `stt_live_transcription`, `stt_live_model`)

- Words appear on screen as the user speaks, updating one chat bubble in place, and the finished transcript goes to the assistant faster.
- It's a hybrid design. The turn still runs through Home Assistant's pipeline from the STT stage, which keeps cross-device wake dedupe, HA's end-of-speech detection, and HA's transcript as a fallback. The same audio is also streamed to an OpenAI Realtime transcription session (`gpt-live-transcribe` by default). When HA reports the end of speech, the live session is committed, and the first usable transcript (live, else HA's) starts a text run at the intent stage. The run keeps the turn's conversation id, extra prompt and pipeline slot.
- The OpenAI key never reaches the browser. The new `voice_satellite/stt_live_session` command mints a short-lived client secret for a transcription-only session, using the API key of the OpenAI Conversation integration.
- Each session carries up to 100 keywords built from the home's area names and the Assist-exposed device names, so room and device names are spelled right.
- Measured on the kiosk and against the API: words appear 0.2–0.4 s behind speech, and the final text arrives 0.4–0.6 s after the end of speech. OpenAI bills it at $0.017 per minute of audio. The model must be allowed in your OpenAI project, which otherwise returns `model_not_found`.
- With this on, Kiosk Satellite streams audio into the page instead of uploading it natively, because the page needs the audio. `ask_question` turns keep HA's own speech-to-text.

**No error toast for a false wake**

- After a false wake with no speech, HA Cloud ends the turn with `stt-stream-failed` instead of `stt-no-text-recognized`, and the card reported it as an error. The card now tracks whether speech was detected (`stt-vad-start`) in the run and treats that failure as "nobody spoke" when it wasn't. A failure after real speech still shows the toast. This fix is also at [willadamskeane/voice-satellite-card-integration#1](https://github.com/willadamskeane/voice-satellite-card-integration/pull/1).

**Error toasts can time out** (`error_toast_timeout_s`)

- Error toasts stay until dismissed, as upstream intends, unless you set a timeout in seconds. That suits an unattended wall tablet.

**Pipeline 2 stays on Pipeline 2**

- Text runs started by the card (live transcription, `voice_satellite.show`) now honor `wake_word_slot`, so a turn woken on the second wake word keeps its pipeline.

### Installing this fork

The built frontend isn't committed and the fork publishes no releases, so HACS would install upstream code. To install:

```sh
git clone -b feat/live-transcription https://github.com/willadamskeane/voice-satellite-card-integration.git
cd voice-satellite-card-integration
npm ci && npm run build
# copy custom_components/voice_satellite into your Home Assistant config's custom_components/, then restart
```

Don't accept HACS updates for Voice Satellite afterwards: they replace the fork with upstream. Everything below is the upstream README.


Turn any tablet, phone, or browser into a hands-free voice assistant for [Home Assistant](https://www.home-assistant.io) - like Alexa, Siri, or Google Home, but fully private and running on your own hardware. Just say the wake word and go: ask questions, control devices, set timers, get announcements, and see rich visual results - all without touching the screen.

Voice Satellite works as a drop-in integration that transforms any web browser into a full [Assist satellite](https://www.home-assistant.io/voice-pe/) with wake word detection, media playback, and visual feedback.

### Demo Video (**Make sure your volume is up**)

https://github.com/user-attachments/assets/af3956a8-3f58-420a-85ef-872ab9e33e8f

## How It Works

Voice Satellite runs as a **global engine** that loads on every page of Home Assistant - no dashboard card required. Once you assign a satellite entity in the sidebar panel, the engine starts automatically and listens for wake words across all page navigations.

- **Turns your browser into a real satellite** - registered as a proper `assist_satellite` device in HA with full feature parity with physical voice assistants
- **On-device wake word detection** - three engines, all running in the browser: **vsWakeWord** (WebGPU, purpose-built for wall-mounted tablets, best recall and zero false positives in our benchmarks, interpretable per-trigger phoneme logs), **microWakeWord** (pure-JS CPU, works on every device, lowest per-chunk latency), and **openWakeWord** (WebGPU-accelerated, broad pre-trained keyword library, near-free multi-keyword scaling). Custom model support and optional voice-activated stop interruption on all three. Falls back to server-side detection when preferred
- **Dual wake words / dual pipelines** - load two wake words simultaneously (e.g. "Okay Nabu" and "Hey Jarvis") and route each to its own Assist pipeline, so a household can mix languages, mix a local-only pipeline with a cloud/LLM one, or give each character its own conversation agent and voice
- **Timers, announcements, conversations** - voice-activated timers with countdown pills, `assist_satellite.announce` / `start_conversation` / `ask_question` from automations
- **Media player entity** - exposed as a TV-class device. Plays audio, local video files, and HLS / MJPEG camera streams full-screen on the satellite, with volume control, `tts.speak` targeting, `media_player.play_media` from automations, and Media Browser support. TTS can route to browser or a remote speaker
- **Skins** - 10 built-in skins (Default, Alexa, Google Home, Home Assistant, Ink Blobs, Kiosk Satellite, Lens Flares, Retro Terminal, Siri, Waveform) with CSS overrides. Reactive audio-level animation on the activity bar
- **Screensaver** - black overlay, image/video/folder from the HA media library, or live camera feed. Cross-fades between folder items; integrates with kiosk app backlight dimming and motion-dismiss (Kiosk Satellite, Fully Kiosk)
- **Mini card** - optional `voice-satellite-mini-card` for in-dashboard text display without the fullscreen overlay
- **LLM tools** *(experimental)* - image/video/web/Wikipedia search, weather, stocks/crypto with visual panels. Requires [Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)
- **Works on any device** - tablets, phones, computers, kiosks
- **Kiosk Satellite companion app** - on Android, the free official [Kiosk Satellite](https://kiosksatellite.com) app runs wake word detection natively: it keeps listening with the screen off or another app in front, starts on boot, and assigns the satellite entity automatically during its setup wizard

## Screenshots

<p align="center">
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/locks.jpg" alt="Assist" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/videos.jpg" alt="Video Search" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/weather.jpg" alt="Weather" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/currency-waveform.jpg" alt="Stocks" width="49%"/>
</p>

## Wall Tablet? Meet Kiosk Satellite

On an Android tablet the best way to run Voice Satellite is [Kiosk Satellite](https://kiosksatellite.com), the free official companion kiosk app, built specifically for Home Assistant. Voice Satellite detects it is running inside Kiosk Satellite and hands wake word detection over to the app's native engine automatically. You keep configuring everything in Voice Satellite as usual; the app's setup wizard even assigns the satellite entity for you.

Native detection removes the limits a browser puts on a wall tablet:

| Capability | Voice Satellite in a browser | Inside Kiosk Satellite |
| --- | --- | --- |
| Wake word with the dashboard on screen | ✅ | ✅ |
| Wake word with the screen off | ❌ | ✅ |
| Wake word with another app in front | ❌ | ✅ Returns to the dashboard on trigger |
| Mic acces in non-HTTPS HA instances | ❌ | ✅ |
| Detection cost | ⚠️ Browser based, heavy on tablets | ✅ Native CPU inference, 10x-30x faster |
| Wake word on low-end hardware | ⚠️ Struggles | ✅ CPU only, no GPU needed |
| Survives reboots | ⚠️ Manual relaunch | ✅ Start on boot |

On top of the voice side, Kiosk Satellite is a complete Home Assistant kiosk: lockdown with an exit gesture and PIN, screensavers, scheduled light/dark themes, and a full remote web admin. Grab the APK from its [download page](https://kiosksatellite.com/download).

Not on Android, or already invested in another kiosk app? [Fully Kiosk Browser](https://play.google.com/store/apps/details?id=de.ozerov.fully) (Android) and [Kiosker Pro](https://kiosker.io) (iOS) remain fully supported, including screensaver backlight dimming and (Fully Kiosk) motion-dismiss.

## Prerequisites

- **Home Assistant 2025.6.1** or later

- An [Assist Pipeline](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/) with:
  - Speech-to-Text ([Whisper](https://www.home-assistant.io/integrations/whisper/), OpenAI, etc.)
  - Conversation agent ([Home Assistant](https://www.home-assistant.io/integrations/conversation/), OpenAI, Qwen, etc.)
  - Text-to-Speech ([Piper](https://www.home-assistant.io/integrations/piper/), Kokoro, etc.)

Voice Satellite requires microphone access, so make sure that:

1. **The browser has microphone permissions granted** - you will be prompted on first use.
2. **The page is served over HTTPS** - required for microphone access in modern browsers. (Inside [Kiosk Satellite](https://kiosksatellite.com) this requirement disappears: its built-in secure context proxy makes the microphone work even on an http-only instance.)
3. **The screen stays on** - if the device screen turns off completely, the microphone will stop working. Use a screensaver instead of screen-off to keep the mic active. (Inside [Kiosk Satellite](https://kiosksatellite.com) this limit disappears: detection is native and keeps running with the screen off.)

On Android, the recommended kiosk app is [Kiosk Satellite](https://kiosksatellite.com): microphone access and audio autoplay are handled by the app out of the box, and wake word detection runs natively. For other kiosk setups like [Fully Kiosk Browser](https://play.google.com/store/apps/details?id=de.ozerov.fully) (Android) or [Kiosker Pro](https://kiosker.io) (iOS), make sure to enable microphone permissions and use the screensaver feature (not screen off) to keep the microphone active while dimming the display.

For the **Home Assistant Companion App** on **Android**, enable **Autoplay videos** in Settings -> Companion App -> Other settings. On **iOS**, go to Settings -> Companion App -> Debugging -> **WKWebView Media Playback** and make sure both **Audio** and **Video** are **unchecked**. Without these settings, the WebView will block TTS audio playback.

## Installation

### HACS (Recommended)

Voice Satellite is available in [HACS](https://hacs.xyz/). Use the link below to open the HACS repository in Home Assistant.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=jxlarrea&repository=voice-satellite-card-integration)

Or search for `Voice Satellite` in the HACS default repository.

### Manual

1. Download the [latest release ZIP file](https://github.com/jxlarrea/voice-satellite-card-integration/releases/latest)
2. Copy the `custom_components/voice_satellite` folder to your `config/custom_components/` directory
3. Restart Home Assistant

## Setup

1. Go to **Settings -> Devices & Services -> Add Integration**
2. Search for **Voice Satellite**
3. Enter a name for the device (e.g., "Kitchen Tablet")
4. Repeat for each browser/tablet that will act as a satellite
5. On each browser/tablet, open the **Voice Satellite** sidebar panel
6. Select the satellite entity you created for this device
7. Configure wake word, audio, and appearance settings as needed
8. The engine starts automatically once an entity is assigned - if the browser blocks auto-start due to a missing user gesture, a floating microphone button will appear; tap it to start

## Configuration

The **Voice Satellite** sidebar panel is the central configuration hub. Pick the satellite entity for this browser, tune microphone processing, choose a skin, and set up the screensaver - all stored per-browser in local storage. The optional [Mini Card](docs/configuration.md#mini-card) provides an inline, text-first dashboard variant when you don't want the fullscreen overlay.

<p align="center">
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/sidepanel.png" alt="Sidebar Panel" width="650"/>
</p>

See the [Configuration reference](docs/configuration.md) for every setting in the sidebar panel and mini card.

## Integration

Each satellite is a real `assist_satellite` device in Home Assistant, with a companion `media_player`, per-device configuration entities (pipeline, wake word, TTS output, mute, etc.), and live state sync (`idle` / `listening` / `processing` / `responding`). After every turn the integration fires a `voice_satellite_chat` event carrying the user's transcript, the assistant's full reply, and the tools the LLM invoked, ready to drive automations. Timers fire a `voice_satellite_timer` event too, so a timer set in the kitchen can notify your phone or announce itself on another satellite.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/integration.png" alt="Integration" width="650"/>
</p>

See the [Integration reference](docs/integration.md) for device entities, state values, attribute list, and event payload.

## Usage & Services

Once running, the satellite listens for the wake word, streams audio to STT, plays the TTS response, and supports natural multi-turn follow-ups with agents that allow it. It also exposes actions your automations can call: `assist_satellite.announce` for proactive TTS, `start_conversation` to ask a question and listen, `ask_question` to match the user's spoken reply against predefined answers, `voice_satellite.wake` to trigger the satellite as if the wake word had fired, and `voice_satellite.show` to run a prompt through the Assist pipeline on a schedule and pin the response (with any tool-call rich media) on screen until dismissed.

See the [Usage & Services reference](docs/usage.md) for the full interaction flow and YAML examples for every action.

## Wake Word Detection

Three on-device engines are available, all running in pure JavaScript so audio is only streamed to Home Assistant after the wake word fires - no server-side wake word add-on required.

- **vsWakeWord** - phoneme decoder + per-keyword phoneme matcher, dispatched as WebGPU compute shaders. Models are **trained specifically for wall-mounted tablets**: off-axis far-field capture with realistic household background noise, which is Voice Satellite's primary deployment target. In cross-engine benchmarks on `ok_nabu` it hits 100% recall with 0% false positives, the only engine to clear both bars. Every trigger logs the decoded phonemes that fired it, so false-positive debugging is concrete instead of guesswork. **Requires WebGPU.**
- **[microWakeWord](https://github.com/kahrendt/microWakeWord)** - streaming TFLite models on CPU. Runs on every device, including older tablets and phones. Tiny models keep per-chunk latency the lowest of the three. Ships with the wake-word collection tuned by the microWakeWord / ESPHome community.
- **[openWakeWord](https://github.com/dscripka/openWakeWord)** - shared mel + embedding feeding small per-keyword classifiers, with the mel and embedding stages dispatched as WebGPU compute shaders. Ships with classifiers byte-identical to the official HA OWW addon, including the broadest pre-trained keyword library of the three engines. Adding a second wake word costs almost nothing because mel + embedding are computed once per chunk. **Requires WebGPU.**

microWakeWord is the default for fresh installs because it works on every device. On devices that support WebGPU, **vsWakeWord is the recommended engine for wall-mounted tablets** - the models were designed for exactly that scenario. Pick openWakeWord when you need a keyword that vsWakeWord doesn't ship yet, or when you want the official HA OWW addon's behavior. All three engines run well under the real-time budget. Up to two wake words can run in parallel on any engine, each routed to its own Assist pipeline. "Disabled" mode keeps the mic completely off for automation-driven setups.

Inside [Kiosk Satellite](https://github.com/jxlarrea/kiosk-satellite), Voice Satellite hands detection over to the app's native engine automatically - same engine choice, same models, nothing to reconfigure - and detection keeps running with the screen off or the app in the background, at a fraction of the browser's CPU cost.

See the [Wake Word reference](docs/wake-word.md) for the full engine comparison, built-in models, custom model loading, dual wake words / pipelines, and disabled mode.

## Skins & Customization

Ten built-in skins (Default, Alexa, Google Home, Home Assistant, Ink Blobs, Kiosk Satellite, Lens Flares, Retro Terminal, Siri, Waveform) theme the overlay, timer pills, and activity bar. Every skin can be further tweaked via the **Custom CSS** field in the sidebar panel, and the Waveform, Ink Blobs, and Lens Flares skins expose dedicated CSS variables for color control. Built-in chime sounds (`wake`, `done`, `error`, `alert`, `announce`) can be replaced with your own MP3s that survive HACS updates.

<img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/lensflare.png" alt="Lens Flare Skins" width="100%"/>

<img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/skins.jpg" alt="Skins" width="100%"/>

See the [Skins & Customization reference](docs/customization.md) for the skin list, CSS variable tables, and the custom sounds folder layout.

## Timers

Voice timers ("Set a 5 minute timer", "Cancel the pizza timer") work out of the box, with countdown pills on the overlay and an alert chime on completion. Timers can also be started from automations via the `voice_satellite.start_timer` action. The side panel can hide the on-screen pill or alert label, and can optionally speak a configurable alert phrase after every two chimes, with only a short pause before the next chime pair.

See the [Timers reference](docs/timers.md) for voice sentences, the action schema, automation examples, side-panel toggles, and entity attributes.

## Experimental: LLM Tools

With a tool-capable conversation agent (OpenAI, Google Generative AI, Anthropic, Ollama, etc.) plus the companion [Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools) integration, Voice Satellite can display rich visual results inline: image grids, YouTube video cards, weather forecasts, stock/crypto cards, currency conversions, and web/Wikipedia summaries with featured images.

See the [LLM Tools reference](docs/llm-tools.md) for each supported tool and the voice commands that trigger them.

## Troubleshooting

Most setup issues come from missing microphone permissions, mixed HTTP/HTTPS content, kiosk app autoplay settings, or a mismatched `internal_url` that breaks the TTS proxy for announcements.

The sidebar panel ships with a **Diagnostics & troubleshooting** section that runs automated client-side and server-side checks (secure context, microphone permission, pipeline configuration, mixed-content TTS, wake word mode, Lovelace resource registration, and more). A **Copy report** button produces a paste-ready markdown block with the full results, ready to attach to a GitHub issue.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/diagnostics.png" alt="Integration" width="650"/>
</p>

See the [Troubleshooting reference](docs/troubleshooting.md) for the most common issues and their fixes.

## Contributing

Contributions are welcome. Please feel free to submit issues. Pull requests are currently not being accepted.

## License

This project is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) - see [LICENSE](LICENSE) for details.
