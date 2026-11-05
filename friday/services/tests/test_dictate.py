"""Dictate anywhere: the cleanup, and Shift + Caps Lock telling the screen."""

from __future__ import annotations

from types import SimpleNamespace

from friday_services.dictate import clean_dictation, dictate
from friday_services.wake import PushToTalkKey


def test_cleans_up_what_was_said():
    assert clean_dictation("um hello uh team comma the demo is ready full stop") == (
        "Hello team, the demo is ready."
    )
    assert clean_dictation("is it done question mark yes") == "Is it done? Yes"
    assert clean_dictation("  hmm  ") == ""
    assert clean_dictation("kal milte hain") == "Kal milte hain"
    assert clean_dictation("नमस्ते कैसे हो") == "नमस्ते कैसे हो"


def test_words_that_only_contain_a_filler_stay():
    assert clean_dictation("the umbrella is an uhlan") == "The umbrella is an uhlan"


def test_never_presses_enter():
    assert "\n" not in clean_dictation("first line new line second line")


def test_types_with_a_space_after_and_nothing_for_silence():
    typed: list[str] = []
    assert dictate("hello", typed.append) == "Hello"
    assert dictate("um", typed.append) == ""
    assert typed == ["Hello "]


def key(shift: bool):
    signals: list[str] = []
    ptt = PushToTalkKey(
        signals.append,
        hook_key=lambda *a, **k: lambda: None,
        send=lambda _: None,
        hold_seconds=0,
        ctrl_held=lambda: False,
        shift_held=lambda: shift,
    )
    return ptt, signals


def press(ptt: PushToTalkKey) -> None:
    ptt.on_event(SimpleNamespace(event_type="down"))
    ptt._held()
    ptt.on_event(SimpleNamespace(event_type="up"))


def test_shift_caps_lock_says_this_turn_is_dictation():
    ptt, signals = key(shift=True)
    press(ptt)
    assert signals == ["dictate_next", "ptt_down", "ptt_up"]


def test_plain_caps_lock_is_a_normal_turn():
    ptt, signals = key(shift=False)
    press(ptt)
    assert signals == ["ptt_down", "ptt_up"]
