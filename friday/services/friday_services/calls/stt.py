"""Gnani streaming STT that sends audio in the frame size Gnani requires, and
can find the caller's language by itself."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from pipecat.frames.frames import Frame
from pipecat.transcriptions.language import Language
from pipecat_gnani import GnaniSTTService

from friday_services.calls.language import AUTO

# Gnani's realtime STT expects every binary frame to be exactly 1,024 bytes
# (512 16-bit samples). The phone line delivers 20 ms packets (320 bytes at 8 kHz), and
# pipecat-gnani forwards whatever it receives, so regroup the audio here.
GNANI_FRAME_BYTES = 1024


class HeardLanguageSTT(GnaniSTTService):
    """Gnani STT that remembers which language it heard last ("mr-IN"): with
    indic-auto it follows the speaker from turn to turn."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        language = getattr(self._settings, "language", None)
        self.heard: str | None = language.value if isinstance(language, Language) else None

    async def _push_transcript(
        self,
        text: str,
        *,
        is_final: bool,
        language: Language | None = None,
        result: Any | None = None,
    ):
        detected = (
            (result or {}).get("detected_language_code") if isinstance(result, dict) else None
        )
        if detected:
            self.heard = str(detected)
            try:
                language = Language(self.heard)
            except ValueError:
                pass
        await super()._push_transcript(text, is_final=is_final, language=language, result=result)


class FramedGnaniSTTService(HeardLanguageSTT):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._pending = bytearray()

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:  # type: ignore[override]
        self._pending.extend(audio)
        while len(self._pending) >= GNANI_FRAME_BYTES:
            frame = bytes(self._pending[:GNANI_FRAME_BYTES])
            del self._pending[:GNANI_FRAME_BYTES]
            async for result in super().run_stt(frame):
                if result is not None:
                    yield result
        yield None


def auto_language_settings(**kwargs: Any) -> Any:
    """Prisma settings that find the language: indic-auto is not one of
    pipecat's Language values, and Gnani takes it as the language code."""
    settings = GnaniSTTService.Settings(**kwargs)
    settings.language = AUTO  # type: ignore[assignment]
    return settings


def use_codemix(stt: Any) -> Any:
    """English words stay in Latin letters inside Hindi ("notepad open करो",
    not "नोटपैड ओपन करो"). Gnani's codemix format; pipecat-gnani checks the
    format when the service is made and does not list it yet, so it is set
    after."""
    stt._settings.format = "codemix"
    return stt
