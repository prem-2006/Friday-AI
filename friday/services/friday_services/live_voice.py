"""Friday's live voice: a Pipecat pipeline that hears and speaks in real time.

The voice screen connects over WebRTC (audio both ways plus a data channel):

    mic -> AudioGate -> Silero VAD -> Gnani streaming STT -> HeardRelay
        -> Gnani streaming TTS -> speaker -> SpeakingRelay

Friday's thinking stays on the voice screen and the app (the Friday Dot, its
quick actions and the helper Dots): this pipeline sends each final transcript
to the screen and speaks whatever text the screen sends back. While Friday
speaks, the owner talking (hands-free) or holding Caps Lock interrupts it.

Gnani is billed for audio it receives, so the gate passes mic audio only while
Caps Lock is held (plus a second of silence so Gnani closes the turn) or while
hands-free listening is on.

Data channel, screen -> pipeline:
    {"type": "ptt", "down": bool}        Caps Lock held / let go
    {"type": "hands_free", "on": bool}   orb tapped on / off
    {"type": "speak", "text": str}       say this
    {"type": "interrupt"}                stop talking now
Pipeline -> screen:
    {"type": "friday-live", "event": "heard", "text": str}
    {"type": "friday-live", "event": "speech_start"}
    {"type": "friday-live", "event": "speaking", "on": bool}
    {"type": "friday-live", "event": "error", "message": str}
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    ErrorFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

TAIL_SECONDS = 1.0  # silence after Caps Lock is let go, so Gnani ends the turn
TTS_MODEL = "timbre-v2.5"

Send = Callable[[dict[str, Any]], None]


def live_event(event: str, **fields: Any) -> dict[str, Any]:
    return {"type": "friday-live", "event": event, **fields}


class AudioGate(FrameProcessor):
    """Lets mic audio through only while the owner means to talk to Friday."""

    def __init__(self, tail_seconds: float = TAIL_SECONDS, **kwargs):
        super().__init__(**kwargs)
        self.held = False
        self.hands_free = False
        self._tail_seconds = tail_seconds
        self._tail_left = 0.0

    @property
    def open(self) -> bool:
        return self.held or self.hands_free

    def push_to_talk(self, down: bool) -> None:
        if self.held and not down:
            self._tail_left = self._tail_seconds
        self.held = down

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            if self.open:
                await self.push_frame(frame, direction)
            elif self._tail_left > 0:
                seconds = frame.num_frames / frame.sample_rate
                self._tail_left -= seconds
                await self.push_frame(
                    InputAudioRawFrame(
                        audio=bytes(len(frame.audio)),
                        sample_rate=frame.sample_rate,
                        num_channels=frame.num_channels,
                    ),
                    direction,
                )
            return
        await self.push_frame(frame, direction)


class HeardRelay(FrameProcessor):
    """Sends each final transcript to the screen; a voice heard while
    hands-free interrupts Friday at once."""

    def __init__(self, send: Send, gate: AudioGate, **kwargs):
        super().__init__(**kwargs)
        self._send = send
        self._gate = gate

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self._send(live_event("heard", text=frame.text.strip()))
        elif isinstance(frame, VADUserStartedSpeakingFrame) and self._gate.hands_free:
            self._send(live_event("speech_start"))
        elif isinstance(frame, ErrorFrame):
            self._send(live_event("error", message=str(frame.error)[:300]))
        await self.push_frame(frame, direction)


class SpeakingRelay(FrameProcessor):
    """Tells the screen when Friday's voice starts and stops playing."""

    def __init__(self, send: Send, **kwargs):
        super().__init__(**kwargs)
        self._send = send

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._send(live_event("speaking", on=True))
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._send(live_event("speaking", on=False))
        await self.push_frame(frame, direction)


def language_of(code: str):
    from pipecat.transcriptions.language import Language

    try:
        return Language(code)
    except ValueError:
        return Language.EN_IN


class LiveVoiceSession:
    """One voice screen's pipeline, from WebRTC connect to disconnect."""

    def __init__(self, connection: Any, api_key: str, language: str, voice: str):
        self._connection = connection
        self._api_key = api_key
        self._language = language
        self._voice = voice
        self.gate = AudioGate()
        self._task: Any = None

    def send(self, message: dict[str, Any]) -> None:
        try:
            self._connection.send_app_message(message)
        except Exception:
            logger.debug("voice screen gone; message dropped")

    async def on_message(self, message: Any) -> None:
        if not isinstance(message, dict) or self._task is None:
            return
        kind = message.get("type")
        if kind == "ptt":
            down = bool(message.get("down"))
            if down:
                await self._task.queue_frame(InterruptionFrame())
            self.gate.push_to_talk(down)
        elif kind == "hands_free":
            self.gate.hands_free = bool(message.get("on"))
        elif kind == "speak":
            text = str(message.get("text") or "").strip()
            if text:
                await self._task.queue_frame(TTSSpeakFrame(text[:2000]))
        elif kind == "interrupt":
            await self._task.queue_frame(InterruptionFrame())

    async def run(self) -> None:
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.audio.vad.vad_analyzer import VADParams
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask
        from pipecat.processors.audio.vad_processor import VADProcessor
        from pipecat.transports.base_transport import TransportParams
        from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
        from pipecat_gnani import GnaniSTTService, GnaniTTSService

        transport = SmallWebRTCTransport(
            webrtc_connection=self._connection,
            params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
        )
        stt = GnaniSTTService(
            api_key=self._api_key,
            settings=GnaniSTTService.Settings(language=language_of(self._language)),
        )
        tts = GnaniTTSService(api_key=self._api_key, voice_id=self._voice, model=TTS_MODEL)
        vad = VADProcessor(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=0.25, stop_secs=0.5))
        )
        pipeline = Pipeline(
            [
                transport.input(),
                self.gate,
                vad,
                stt,
                HeardRelay(self.send, self.gate),
                tts,
                transport.output(),
                SpeakingRelay(self.send),
            ]
        )
        self._task = PipelineTask(
            pipeline,
            params=PipelineParams(audio_in_sample_rate=16_000, audio_out_sample_rate=24_000),
            idle_timeout_secs=None,
        )

        @self._connection.event_handler("app-message")
        async def on_app_message(_connection, message):
            await self.on_message(message)

        @self._connection.event_handler("closed")
        async def on_closed(_connection):
            if self._task:
                await self._task.cancel()

        try:
            await PipelineRunner(handle_sigint=False).run(self._task)
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None
