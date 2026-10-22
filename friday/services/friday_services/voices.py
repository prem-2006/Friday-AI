"""Languages Friday speaks and the Timbre v2.5 voice for each.

Keep in sync with src/friday/shared/voices.ts (tests/test_voices.py checks it).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Voice:
    code: str
    name: str
    voice: str


LANGUAGES: dict[str, Voice] = {
    voice.code: voice
    for voice in (
        Voice("en-IN", "English (handles Hinglish)", "Kaveri"),
        Voice("hi-IN", "Hindi", "Bhavna"),
        Voice("kn-IN", "Kannada", "Saanvi"),
        Voice("ta-IN", "Tamil", "Trisha"),
        Voice("te-IN", "Telugu", "Lavanya"),
        Voice("ml-IN", "Malayalam", "Reshma"),
        Voice("mr-IN", "Marathi", "Zahira"),
        Voice("bn-IN", "Bengali", "Kirra"),
        Voice("gu-IN", "Gujarati", "Falak"),
        Voice("pa-IN", "Punjabi", "Mehuli"),
    )
}
DEFAULT_LANGUAGE = "en-IN"


def voice_for(code: str) -> Voice:
    if code not in LANGUAGES:
        raise ValueError(f"Unsupported language {code!r}. Use one of: {', '.join(LANGUAGES)}.")
    return LANGUAGES[code]
