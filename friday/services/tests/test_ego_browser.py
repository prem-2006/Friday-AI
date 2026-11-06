"""Navigator in ego lite, with a pretend ego-browser command and model."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from friday_services.browser import SENDING_NEEDS_OK, BrowserError
from friday_services.ego_agent import EgoAgent, parse_step
from friday_services.ego_browser import MARKER, EgoBrowser, explain, parse_result, search_url


def runner(reply: dict | None = None, code: int = 0, error: str = "", seen: list | None = None):
    def run(command, **options):
        script = Path(command[3].split("'")[1].replace("file:///", "")).read_text(encoding="utf-8")
        if seen is not None:
            seen.append((command, json.loads(options["env"]["FRIDAY_EGO_ARGS"]), script))
        out = f"log line\n{MARKER}{json.dumps(reply or {'url': 'u', 'title': 't', 'page': 'p'})}\n"
        return SimpleNamespace(returncode=code, stdout=out if code == 0 else "", stderr=error)

    return run


def test_each_step_runs_a_script_in_the_named_space_with_json_values():
    seen: list = []
    browser = EgoBrowser("Navigator", command="ego-browser", run=runner(seen=seen))
    assert browser.type(21, 'he said "hi"; rm -rf', True)["title"] == "t"
    command, args, script = seen[0]
    assert command[:3] == ["ego-browser", "nodejs", "-e"]
    assert args["space"] == "Navigator" and args["text"] == 'he said "hi"; rm -rf'
    assert args["ref"] == 21 and args["enter"] is True
    assert "rm -rf" not in script  # values travel as JSON, never as code
    assert "page.fill(`@${args.ref}`, args.text)" in script


def test_opening_adds_https_and_search_goes_to_the_site():
    seen: list = []
    browser = EgoBrowser(command="ego-browser", run=runner(seen=seen))
    browser.open("example.com")
    browser.search("youtube", "lofi beats")
    assert seen[0][1]["url"] == "https://example.com"
    assert seen[1][1]["url"] == search_url("youtube", "lofi beats")
    with pytest.raises(BrowserError):
        browser.search("bing", "x")


def test_sending_and_secret_fields_are_refused():
    browser = EgoBrowser(command="ego-browser", run=runner(code=1, error="Error: SEND"))
    with pytest.raises(BrowserError, match="owner's OK"):
        browser.click(4)
    with pytest.raises(BrowserError, match="owner's OK"):
        EgoBrowser(command="x", run=runner()).press("Ctrl + Enter")
    secret = EgoBrowser(command="x", run=runner(code=1, error="Error: SENSITIVE"))
    with pytest.raises(BrowserError, match="password"):
        secret.type(3, "hunter2", False)


def test_the_send_and_secret_checks_match_what_they_should():
    from friday_services.ego_browser import SEND, SENSITIVE

    assert SEND.search('- button "Send" [@4]') and not SEND.search('- link "Sender info" [@5]')
    assert SENSITIVE.search('- textbox "Password" [@3]')
    assert not SENSITIVE.search('- textbox "Search" [@3]')


def test_errors_say_what_to_do():
    assert explain("Error: NOREF 9", 9) == "No element [9] on this page. Take a new snapshot first."
    assert explain("x\nTimeoutError: page did not load\n").endswith("page did not load")
    assert explain("SEND") == SENDING_NEEDS_OK
    with pytest.raises(BrowserError, match="no answer"):
        parse_result("only logs")


def test_navigator_picks_ego_lite_when_it_is_installed_or_asked_for():
    from friday_services.ego_browser import navigator_uses_ego

    assert navigator_uses_ego("auto", "C:/ego/ego-browser.exe")
    assert not navigator_uses_ego("chrome", "C:/ego/ego-browser.exe")
    assert navigator_uses_ego("ego")
    assert navigator_uses_ego("", "x")


def test_missing_or_slow_ego_lite_is_a_plain_error():
    def missing(*_a, **_k):
        raise FileNotFoundError

    def slow(*_a, **_k):
        raise subprocess.TimeoutExpired("ego-browser", 60)

    with pytest.raises(BrowserError, match="not installed"):
        EgoBrowser(command="x", run=missing).snapshot()
    with pytest.raises(BrowserError, match="too long"):
        EgoBrowser(command="x", run=slow).snapshot()


class Pretend:
    def __init__(self):
        self.done: list[str] = []

    def snapshot(self):
        return {"url": "https://a.com", "title": "Start", "page": '- link "Docs" [@3]'}

    def click(self, ref):
        self.done.append(f"click {ref}")
        return {"url": "https://a.com/docs", "title": "Docs", "page": "Docs page"}

    def type(self, ref, text, enter):
        raise BrowserError("That is a password field.")


async def directly(fn, *args):
    return fn(*args)


def test_the_agent_steps_until_done_and_learns_from_failures():
    answers = iter(
        [
            '{"do": "type", "ref": 1, "text": "x"}',
            '```json\n{"do": "click", "ref": 3}\n```',
            '{"do": "done", "answer": "The docs are open."}',
        ]
    )
    prompts: list[str] = []

    async def ask(system, user, tokens):
        prompts.append(user)
        return next(answers)

    browser = Pretend()
    steps: list = []

    async def on_step(step):
        steps.append(step)

    agent = EgoAgent(browser, ask, directly)
    outcome = asyncio.run(agent.run("open the docs", 10, on_step, lambda: False))
    assert outcome == {
        "ok": True,
        "result": "The docs are open.",
        "urls": ["https://a.com/docs"],
        "steps": 3,
    }
    assert browser.done == ["click 3"]
    assert "failed: That is a password field." in prompts[1]
    assert len(steps) == 2


def test_the_agent_stops_when_told_and_when_out_of_steps():
    async def ask(system, user, tokens):
        return '{"do": "click", "ref": 3}'

    async def on_step(_step):
        pass

    agent = EgoAgent(Pretend(), ask, directly)
    assert (
        asyncio.run(agent.run("x", 5, on_step, lambda: True))["result"] == "Stopped by the owner."
    )
    assert not asyncio.run(agent.run("x", 2, on_step, lambda: False))["ok"]
    assert parse_step("Just text") == {"do": "done", "answer": "Just text"}
