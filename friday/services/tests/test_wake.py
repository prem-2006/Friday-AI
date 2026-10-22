"""Caps Lock push-to-talk and double-clap wake, without a real keyboard or mic."""

from __future__ import annotations

import time
from types import SimpleNamespace

from friday_services.activity import ActivityFeed
from friday_services.wake import ClapCounter, PushToTalkKey


def key(event_type: str):
    return SimpleNamespace(event_type=event_type)


def make_key():
    signals: list[str] = []
    sent: list[str] = []
    ptt = PushToTalkKey(
        signals.append, hook_key=lambda *a, **k: None, send=sent.append, hold_seconds=0.05
    )
    return ptt, signals, sent


def test_holding_caps_lock_talks_and_never_reaches_windows():
    ptt, signals, sent = make_key()
    assert ptt.on_event(key("down")) is False
    for _ in range(5):  # key repeat while held
        assert ptt.on_event(key("down")) is False
    time.sleep(0.15)
    assert signals == ["ptt_down"]
    assert ptt.on_event(key("up")) is False
    assert signals == ["ptt_down", "ptt_up"]
    time.sleep(0.05)
    assert sent == []  # Caps Lock state untouched


def test_a_quick_tap_is_still_caps_lock():
    ptt, signals, sent = make_key()
    ptt.on_event(key("down"))
    ptt.on_event(key("up"))
    time.sleep(0.15)
    assert signals == []
    assert sent == ["caps lock"]


def quiet(counter: ClapCounter, start: float, seconds: float) -> float:
    t = start
    while t < start + seconds:
        counter.feed(0.01, 0.003, t)
        t += 0.032
    return t


def test_two_claps_wake_but_one_clap_or_speech_does_not():
    counter = ClapCounter(min_peak=0.25)
    t = quiet(counter, 0, 1.0)
    assert counter.feed(0.8, 0.2, t) is False  # first clap
    t = quiet(counter, t + 0.032, 0.3)
    assert counter.feed(0.7, 0.2, t) is True  # second clap
    # Cooldown: a third clap right after does nothing.
    t = quiet(counter, t + 0.032, 0.3)
    assert counter.feed(0.8, 0.2, t) is False

    single = ClapCounter(min_peak=0.25)
    t = quiet(single, 0, 1.0)
    single.feed(0.8, 0.2, t)
    t = quiet(single, t + 0.032, 1.5)  # too long a gap
    assert single.feed(0.8, 0.2, t) is False

    speech = ClapCounter(min_peak=0.25)
    t = quiet(speech, 0, 1.0)
    fired = False
    for n in range(60):  # loud, continuous speech
        fired |= speech.feed(0.6, 0.15, t + n * 0.032)
    assert fired is False


def test_signals_reach_the_screen_but_are_not_kept():
    feed = ActivityFeed()
    assert feed.watched is False
    queue = feed.listen()
    assert feed.watched is True
    feed.signal("ptt_down")
    event = queue.get_nowait()
    assert (event.actor, event.action) == ("control", "ptt_down")
    assert feed.recent() == []
