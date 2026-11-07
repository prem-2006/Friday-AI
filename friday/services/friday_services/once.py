"""The same action asked for twice within a few seconds runs once.

Friday hears a sentence in pieces now and then, and a request that arrives
while another is running replaces it; both can make the model ask for an
action the first run already did ("Notepad is open" twice, a message sent
twice). Each tool server's call_tool goes through this guard, so the second
identical call gets the first one's result instead of doing it again.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

# How long an identical call counts as the same request.
WINDOW_SECS = 12.0
# Asked again on purpose ("louder", "louder"), or only reading something
# that may have changed since: never held back.
REPEATABLE = frozenset(
    {
        "media_control",
        "youtube_control",
        "press_keys_in_app",
        "press_keys",
        "system_status",
        "time_of",
        "look_at_screen",
        "take_screenshot_tool",
        "window_snapshot",
        "list_windows",
        "list_apps",
        "list_reminders",
        "read_notes",
        "show_notes",
        "weather_tool",
        "daily_briefing",
        "get_call_result",
        "phone_screen",
        "meeting_question",
        "who_is_this",
        "list_people",
        "point_and_ask",
    }
)


def repeatable(name: str, args: dict[str, Any]) -> bool:
    if name in REPEATABLE:
        return True
    # "Volume up" twice is two steps; "volume 40" twice is one.
    return name == "set_volume" and args.get("change") not in (None, 0)


class Once:
    def __init__(self, window: float = WINDOW_SECS, clock: Callable[[], float] = time.monotonic):
        self.window = window
        self.clock = clock
        self._recent: dict[str, tuple[float, asyncio.Future]] = {}

    async def run(self, name: str, args: dict[str, Any], call: Callable[[], Awaitable[Any]]):
        if repeatable(name, args):
            return await call()
        key = f"{name} {json.dumps(args, sort_keys=True, default=str)}"
        now = self.clock()
        for old, (at, _) in list(self._recent.items()):
            if now - at >= self.window:
                del self._recent[old]
        earlier = self._recent.get(key)
        if earlier:
            return await asyncio.shield(earlier[1])
        result: asyncio.Future = asyncio.get_running_loop().create_future()
        self._recent[key] = (now, result)
        try:
            value = await call()
        except BaseException as error:
            # A failed or cancelled call may be tried again at once.
            self._recent.pop(key, None)
            if not result.done():
                result.set_exception(error)
                result.exception()  # retrieved: nobody else may be waiting
            raise
        if _failed(value):
            self._recent.pop(key, None)
        result.set_result(value)
        return value


def _failed(value: Any) -> bool:
    return bool(getattr(value, "is_error", False) or getattr(value, "isError", False))


def guard_repeats(server: Any, once: Once | None = None) -> Any:
    """Routes the server's tool calls (MCP requests and direct ones) through Once."""
    once = once or Once()
    call_tool = server.call_tool

    async def guarded(name: str, arguments: dict[str, Any], *rest: Any, **kw: Any):
        return await once.run(
            name, dict(arguments or {}), lambda: call_tool(name, arguments, *rest, **kw)
        )

    server.call_tool = guarded
    return server
