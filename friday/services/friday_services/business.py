"""Friday for the owner's business: client calls in any Indian language.

On a client call Friday answers questions about the business, sells what
fits, books meetings into the calendar and saves every caller as a lead.
What it may say comes only from the business profile the owner writes
(friday/business.md, or FRIDAY_BUSINESS_PROFILE); FRIDAY_BUSINESS=true turns
it on for calls to Friday's number from anyone but the owner.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from friday_services.config import REPO_ROOT

PROFILE = REPO_ROOT / "friday" / "business.md"
# Notes for the owner in the profile file: never read out on a call.
COMMENTS = re.compile(r"<!--.*?-->", re.S)
# The template's blanks: a profile still full of them is not filled in.
BLANK = re.compile(r"\[[^\]]*fill in[^\]]*\]", re.I)


def profile_text(path: Path | None = None) -> str:
    try:
        text = (path or PROFILE).read_text(encoding="utf-8")
    except OSError:
        return ""
    text = COMMENTS.sub("", text).strip()
    return "" if not text or BLANK.search(text) else text


def business_profile(settings: Any) -> str:
    custom = settings.get("FRIDAY_BUSINESS_PROFILE")
    path = Path(custom) if custom else None
    if path is not None and not path.is_absolute():
        path = REPO_ROOT / path  # "friday/business.demo.md", from the repo
    return profile_text(path)


def business_enabled(settings: Any) -> bool:
    on = settings.get("FRIDAY_BUSINESS", "false").lower() == "true"
    return on and bool(business_profile(settings))


def busy_times(calendar: Any, timezone: str, days: int = 7, now: datetime | None = None) -> str:
    """The owner's calendar for the coming days, so a call never books over it."""
    today = (now or datetime.now(ZoneInfo(timezone))).date()
    lines = []
    for event in calendar.list():
        try:
            day = datetime.strptime(event["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if today <= day <= today + timedelta(days=days):
            lines.append(f"- {event['date']} {event.get('time', '')}: busy")
    return "\n".join(lines) or "- nothing booked"


def client_context(settings: Any, calendar: Any, who: str = "") -> str:
    parts = [business_profile(settings)]
    if who:
        parts.append(f"On the line: {who}.")
    parts.append(
        "Already booked in the next 7 days (offer other times):\n"
        + busy_times(calendar, settings.timezone)
    )
    return "\n\n".join(part for part in parts if part)


def slot_taken(calendar: Any, date: str, time_: str) -> bool:
    return any(event.get("time") == time_ for event in calendar.list(date))


class Leads:
    """Everyone a client call talked to, newest last (data/friday-leads.json)."""

    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()

    def _read(self) -> list[dict]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return data if isinstance(data, list) else []

    def add(self, **fields: str) -> dict:
        lead = {
            "id": f"lead_{uuid.uuid4().hex[:10]}",
            **{k: str(v).strip()[:500] for k, v in fields.items() if str(v or "").strip()},
            "at": time.time(),
        }
        with self._lock:
            leads = self._read()
            leads.append(lead)
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(leads, ensure_ascii=False, indent=2), encoding="utf-8")
        return lead

    def recent(self, count: int = 10) -> list[dict]:
        return self._read()[-count:]


def lead_line(lead: dict) -> str:
    who = lead.get("name") or lead.get("phone") or "Someone"
    want = lead.get("interest") or "no details"
    step = f"; next: {lead['next_step']}" if lead.get("next_step") else ""
    return f"{who}: {want}{step}"
