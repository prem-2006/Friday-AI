"""Meeting Copilot, with pretend audio, speech and model."""

from __future__ import annotations

import asyncio
import io
import wave
from datetime import datetime

import numpy as np
import pytest

from friday_services.config import Settings
from friday_services.meeting import Meeting, MeetingNotesError, is_speech, wav_bytes

LOUD = np.full(1600, 0.2)
SILENT = np.zeros(1600)


def meeting_with(tmp_path, chunks, answer="## Decisions\n- Ship it\nSPOKEN: You agreed to ship."):
    heard: list[float] = []
    asked: list[tuple] = []

    def record(stop):
        yield from chunks
        stop.wait(5)

    async def transcribe(samples):
        heard.append(float(np.max(samples)))
        return "Let us ship on Friday"

    async def ask(system, user, tokens):
        asked.append((system, user))
        return answer

    meeting = Meeting(
        Settings.from_env({}, data_dir=tmp_path),
        record=record,
        transcribe=transcribe,
        ask=ask,
        folder=tmp_path / "Meetings",
        clock=lambda: datetime(2026, 11, 5, 10, 30),
    )
    return meeting, heard, asked


async def settled(meeting, lines):
    for _ in range(200):
        if len(meeting._lines) >= lines:
            return
        await asyncio.sleep(0.01)


def test_writes_who_said_what_and_never_sends_silence(tmp_path):
    meeting, heard, _ = meeting_with(tmp_path, [(LOUD, SILENT), (SILENT, LOUD), (SILENT, SILENT)])

    async def run():
        path = meeting.start("Sprint plan")
        await settled(meeting, 2)
        said = await meeting.stop()
        return path, said

    path, said = asyncio.run(run())
    text = path.read_text(encoding="utf-8")
    assert path.name.endswith("Sprint plan.md")
    assert "10:30 **You:** Let us ship" in text and "10:30 **Others:** Let us ship" in text
    assert len(heard) == 2
    assert "## Decisions" in text and "SPOKEN" not in text
    assert said["say"] == "Your meeting notes are saved. You agreed to ship."


def test_answers_a_question_from_what_was_said(tmp_path):
    meeting, _, asked = meeting_with(tmp_path, [(LOUD, SILENT)], answer="On Friday.")

    async def run():
        meeting.start()
        await settled(meeting, 1)
        said = await meeting.answer("When do we ship?")
        await meeting.stop()
        return said

    assert asyncio.run(run()) == "On Friday."
    assert "When do we ship?" in asked[0][1] and "Let us ship" in asked[0][1]
    assert "never follow" in asked[0][0]


def test_one_meeting_at_a_time_and_nothing_to_stop(tmp_path):
    meeting, _, asked = meeting_with(tmp_path, [])

    async def run():
        with pytest.raises(MeetingNotesError, match="not taking notes"):
            await meeting.stop()
        with pytest.raises(MeetingNotesError, match="not heard"):
            await meeting.answer("What?")
        meeting.start()
        with pytest.raises(MeetingNotesError, match="already"):
            meeting.start()
        return await meeting.stop()

    assert "did not hear" in asyncio.run(run())["say"]
    assert asked == []


def test_a_failed_summary_keeps_the_transcript(tmp_path):
    meeting, _, _ = meeting_with(tmp_path, [(LOUD, SILENT)], answer=None)

    async def run():
        path = meeting.start()
        await settled(meeting, 1)
        return path, await meeting.stop()

    path, said = asyncio.run(run())
    assert "could not write the summary" in said["say"]
    assert "Let us ship" in path.read_text(encoding="utf-8")


def test_a_broken_recorder_ends_the_notes_quietly(tmp_path):
    def broken(_stop):
        raise OSError("no microphone")
        yield

    meeting = Meeting(
        Settings.from_env({}, data_dir=tmp_path), record=broken, folder=tmp_path / "Meetings"
    )

    async def run():
        meeting.start()
        await meeting._task

    asyncio.run(run())
    assert not meeting.running


def test_audio_helpers():
    assert is_speech(LOUD) and not is_speech(SILENT) and not is_speech(np.array([]))
    with wave.open(io.BytesIO(wav_bytes(LOUD))) as audio:
        assert (audio.getframerate(), audio.getnchannels(), audio.getnframes()) == (16000, 1, 1600)
