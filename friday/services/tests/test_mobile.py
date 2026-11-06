"""Friday on the owner's Android phone, with a pretend phone-harness and model."""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
from types import SimpleNamespace

import pytest

from friday_services.mobile import MARKER, Phone, PhoneError, PhoneJobs, explain, parse_step


def harness(replies: dict[str, dict], seen: list | None = None, code: int = 0, error: str = ""):
    def run(command, input, **options):
        literal = re.search(r"args = json\.loads\((\".*?(?<!\\)\")\)", input).group(1)
        args = json.loads(json.loads(literal))
        step = input.strip().splitlines()[-1]
        name = next((key for key in replies if key in step), "texts")
        if seen is not None:
            seen.append((command, args, input))
        out = f"{MARKER}{json.dumps(replies.get(name, {'texts': ['Home']}))}\n"
        return SimpleNamespace(returncode=code, stdout=out if code == 0 else "", stderr=error)

    return run


def test_values_reach_the_script_as_json_and_the_screen_comes_back():
    seen: list = []
    phone = Phone(
        "phone-harness", run=harness({"open_app": {"app": "x", "texts": ["Chats"]}}, seen)
    )
    assert phone.open_app("Whats\"App'); import os") == ["Chats"]
    command, args, script = seen[0]
    assert command == ["phone-harness"] and args == {"name": "Whats\"App'); import os"}
    assert script.count("import os") == 1  # only inside the JSON literal


def test_not_ready_says_what_the_owner_must_do():
    for state, words in [("no-adb", "adb"), ("no-device", "USB"), ("locked", "Unlock")]:
        phone = Phone("x", run=harness({"connection_state": {"state": state}}))
        with pytest.raises(PhoneError, match=words):
            phone.ready()
    Phone("x", run=harness({"connection_state": {"state": "ready"}})).ready()


def test_sending_paying_and_secrets_are_left_to_the_owner():
    phone = Phone("x", run=harness({}))
    for text in ("Send", "Pay ₹500", "Place order", "Delete chat"):
        with pytest.raises(PhoneError, match="owner"):
            phone.tap_text(text)
    with pytest.raises(PhoneError, match="PIN or OTP"):
        phone.type("123456", ["Enter OTP"])
    assert phone.tap_text("Ravi") == ["Home"]


def test_missing_slow_and_failing_steps_are_plain_errors():
    def missing(*_a, **_k):
        raise FileNotFoundError

    def slow(*_a, **_k):
        raise subprocess.TimeoutExpired("phone-harness", 45)

    with pytest.raises(PhoneError, match="not installed"):
        Phone("x", run=missing).screen()
    with pytest.raises(PhoneError, match="too long"):
        Phone("x", run=slow).screen()
    broken = Phone("x", run=harness({}, code=1, error="Traceback\nRuntimeError: no visible text"))
    with pytest.raises(PhoneError, match="no visible text"):
        broken.screen()
    assert explain("") == "The phone could not do that: no detail"


class Pretend:
    def __init__(self):
        self.done: list[str] = []

    def ready(self):
        pass

    def screen(self):
        return ["Home", "WhatsApp"]

    def open_app(self, name):
        self.done.append(f"open {name}")
        return ["Chats", "Ravi", "Hi, kal milte hain"]

    def tap_text(self, text):
        raise PhoneError(f'Tapping "{text}" is for the owner to do on the phone.')


def test_a_job_steps_until_done_and_says_the_answer():
    answers = iter(
        [
            '{"do": "open_app", "name": "WhatsApp"}',
            '{"do": "tap", "text": "Send"}',
            '{"do": "done", "answer": "Ravi ne kaha kal milte hain."}',
        ]
    )
    prompts: list[str] = []

    async def ask(system, user, tokens):
        prompts.append(user)
        return next(answers)

    said: list[str] = []
    phone = Pretend()
    jobs = PhoneJobs(phone, ask, said.append)

    async def run():
        assert jobs.start("Ravi ki last message padho", hinglish=True)
        assert not jobs.start("another")
        await jobs._task

    asyncio.run(run())
    assert said == ["Ravi ne kaha kal milte hain."]
    assert phone.done == ["open WhatsApp"]
    assert "Hi, kal milte hain" in prompts[1]
    assert "failed: Tapping" in prompts[2]


def test_a_stopped_job_says_nothing_and_a_broken_phone_says_why():
    async def ask(system, user, tokens):
        return '{"do": "home"}'

    said: list[str] = []
    jobs = PhoneJobs(Pretend(), ask, said.append, stopped=lambda: True)

    async def run(target):
        target.start("x")
        await target._task

    asyncio.run(run(jobs))
    assert said == []

    class Unplugged(Pretend):
        def ready(self):
            raise PhoneError("No phone is connected.")

    broken = PhoneJobs(Unplugged(), ask, said.append)
    asyncio.run(run(broken))
    assert said == ["No phone is connected."]
    assert parse_step("plain words") == {"do": "done", "answer": "plain words"}
