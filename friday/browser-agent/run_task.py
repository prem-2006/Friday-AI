"""Navigator's engine: one browser-use task in the Chrome window friday/services opened.

friday/services starts this script with a JSON request on stdin:
    {"task": "...", "cdp_url": "http://127.0.0.1:9333", "max_steps": 15}
and reads lines that start with EVENT_PREFIX from stdout:
    {"type": "step", "n": 1, "goal": "...", "url": "..."}
    {"type": "done", "ok": true, "result": "...", "urls": [...], "steps": 4}
Everything else browser-use prints goes to stderr, which friday/services keeps in a log.

The model comes from the same EVON_* settings as Friday (FRIDAY_BROWSER_MODEL can
pick a different one). Telemetry and cloud sync are off.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Mapping
from typing import Any

EVENT_PREFIX = "FRIDAY_EVENT "
EVENTS = sys.stdout  # main() points sys.stdout at stderr for browser-use's logs

SAFETY = """
You work for Friday, a personal assistant, in a Chrome window on the owner's screen.
- Never type passwords, card numbers, UPI PINs or one-time codes, and never solve CAPTCHAs.
- Never buy, pay, book anything paid, place orders, accept terms or send messages.
- If the task needs a login, payment or any of the above, stop and say what the owner must do.
- Close cookie banners with the least-permissive option.
- Finish with a short plain answer: what you found (titles and links) or what you did.
"""


def model_settings(env: Mapping[str, str]) -> dict[str, str]:
    """Which model to use, from the same settings as Friday."""
    base_url = env.get("FRIDAY_BROWSER_BASE_URL") or env.get("EVON_BASE_URL", "")
    api_key = env.get("FRIDAY_BROWSER_API_KEY") or env.get("EVON_API_KEY", "")
    model = env.get("FRIDAY_BROWSER_MODEL") or env.get("EVON_MODEL", "")
    if not (api_key and model):
        raise ValueError("Set EVON_API_KEY and EVON_MODEL (or FRIDAY_BROWSER_*) in .env.")
    # Gemini's own API supports browser-use's structured output better than
    # its OpenAI-compatible endpoint does.
    kind = "google" if "generativelanguage.googleapis.com" in base_url else "openai"
    return {"kind": kind, "base_url": base_url, "api_key": api_key, "model": model}


def make_llm(settings: Mapping[str, str]):
    if settings["kind"] == "google":
        from browser_use.llm import ChatGoogle

        return ChatGoogle(model=settings["model"], api_key=settings["api_key"], max_retries=3)
    from browser_use.llm import ChatOpenAI

    return ChatOpenAI(
        model=settings["model"],
        api_key=settings["api_key"],
        base_url=settings["base_url"] or None,
        max_retries=3,
    )


def emit(event: dict[str, Any]) -> None:
    EVENTS.write(EVENT_PREFIX + json.dumps(event) + "\n")
    EVENTS.flush()


def step_event(n: int, state: Any, output: Any) -> dict[str, Any]:
    goal = (getattr(output, "next_goal", None) or getattr(output, "memory", None) or "").strip()
    return {"type": "step", "n": n, "goal": goal[:200], "url": getattr(state, "url", "") or ""}


async def run(request: dict[str, Any]) -> dict[str, Any]:
    from browser_use import Agent, Browser

    llm = make_llm(model_settings(os.environ))
    # keep_alive: the window belongs to friday/services and stays open after the task.
    browser = Browser(cdp_url=request["cdp_url"], keep_alive=True)
    agent = Agent(
        task=request["task"],
        llm=llm,
        browser=browser,
        extend_system_message=SAFETY,
        register_new_step_callback=lambda state, output, n: emit(step_event(n, state, output)),
        # One model call per step keeps Friday quick and within free-tier limits.
        use_judge=False,
        flash_mode=True,
        enable_signal_handler=False,
    )
    history = await agent.run(max_steps=int(request.get("max_steps", 15)))
    result = history.final_result() or ""
    return {
        "type": "done",
        "ok": bool(history.is_done() and history.is_successful() is not False),
        "result": result[:4000] or "The browser agent stopped without an answer.",
        "urls": [url for url in history.urls() if url][-5:],
        "steps": history.number_of_steps(),
    }


def main() -> None:
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
    os.environ.setdefault("BROWSER_USE_LOGGING_LEVEL", "warning")
    # browser-use logs to stdout; keep stdout for events only.
    sys.stdout = sys.stderr
    try:
        request = json.loads(sys.stdin.read())
        outcome = asyncio.run(run(request))
    except Exception as error:  # noqa: BLE001 - reported to Navigator, which tells the owner
        outcome = {"type": "done", "ok": False, "result": f"The browser agent failed: {error}"}
    emit(outcome)


if __name__ == "__main__":
    main()
