"""What the helper Dots are doing right now, streamed to Friday's voice screen,
plus the owner's stop switch for every on-screen action."""

from __future__ import annotations

import asyncio
import itertools
import time
from collections import deque
from dataclasses import asdict, dataclass, field

from mcp.server.mcpserver.exceptions import ToolError


@dataclass
class Activity:
    id: int
    actor: str  # navigator | operator | friday
    action: str  # e.g. browser_open
    detail: str  # one short human sentence
    state: str = "running"  # running | done | failed
    image: str | None = None  # base64 JPEG of the screen after the action
    at: float = field(default_factory=time.time)

    def public(self) -> dict:
        return asdict(self)


class ActivityFeed:
    def __init__(self, keep: int = 200):
        self._events: deque[Activity] = deque(maxlen=keep)
        self._listeners: set[asyncio.Queue[Activity]] = set()
        # Voice windows (the voice screen, the desktop notch), oldest first.
        # Caps Lock goes to the newest only, so one request never runs twice.
        self._voices: list[asyncio.Queue[Activity]] = []
        self._ids = itertools.count(1)
        self.stopped = False

    def emit(self, actor: str, action: str, detail: str, **fields) -> Activity:
        event = Activity(next(self._ids), actor, action, detail, **fields)
        self._events.append(event)
        for queue in list(self._listeners):
            queue.put_nowait(event)
        return event

    def signal(self, action: str) -> None:
        """Tell the voice screen to do something (e.g. ptt_down, wake). Not kept
        in the history, so a page that connects later never replays it."""
        event = Activity(next(self._ids), "control", action, "", state="done")
        if self._voices:
            self._voices[-1].put_nowait(event)

    @property
    def watched(self) -> bool:
        """Whether a voice window is connected right now."""
        return bool(self._voices)

    def recent(self, limit: int = 30) -> list[dict]:
        return [event.public() for event in list(self._events)[-limit:]]

    def listen(self, voice: bool = False) -> asyncio.Queue[Activity]:
        queue: asyncio.Queue[Activity] = asyncio.Queue()
        self._listeners.add(queue)
        if voice:
            self._voices.append(queue)
        return queue

    def unlisten(self, queue: asyncio.Queue[Activity]) -> None:
        self._listeners.discard(queue)
        if queue in self._voices:
            self._voices.remove(queue)

    def stop(self) -> None:
        self.stopped = True
        self.emit("friday", "stop", "You stopped all on-screen actions.", state="done")

    def resume(self) -> None:
        self.stopped = False
        self.emit("friday", "resume", "On-screen actions are allowed again.", state="done")

    def guard(self) -> None:
        if self.stopped:
            raise ToolError(
                "The owner pressed stop. Do nothing more on screen and tell the owner what was done so far."
            )
