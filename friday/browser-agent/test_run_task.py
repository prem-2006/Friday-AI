"""The parts of run_task.py that do not need a model or a browser."""

from types import SimpleNamespace

import pytest

from run_task import model_settings, step_event


def test_gemini_uses_its_own_api_and_others_the_openai_one():
    gemini = model_settings(
        {
            "EVON_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai/",
            "EVON_API_KEY": "k",
            "EVON_MODEL": "gemini-2.5-flash-lite",
        }
    )
    assert gemini["kind"] == "google" and gemini["model"] == "gemini-2.5-flash-lite"
    other = model_settings(
        {"EVON_BASE_URL": "https://api.example/v1", "EVON_API_KEY": "k", "EVON_MODEL": "evon"}
    )
    assert other["kind"] == "openai"


def test_browser_settings_override_and_missing_ones_are_explained():
    chosen = model_settings({"EVON_API_KEY": "k", "EVON_MODEL": "a", "FRIDAY_BROWSER_MODEL": "b"})
    assert chosen["model"] == "b"
    with pytest.raises(ValueError, match="EVON_API_KEY"):
        model_settings({})


def test_step_event_is_short_and_safe_without_fields():
    state = SimpleNamespace(url="https://x.test")
    assert step_event(2, state, SimpleNamespace(next_goal="  Click search  ")) == {
        "type": "step",
        "n": 2,
        "goal": "Click search",
        "url": "https://x.test",
    }
    assert step_event(1, object(), object())["goal"] == ""
