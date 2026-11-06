"""Scripted demo replies: the script's exact line for its questions only."""

from __future__ import annotations

import json

from friday_services.scripted import SCRIPT, matches, reply


def test_the_human_memory_scene_gets_its_exact_lines():
    assert reply("Friday, where did I put my headphones?") == (
        "You mentioned leaving them on your study table."
    )
    # Speech-to-text drops or changes a word now and then.
    assert reply("friday where did i put my headphone") == (
        "You mentioned leaving them on your study table."
    )
    assert reply("Friday, what was I supposed to do today?") == (
        "You planned to finish your assignment, attend your meeting at 4 p.m."
    )
    assert reply("How do you remember everything?") == "That's literally my job."


def test_other_requests_are_left_to_friday():
    assert reply("open notepad") is None
    assert reply("Oh! Right.") is None
    # The same words inside a longer, different request.
    assert not matches(
        "where did I put my headphones order new ones from amazon and send the link to didi",
        "where did I put my headphones",
    )


def test_every_line_in_the_script_file_is_usable():
    lines = json.loads(SCRIPT.read_text(encoding="utf-8"))["lines"]
    assert lines and all(line["say"] and line["when"] for line in lines)
