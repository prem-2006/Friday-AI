"""Friday's live voice pipeline, without WebRTC or Gnani: what reaches Gnani,
what the screen is told, and how the screen's messages are handled."""

from __future__ import annotations

import asyncio

import httpx
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.tests.utils import run_test

from friday_services.live_voice import (
    AudioGate,
    HeardRelay,
    LiveVoiceSession,
    SpeakingRelay,
    language_of,
)

from .conftest import TOKEN

CHUNK = 320  # 10 ms of 16 kHz mono 16-bit audio


def audio(value: int = 1) -> InputAudioRawFrame:
    return InputAudioRawFrame(audio=bytes([value]) * CHUNK, sample_rate=16_000, num_channels=1)


def passed(gate: AudioGate, count: int):
    down, _ = asyncio.run(
        run_test(gate, frames_to_send=[audio() for _ in range(count)], expected_down_frames=None)
    )
    return [frame for frame in down if isinstance(frame, InputAudioRawFrame)]


def test_gate_sends_nothing_to_gnani_until_caps_lock_is_held():
    # A processor joins one pipeline only, so each run gets its own gate.
    assert passed(AudioGate(), 5) == []
    held = AudioGate()
    held.push_to_talk(True)
    assert len(passed(held, 5)) == 5


def test_gate_adds_a_second_of_silence_after_caps_lock_is_let_go():
    gate = AudioGate(tail_seconds=0.05)
    gate.push_to_talk(True)
    gate.push_to_talk(False)
    frames = passed(gate, 10)
    assert len(frames) == 5  # 50 ms of 10 ms frames
    assert all(frame.audio == bytes(CHUNK) for frame in frames)  # silence, not the mic


def test_hands_free_keeps_the_gate_open():
    gate = AudioGate()
    gate.hands_free = True
    assert len(passed(gate, 3)) == 3


def test_relays_tell_the_screen_what_was_heard_and_when_friday_speaks():
    sent: list[dict] = []
    gate = AudioGate()
    gate.hands_free = True
    asyncio.run(
        run_test(
            HeardRelay(sent.append, gate),
            frames_to_send=[
                VADUserStartedSpeakingFrame(),
                TranscriptionFrame(text=" open calculator ", user_id="", timestamp=""),
            ],
            expected_down_frames=None,
        )
    )
    asyncio.run(
        run_test(
            SpeakingRelay(sent.append),
            frames_to_send=[BotStartedSpeakingFrame(), BotStoppedSpeakingFrame()],
            expected_down_frames=None,
        )
    )
    assert [(m["event"], m.get("text"), m.get("on")) for m in sent] == [
        ("speech_start", None, None),
        ("heard", "open calculator", None),
        ("speaking", None, True),
        ("speaking", None, False),
    ]
    assert all(m["type"] == "friday-live" for m in sent)


class FakeTask:
    def __init__(self):
        self.frames = []

    async def queue_frame(self, frame):
        self.frames.append(frame)


def test_screen_messages_drive_the_pipeline():
    session = LiveVoiceSession(connection=None, api_key="k", language="en-IN", voice="Kaveri")
    task = FakeTask()
    session._task = task

    async def say(*messages):
        for message in messages:
            await session.on_message(message)

    asyncio.run(
        say(
            {"type": "ptt", "down": True},
            {"type": "speak", "text": "Calculator is open."},
            {"type": "interrupt"},
            {"type": "hands_free", "on": True},
            {"type": "unknown"},
            "not a dict",
        )
    )
    assert session.gate.held and session.gate.hands_free
    assert [type(frame) for frame in task.frames] == [
        InterruptionFrame,  # Caps Lock cuts Friday off
        TTSSpeakFrame,
        InterruptionFrame,
    ]
    assert task.frames[1].text == "Calculator is open."


def test_languages_fall_back_to_indian_english():
    assert language_of("hi-IN").value == "hi-IN"
    assert language_of("xx-YY").value == "en-IN"


def test_offer_needs_the_token_and_an_sdp(server):
    url = f"{server.url}/voice/offer"
    assert httpx.post(url, json={}).status_code == 401
    bad = httpx.post(url, json={"type": "offer"}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert bad.status_code == 400
