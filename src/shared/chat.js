/** Chat rendering state and incremental streaming updates. */

import { PacedScroller } from './paced-scroll.js';
import { stripSentimentTags, stripSentimentTagsStreaming } from './sentiment-tags.js';

const FADE_GROUPS = 4;
const CHARS_PER_GROUP = 2;
const FADE_LEN = FADE_GROUPS * CHARS_PER_GROUP; // 8 chars total

export class ChatManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._streamEl = null;
    this._streamedResponse = '';
    this._thinkingEl = null;
    // The user's words while live transcription is still hearing them.
    this._liveUserEl = null;

    // Reusable fade span pool - grouped spans for efficient DOM updates
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;

    // RAF coalescing - multiple rapid stream chunks produce one DOM write per frame
    this._pendingText = null;
    this._rafId = null;

    // Reading-paced scroll for a response taller than its bubble. Holds its
    // own element reference because intent-end nulls _streamEl while TTS
    // (and the scroll it paces) is still running.
    this._scroller = new PacedScroller(() => this._card.tts?.playbackProgress || null);
  }

  get streamEl() { return this._streamEl; }
  set streamEl(el) { this._streamEl = el; }

  get streamedResponse() { return this._streamedResponse; }
  set streamedResponse(val) { this._streamedResponse = val; }

  /**
   * Per-browser display toggle (panel "Conversation Display" section).
   * Only an explicit `false` hides an element, so configs saved before
   * the toggles existed keep the show-everything behavior.  Hiding only
   * suppresses the on-screen text; streaming state, TTS, and tool
   * execution are unaffected.
   */
  _shows(key) {
    return (this._card.config || {})[key] !== false;
  }

  /**
   * Response text as it should be painted.  With "Hide sentiment tags"
   * on, bracketed TTS directives ("[soft-tone]", "[long pause]") are
   * dropped from the bubble only; streamedResponse and everything sent
   * to TTS keep the original text.
   */
  _displayText(text, streaming = false) {
    if ((this._card.config || {}).chat_hide_sentiment_tags !== true) return text;
    return streaming ? stripSentimentTagsStreaming(text) : stripSentimentTags(text);
  }

  showTranscription(text) {
    // A live transcript already has a bubble: settle it on the final text.
    if (this._liveUserEl) {
      this._card.ui.updateChatText(this._liveUserEl, text);
      this._liveUserEl = null;
      return;
    }
    this.addUser(text);
  }

  /**
   * Show the user's words as live transcription hears them, updating one
   * bubble in place; showTranscription() settles it.
   */
  showLiveTranscription(text) {
    if (!text || !this._shows('chat_show_user_command')) return;
    if (this._liveUserEl) {
      this._card.ui.updateChatText(this._liveUserEl, text);
    } else {
      this._liveUserEl = this._card.ui.addChatMessage(text, 'user') || null;
    }
  }

  showResponse(text) {
    text = this._displayText(text);
    if (this._streamEl) {
      this._card.ui.updateChatText(this._streamEl, text);
    } else {
      this.addAssistant(text);
    }
    // The text is final - hand the scroll its pacing clock (the TTS about
    // to play, or the word-count estimate if none does).
    this._scroller.finalize(text);
    this._card.ui.finalizeTranscriptScroll?.(text);
  }

  updateResponse(text) {
    text = this._displayText(text, true);
    if (!this._streamEl) {
      this.addAssistant(text);
    } else {
      this._scheduleStreaming(text);
    }
  }
  addUser(text) {
    if (!this._shows('chat_show_user_command')) return;
    this._card.ui.addChatMessage(text, 'user');
  }

  addImages(results, autoDisplay, featured) {
    this._card.ui.showImagePanel(results, autoDisplay, featured);
  }

  addVideos(results, autoPlay) {
    this._card.ui.showVideoPanel(results, autoPlay);
  }

  addWeather(weatherData) {
    this._card.ui.showWeatherPanel(weatherData);
  }

  addFinancial(data) {
    this._card.ui.showFinancialPanel(data);
  }

  addLovelaceCard(config, size) {
    this._card.ui.showLovelaceCard(config, size);
  }

  addAssistant(text) {
    // With the response hidden there is no bubble to take the dots'
    // place, so removing them reflows the chat and makes the earlier
    // bubbles jump.  Freeze them in place instead (same 'idle' state
    // tool-call lines use); clear() sweeps them with the rest of the
    // conversation.  _streamEl stays null so the streaming paths
    // (showResponse/updateResponse) fall through here and no-op.
    if (!this._shows('chat_show_assistant_response')) {
      if (this._thinkingEl) {
        this._thinkingEl.classList.add('idle');
        this._thinkingEl = null;
      }
      // No bubble this turn - drop the previous turn's, so the paced
      // scroll doesn't run against a stale element.
      this._scroller.reset();
      return;
    }
    // Remove animated dots if no tool call claimed them.
    // Frozen dots (from tool calls) are safe - showToolCall already nulled _thinkingEl.
    this.removeThinking();
    this._streamEl = this._card.ui.addChatMessage(this._displayText(text), 'assistant');
    this._scroller.begin(this._streamEl);
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
  }

  /** Show an animated thinking indicator in the chat area. */
  showThinking() {
    this.removeThinking();
    // A new turn is starting: dim every frozen indicator line from
    // earlier turns (plain frozen dots and tool-call lines alike) so
    // only the new animated dots look active.
    this._card.ui.dimFrozenThinking?.();
    // Deliberately not gated: the dots show regardless of the display
    // toggles.  With tool usage hidden they simply keep animating
    // through tool calls (showToolCall no-ops instead of freezing
    // them) until the response arrives and removeThinking() clears
    // them.
    this._thinkingEl = this._card.ui.addThinkingIndicator();
  }

  /**
   * Show a tool call as a permanent line in the chat flow.
   * If animated dots are showing, freeze them and append the tool name.
   * Subsequent tool calls get their own line with static dots.
   * @param {string} name - Humanized tool name
   */
  showToolCall(name) {
    if (!this._shows('chat_show_tool_usage')) return;
    if (this._thinkingEl) {
      this._card.ui.freezeThinkingWithText(this._thinkingEl, name);
      this._thinkingEl = null;
    } else {
      this._card.ui.addToolCallMessage(name);
    }
  }

  /** Remove the thinking dots indicator if present. */
  removeThinking() {
    if (this._thinkingEl) {
      this._thinkingEl.remove();
      this._thinkingEl = null;
    }
  }

  clear() {
    this.removeThinking();
    this._card.ui.clearChat();
    this._scroller.reset();
    this._streamEl = null;
    this._liveUserEl = null;
    this._streamedResponse = '';
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._pendingText = null;
    }
  }
  /** Coalesce rapid stream chunks into one DOM write per frame. */
  _scheduleStreaming(text) {
    this._pendingText = text;
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        if (this._pendingText !== null) {
          this._updateStreaming(this._pendingText);
          this._pendingText = null;
        }
      });
    }
  }

  _updateStreaming(text) {
    if (!this._streamEl) return;

    if (text.length <= FADE_LEN) {
      this._card.ui.updateChatText(this._streamEl, text);
      this._autoScroll();
      return;
    }

    // Lazily create the fade DOM structure once, then reuse it
    if (!this._fadeSpans) {
      this._initFadeNodes();
    }

    const solid = text.slice(0, text.length - FADE_LEN);
    const tail = text.slice(text.length - FADE_LEN);

    // Update text nodes in-place - no innerHTML, no DOM creation/destruction
    this._solidNode.textContent = solid;
    for (let g = 0; g < FADE_GROUPS; g++) {
      const start = g * CHARS_PER_GROUP;
      this._fadeSpans[g].textContent = tail.slice(start, start + CHARS_PER_GROUP);
    }

    this._autoScroll();
  }

  /**
   * Advance the reading-paced scroll for the response bubble and, in tall
   * mini mode, its transcript container. While the text is still streaming
   * and no TTS is playing yet this deliberately holds position: speech
   * starts at the top of the response, so chasing the tail would scroll
   * past what is about to be spoken.
   */
  _autoScroll() {
    this._scroller.nudge();
    // Also scroll the transcript container (tall mini mode)
    this._card.ui._scrollTranscriptToEnd?.();
  }

  /** Build the fade DOM structure once: a text node for solid text + grouped fade spans. */
  _initFadeNodes() {
    this._streamEl.textContent = '';
    this._solidNode = document.createTextNode('');
    this._streamEl.appendChild(this._solidNode);

    this._fadeSpans = [];
    for (let g = 0; g < FADE_GROUPS; g++) {
      const span = document.createElement('span');
      span.style.opacity = ((FADE_GROUPS - g) / FADE_GROUPS).toFixed(2);
      this._fadeSpans.push(span);
      this._streamEl.appendChild(span);
    }
  }
}
