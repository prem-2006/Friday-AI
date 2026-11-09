""" "Call me" always dials: the model could only promise it."""

from __future__ import annotations

import asyncio

import pytest

from friday_services.instant import Instant


@pytest.fixture
def friday(tmp_path):
    ran: list[tuple[str, dict]] = []

    async def run(tool, args):
        ran.append((tool, args))
        return {"friday_say": "Calling your phone now."}

    instant = Instant(tmp_path / "shortcuts.json", lambda: [], run)
    instant.ran = ran
    return instant


@pytest.mark.parametrize(
    "words",
    [
        "Friday, call me.",
        "call me now",
        "Can you call me back please?",
        "give me a call",
        "Mujhe call karo",
        "like call pe yahan pe nahin, mujhe call karo.",
        "Friday mujhe abhi tak call nahin aya hai, call karo jaldi.",
        "mujhe phone lagao",
        "मुझे कॉल करो",
        "call karo jaldi",
    ],
)
def test_asking_for_a_call_dials_without_the_model(friday, words):
    done = asyncio.run(friday.handle(words))
    assert done and done["say"] == "Calling your phone now."
    assert [tool for tool, _ in friday.ran] == ["call_me"]


@pytest.mark.parametrize(
    "words",
    [
        "Didi ko call karo",
        "Rahul ko abhi phone karo",
        "call me at 5",
        "mujhe kal subah call karo",
        "mujhe 10 minute baad call karo",
        "mujhe call mat karo",
        "don't call me",
        "what do you call me",
        "why did you call me",
        "mujhe call karna hai",
        "whatsapp pe mujhe call karo",
    ],
)
def test_other_calls_are_left_to_the_model(friday, words):
    assert asyncio.run(friday.handle(words)) is None
    assert friday.ran == []


def test_a_refused_call_says_why_instead_of_promising(tmp_path):
    async def run(tool, args):
        raise RuntimeError("Error executing tool call_me: I called you less than 10 minutes ago.")

    done = asyncio.run(Instant(tmp_path / "s.json", lambda: [], run).handle("call me"))
    assert done["say"] == "I called you less than 10 minutes ago." and done["failed"]
