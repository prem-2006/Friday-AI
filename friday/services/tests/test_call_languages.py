"""Calls in any Indian language, client calls for the business, and a request
on a call done once."""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from friday_services.business import Leads, busy_times, client_context, profile_text, slot_taken
from friday_services.calendar.store import CalendarStore
from friday_services.calls.bot import (
    ask_friday_handler,
    book_meeting_handler,
    build_call_pipeline,
    first_words,
    save_lead_handler,
)
from friday_services.calls.language import reply_language, script_language, working_line
from friday_services.calls.prompts import client_prompt, reception_prompt
from friday_services.calls.store import CallStore
from friday_services.calls.stt import FramedGnaniSTTService, auto_language_settings


def test_each_reply_is_voiced_in_its_own_language():
    assert script_language("வணக்கம், நாளை சந்திக்கலாம்") == "ta-IN"
    assert script_language("ಹೌದು, ನಾಳೆ ಸಿಗೋಣ") == "kn-IN"
    assert script_language("Haan ji, kal milte hain") is None
    assert reply_language("नमस्ते जी", "hi-IN") == "hi-IN"
    assert reply_language("नमस्कार, उद्या भेटू", "mr-IN") == "mr-IN"  # Devanagari Marathi
    assert reply_language("Haan ji, kal milte hain", "hi-IN") == "hi-IN"  # Hinglish
    assert reply_language("Sure, see you tomorrow", "ta-IN") == "en-IN"
    assert working_line("te-IN").startswith("ఒక్క")
    assert working_line(None) == "One second, I'm on it."


def test_prisma_tells_which_language_the_caller_spoke():
    stt = FramedGnaniSTTService(
        api_key="x", sample_rate=8000, settings=auto_language_settings(format="transcribe")
    )
    pushed = []

    async def push_frame(frame, *_):
        pushed.append(frame)

    stt.push_frame = push_frame
    asyncio.run(
        stt._push_transcript(
            "வணக்கம்", is_final=True, result={"detected_language_code": "ta-IN"}
        )
    )
    assert stt.heard == "ta-IN" and pushed[0].language.value == "ta-IN"


def test_every_call_follows_the_callers_language():
    store = CallStore()
    record = store.create(phone="+91", goal="x", language="en-IN", context="", kind="reception")
    auto = reception_prompt(record, "Prem", "Asia/Kolkata", auto_language=True)
    fixed = reception_prompt(record, "Prem", "Asia/Kolkata")
    assert "any Indian language" in auto and "Tamil letters" in auto
    assert "any Indian language" not in fixed


def test_the_same_request_on_a_call_runs_once():
    asked: list[str] = []

    async def ask(_record, request):
        asked.append(request)
        await asyncio.sleep(0.01)
        return "Meeting is set for 12."

    handler = ask_friday_handler(SimpleNamespace(id="c1"), ask)
    replies: list[dict] = []

    async def result(value):
        replies.append(value)

    def params(text):
        return SimpleNamespace(arguments={"request": text}, result_callback=result)

    async def go():
        await asyncio.gather(
            handler(params("Ek meeting arrange kar do barah baje ki")),
            handler(params("ek meeting arrange kar do, barah baje ki!")),
        )
        await handler(params("laptop mein kitna charge hai"))

    asyncio.run(go())
    assert asked == ["Ek meeting arrange kar do barah baje ki", "laptop mein kitna charge hai"]
    assert replies[0] == replies[1] == {"reply": "Meeting is set for 12."}


def test_a_client_call_books_meetings_and_saves_one_lead(tmp_path):
    calendar = CalendarStore(tmp_path / "calendar.json")
    leads = Leads(tmp_path / "leads.json")
    record = SimpleNamespace(id="c1", phone="+919800000000", details={})

    async def book(_record, date, time_, name, topic):
        if slot_taken(calendar, date, time_):
            raise ValueError("That time is taken.")
        return calendar.add(f"Meeting with {name}", date, time_, topic, source="call")

    async def save(_record, fields):
        leads.add(phone=_record.phone, **fields)

    results: list[dict] = []

    async def result(value):
        results.append(value)

    booking = book_meeting_handler(record, book)
    lead = save_lead_handler(record, save)

    async def go():
        args = {"date": "2026-11-12", "time": "16:00", "name": "Asha", "topic": "Demo"}
        await booking(SimpleNamespace(arguments=args, result_callback=result))
        await booking(SimpleNamespace(arguments=args, result_callback=result))
        for _ in range(2):
            await lead(
                SimpleNamespace(
                    arguments={"name": "Asha", "interest": "Gold plan"}, result_callback=result
                )
            )

    asyncio.run(go())
    assert results[0]["booked"] is True and results[1] == {
        "booked": False,
        "error": "That time is taken.",
    }
    assert record.details["meeting"] == "2026-11-12 16:00"
    assert [x["name"] for x in leads.recent()] == ["Asha"]


def test_the_business_profile_and_calendar_reach_the_client_prompt(tmp_path):
    template = tmp_path / "business.md"
    template.write_text("<!-- note -->\n# [fill in: business name]\n", encoding="utf-8")
    assert profile_text(template) == ""  # not filled in yet
    template.write_text(
        "<!-- for the owner only -->\n# Chai Point\n- Masala chai: ₹40\n", encoding="utf-8"
    )
    assert profile_text(template) == "# Chai Point\n- Masala chai: ₹40"

    calendar = CalendarStore(tmp_path / "calendar.json")
    calendar.add("Busy", "2026-11-09", "11:00", source="test")
    now = datetime(2026, 11, 8, 9, tzinfo=ZoneInfo("Asia/Kolkata"))
    assert busy_times(calendar, "Asia/Kolkata", now=now) == "- 2026-11-09 11:00: busy"

    settings = SimpleNamespace(
        get=lambda key, default="": str(template) if key == "FRIDAY_BUSINESS_PROFILE" else default,
        timezone="Asia/Kolkata",
    )
    context = client_context(settings, calendar, who="Asha")
    store = CallStore()
    record = store.create(
        phone="+91", goal="Answer the caller", language="hi-IN", context=context, kind="client_in"
    )
    prompt = client_prompt(record, "Prem", "Asia/Kolkata")
    assert "Masala chai: ₹40" in prompt and "book_meeting" in prompt and "save_lead" in prompt
    assert "any Indian language" in prompt
    assert first_words(record, "Prem").startswith("नमस्ते")


async def test_a_client_call_has_its_business_tools(settings):
    store = CallStore()
    record = store.create(
        phone="+919812345678", goal="Sell", language="en-IN", context="", kind="client"
    )

    async def anything(*_):
        return {}

    from friday_services.calls.bot import CallHelpers

    call = build_call_pipeline(
        object(),
        stream_sid="MZ1",
        call_sid="CA1",
        record=record,
        store=store,
        settings=settings,
        helpers=CallHelpers(take_message=anything, book_meeting=anything, save_lead=anything),
    )
    llm = next(p for p in call.pipeline.processors if type(p).__name__ == "CallLLM")
    assert {"book_meeting", "save_lead", "end_call", "take_message"} <= set(llm._functions)
    assert first_words(record, "Prem") == ""  # the model says who it is and why
    await call.http.close()
