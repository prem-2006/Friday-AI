"""The app (TypeScript) and the calling service (Python) speak the same voices."""

from __future__ import annotations

import re

from friday_services.config import REPO_ROOT
from friday_services.voices import DEFAULT_LANGUAGE, LANGUAGES


def test_voice_lists_match():
    source = (REPO_ROOT / "src" / "friday" / "shared" / "voices.ts").read_text(encoding="utf-8")
    typescript = {
        code: (name, voice)
        for code, name, voice in re.findall(
            r"\{ code: '([^']+)', name: '([^']+)', voice: '([^']+)' \}", source
        )
    }
    python = {code: (voice.name, voice.voice) for code, voice in LANGUAGES.items()}
    assert typescript == python
    assert f"FRIDAY_DEFAULT_LANGUAGE = '{DEFAULT_LANGUAGE}'" in source
