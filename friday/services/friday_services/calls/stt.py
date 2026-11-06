"""Gnani streaming STT that sends audio in the frame size Gnani requires."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from pipecat.frames.frames import Frame
from pipecat_gnani import GnaniSTTService

# Gnani's realtime STT expects every binary frame to be exactly 1,024 bytes
# (512 16-bit samples). The phone line delivers 20 ms packets (320 bytes at 8 kHz), and
# pipecat-gnani forwards whatever it receives, so regroup the audio here.
GNANI_FRAME_BYTES = 1024


class FramedGnaniSTTService(GnaniSTTService):
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
