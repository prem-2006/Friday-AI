"""A reminder call opens with the reminder itself, not "How can I help?"."""

from __future__ import annotations

from friday_services.calls.prompts import owner_prompt, phone_prompt
from friday_services.calls.store import CallStore
from friday_services.config import Settings
from friday_services.owner_calls import OwnerCaller

from .conftest import FAKE_ENV, FakeDialer


async def test_reminder_calls_open_with_the_reminder(tmp_path):
    settings = Settings.from_env(
        {**FAKE_ENV, "FRIDAY_OWNER_NAME": "Prem", "FRIDAY_OWNER_PHONE": "+919876543210"},
        data_dir=tmp_path,
    )
    dialer = FakeDialer()
    caller = OwnerCaller(settings, CallStore(tmp_path), dialer)
    opening = "Hi Prem, you have a reminder: drink water."
    placed = await caller.call("Reminder: drink water.", urgent=True, opening=opening)
    assert placed["called"] is True
    record = dialer.placed[0]
    assert record.kind == "owner" and record.phone == "+919876543210"
    assert f'Start: say exactly "{opening}".' in owner_prompt(record, "Prem", "Asia/Kolkata")


def test_without_an_opening_friday_says_the_reason_itself():
    record = CallStore().create(
        phone="+91", goal="Dinner", language="en-IN", context="", kind="owner"
    )
    assert """Start: say "Hi Prem, it's Friday.\"""" in owner_prompt(record, "Prem", "Asia/Kolkata")


def test_a_chosen_opening_still_says_friday_is_an_ai():
    record = CallStore().create(
        phone="+91", goal="Say hi", language="en-IN", context="", opening="Hi Didi!"
    )
    prompt = phone_prompt(record, "Prem", "Asia/Kolkata")
    assert 'say "Hi Didi!"' in prompt and "an AI assistant calling for Prem" in prompt


class FakeSarvam:
    ready = True

    def __init__(self):
        self.calls: list[dict] = []

    async def call(self, **fields):
        self.calls.append(fields)
        return "ok"


async def test_until_exotel_is_set_up_sarvams_agent_places_the_call(tmp_path):
    env = {k: v for k, v in FAKE_ENV.items() if not k.startswith("EXOTEL_")}
    settings = Settings.from_env(
        {**env, "FRIDAY_OWNER_NAME": "Prem", "FRIDAY_OWNER_PHONE": "+919876543210"},
        data_dir=tmp_path,
    )
    sarvam, dialer = FakeSarvam(), FakeDialer()
    caller = OwnerCaller(settings, CallStore(tmp_path), dialer, sarvam=sarvam)
    placed = await caller.call("Reminder: drink water.", urgent=True, opening="Hi Prem!")
    assert placed == {"called": True, "via": "sarvam"} and dialer.placed == []
    assert sarvam.calls[0]["greeting"] == "Hi Prem!"
    assert sarvam.calls[0]["phone"] == "+919876543210"
