"""Short-lived OpenAI transcription credentials for live transcription.

The card streams the user's speech to an OpenAI Realtime transcription session
so it can show the words while they are spoken. The browser must never hold
the real API key, so the integration mints an ephemeral client secret
(`POST /v1/realtime/client_secrets`) scoped to a transcription-only session and
hands only that to the card. The key is taken from the OpenAI Conversation
integration, so no second copy of it is stored.
"""

from __future__ import annotations

import re
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


# Entities people name when talking to the assistant. Sensors are left out:
# their names are mostly device serials and measurement suffixes.
KEYWORD_DOMAINS = (
    "light", "switch", "fan", "cover", "lock", "climate", "media_player",
    "scene", "script", "vacuum", "input_boolean", "humidifier", "valve",
)
MAX_KEYWORDS = 100
# apostrophes stay: "Will's Study" is exactly the kind of name that needs help
_NOT_SPOKEN = re.compile(r"[\[\]{}()\":;/\\|<>_=@#]")
_ORDINAL = re.compile(r"^\d+(st|nd|rd|th)$", re.IGNORECASE)


def _looks_like_serial(word: str) -> bool:
    """Model numbers and serials ("A19", "1A1W", "3RSP019BZ", "7100")."""
    digits = sum(ch.isdigit() for ch in word)
    letters = sum(ch.isalpha() for ch in word)
    if _ORDINAL.match(word):
        return False
    return digits >= 3 or (digits >= 2 and letters >= 1) or (digits and letters and len(word) >= 4)


def clean_keyword(name: str | None) -> str | None:
    """A name as someone would say it, or None if it isn't one."""
    if not name:
        return None
    name = " ".join(name.split())
    if not 2 < len(name) <= 40 or len(name.split()) > 5:
        return None
    if _NOT_SPOKEN.search(name) or any(_looks_like_serial(w.strip(",.-")) for w in name.split()):
        return None
    return name


def build_keywords(
    areas: list[str],
    aliases: list[str],
    entity_names: list[str],
    limit: int = MAX_KEYWORDS,
) -> list[str]:
    """Vocabulary hints for transcription: areas, then aliases, then entity
    names (shortest first), cleaned and de-duplicated case-insensitively."""
    seen: set[str] = set()
    keywords: list[str] = []
    for group in (areas, aliases, sorted(entity_names, key=lambda n: (len(n), n))):
        for raw in group:
            name = clean_keyword(raw)
            if name and name.lower() not in seen:
                seen.add(name.lower())
                keywords.append(name)
                if len(keywords) >= limit:
                    return keywords
    return keywords


def collect_home_keywords(hass) -> list[str]:
    """Area names and the names of entities exposed to Assist."""
    from homeassistant.components.homeassistant.exposed_entities import async_should_expose
    from homeassistant.helpers import area_registry as ar, entity_registry as er

    areas: list[str] = []
    aliases: list[str] = []
    for area in ar.async_get(hass).async_list_areas():
        areas.append(area.name)
        aliases.extend(area.aliases or ())
    registry = er.async_get(hass)
    names: list[str] = []
    for state in hass.states.async_all(KEYWORD_DOMAINS):
        if not async_should_expose(hass, "conversation", state.entity_id):
            continue
        entry = registry.async_get(state.entity_id)
        if entry is not None:
            aliases.extend(alias for alias in entry.aliases or () if isinstance(alias, str))
        names.append(state.attributes.get("friendly_name") or "")
    return build_keywords(areas, aliases, names)


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
