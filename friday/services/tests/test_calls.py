"""Phone-call building blocks, without any network."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

from pipecat.services.openai.llm import OpenAILLMService

from friday_services.calls.bot import build_call_pipeline, end_call_handler, evon_llm, first_words
from friday_services.calls.prompts import ask_friday_rules, phone_prompt
from friday_services.calls.store import CallStore
from friday_services.calls.stt import GNANI_FRAME_BYTES, FramedGnaniSTTService


class FakeGnaniSocket:
    def __init__(self):
        self.sent: list[bytes] = []

    async def send(self, data: bytes):
        self.sent.append(data)


async def test_stt_regroups_phone_packets_into_gnani_frames():
    stt = FramedGnaniSTTService(api_key="fake", sample_rate=8000)
    stt._ws = FakeGnaniSocket()  # skip the real connection
    for _ in range(10):  # ten 20 ms phone packets at 8 kHz = 3,200 bytes
        async for _frame in stt.run_stt(b"\x01\x02" * 160):
            pass
    assert [len(frame) for frame in stt._ws.sent] == [GNANI_FRAME_BYTES] * 3
    assert len(stt._pending) == 3200 - 3 * GNANI_FRAME_BYTES


async def test_store_finishes_once_and_wakes_waiters(tmp_path):
    store = CallStore(tmp_path)
    record = store.create(phone="+919812345678", goal="Book", language="en-IN", context="")
    store.set_stage(record.id, "ringing")
    early = await store.wait(record.id, 0.05)
    assert early.result()["status"] == "in_progress"
    assert early.result()["stage"] == "ringing"

    waiter = asyncio.create_task(store.wait(record.id, 5))
    await asyncio.sleep(0.05)
    store.finish(record.id, "answered", outcome="completed", summary="Booked.")
    store.finish(record.id, "failed", error="too late")  # ignored
    done = await waiter
    assert done.status == "answered" and done.error is None
    saved = (tmp_path / "calls" / f"{record.id}.json").read_text(encoding="utf-8")
    assert "Booked." in saved and record.stream_token not in saved


async def test_end_call_records_the_outcome_and_ends_the_pipeline():
    store = CallStore()
    record = store.create(phone="+919812345678", goal="Book", language="en-IN", context="")
    ended = asyncio.Event()
    pushed, results = [], []

    async def result_callback(result, **_kwargs):
        results.append(result)

    async def push_frame(frame, direction):
        pushed.append((type(frame).__name__, direction.name))

    params = SimpleNamespace(
        arguments={
            "outcome": "completed",
            "summary": "Booked for 7 PM.",
            "details": {"confirmed_time": "7 PM"},
        },
        result_callback=result_callback,
        llm=SimpleNamespace(push_frame=push_frame),
    )
    await end_call_handler(store, record, ended)(params)
    assert record.status == "answered" and record.outcome == "completed"
    assert record.details == {"confirmed_time": "7 PM"}
    assert ended.is_set() and results == [{"ok": True}]
    assert pushed == [("EndWorkerFrame", "UPSTREAM")]


def test_phone_prompt_discloses_ai_and_uses_india_time(settings):
    store = CallStore()
    record = store.create(
        phone="+919812345678",
        goal="Book a dental check-up tomorrow at 6 PM",
        language="hi-IN",
        context="7 PM is also fine.",
    )
    prompt = phone_prompt(record, "Asha", "Asia/Kolkata", datetime(2026, 10, 22, 7, 33, tzinfo=UTC))
    assert "Friday, an AI assistant calling for Asha" in prompt
    assert "Book a dental check-up tomorrow at 6 PM" in prompt
    assert "speak Hindi" in prompt and "7 PM is also fine." in prompt
    assert "Never agree to pay" in prompt
    assert "01:03 PM (Asia/Kolkata)" in prompt


async def test_call_pipeline_builds_with_gnani_and_evon(settings):
    store = CallStore()
    record = store.create(phone="+919812345678", goal="Book", language="ta-IN", context="")
    call = build_call_pipeline(
        object(),
        stream_sid="MZ1",
        call_sid="CA1",
        record=record,
        store=store,
        settings=settings,
    )
    names = [type(p).__name__ for p in call.pipeline.processors]
    expected = [
        "FastAPIWebsocketInputTransport",
        "FramedGnaniSTTService",
        "LLMUserAggregator",
        "CallLLM",
        "GnaniTTSService",
        "FastAPIWebsocketOutputTransport",
        "LLMAssistantAggregator",
    ]
    start = names.index(expected[0])
    assert names[start : start + len(expected)] == expected


async def test_a_tool_call_with_no_name_never_reaches_the_conversation(settings, monkeypatch):
    ran: list[list[str]] = []

    async def run(self, function_calls):
        ran.append([call.function_name for call in function_calls])

    monkeypatch.setattr(OpenAILLMService, "run_function_calls", run)
    calls = [
        SimpleNamespace(function_name="", tool_call_id="a"),
        SimpleNamespace(function_name="ask_friday", tool_call_id="b"),
    ]
    await evon_llm(settings).run_function_calls(calls)
    assert ran == [["ask_friday"]]


def test_friday_greets_at_once_in_the_calls_language():
    store = CallStore()

    def greeting(kind, language="en-IN", opening=""):
        record = store.create(
            phone="+91", goal="g", language=language, context="", kind=kind, opening=opening
        )
        return first_words(record, "Prem")

    assert greeting("owner") == "Hi Prem, it's Friday."
    assert greeting("reception") == "Hello, this is Friday, Prem's AI assistant. How can I help?"
    assert greeting("business", "hi-IN").startswith("नमस्ते, मैं फ्राइडे हूँ")
    assert greeting("owner", opening="Hi Prem, time for lunch!") == "Hi Prem, time for lunch!"
    assert greeting("owner", "ta-IN") == ""  # the model opens in languages with no greeting


def test_unclear_speech_is_not_sent_to_friday_as_a_task():
    assert "do not call it" in ask_friday_rules("Prem")
