"""Calendar events kept in one JSON file."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import date as Date
from pathlib import Path

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class InvalidEvent(ValueError):
    pass


def check_event(title: str, date: str, time_: str, notes: str) -> dict[str, str]:
    title, notes = title.strip(), notes.strip()
    if not 1 <= len(title) <= 120:
        raise InvalidEvent("Give the event a title of up to 120 characters.")
    if not DATE.match(date):
        raise InvalidEvent("Use a date like 2026-10-23.")
    try:
        Date.fromisoformat(date)
    except ValueError as error:
        raise InvalidEvent("That date does not exist.") from error
    if not TIME.match(time_):
        raise InvalidEvent("Use a 24-hour time like 18:00.")
    if len(notes) > 500:
        raise InvalidEvent("Keep notes under 500 characters.")
    return {"title": title, "date": date, "time": time_, "notes": notes}


class CalendarStore:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()

    def _read(self) -> list[dict]:
        if not self._path.exists():
            return []
        return json.loads(self._path.read_text(encoding="utf-8"))

    def add(self, title: str, date: str, time_: str, notes: str = "", *, source: str) -> dict:
        event = {
            "id": f"evt_{uuid.uuid4().hex[:10]}",
            **check_event(title, date, time_, notes),
            "source": source,
            "created_at": time.time(),
        }
        with self._lock:
            events = self._read()
            events.append(event)
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        return event

    def list(self, date: str | None = None) -> list[dict]:
        events = [event for event in self._read() if not date or event["date"] == date]
        return sorted(events, key=lambda event: (event["date"], event["time"]))
