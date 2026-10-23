"""Friday phones its owner: for deadlines, and when asked ("call me at 5").

With INYA_API_KEY set the call goes through Gnani's Inya voice agent
(calls/inya.py): an Indian call with no trial notice, where Friday says the
reminder in its own words and keeps talking. Otherwise it uses the same
Twilio + Gnani pipeline as Friday's calls to businesses (calls/bot.py), with
the owner prompt. Calls are limited so a mistake can never ring the owner
again and again.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from friday_services.calls.inya import InyaDialer
from friday_services.calls.prompts import gnani_owner_prompt
from friday_services.calls.store import CallStore
from friday_services.config import CALL_SETTINGS, REPO_ROOT, Settings

MIN_GAP_SECONDS = 10 * 60  # at most one call every 10 minutes
MAX_PER_DAY = 8


def owner_phone(settings: Settings, profile_path: Path | None = None) -> str | None:
    """FRIDAY_OWNER_PHONE, else the phone in the main page's Your details,
    in international format (+91 added to a 10-digit Indian number)."""
    raw = settings.get("FRIDAY_OWNER_PHONE")
    if not raw:
        try:
            path = profile_path or REPO_ROOT / "data" / "friday-profile.json"
            raw = str(json.loads(path.read_text("utf-8")).get("phone") or "")
        except (OSError, ValueError):
            raw = ""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10:
        digits = "91" + digits
    return f"+{digits}" if 11 <= len(digits) <= 15 else None


class OwnerCaller:
    def __init__(
        self,
        settings: Settings,
        store: CallStore,
        dialer: Any,
        clock=time.time,
        gnani: InyaDialer | None = None,
    ):
        self._settings = settings
        self._store = store
        self._dialer = dialer
        self._clock = clock
        self._gnani = gnani
        self._calls: list[float] = []

    @property
    def uses_gnani(self) -> bool:
        return bool(self._gnani and self._gnani.ready)

    def missing(self) -> list[str]:
        missing = [] if self.uses_gnani else self._settings.missing(CALL_SETTINGS)
        if not owner_phone(self._settings):
            missing.append("your phone number (Your details, or FRIDAY_OWNER_PHONE)")
        return missing

    async def call(self, reason: str, urgent: bool = False, updates: str = "") -> dict[str, Any]:
        """Rings the owner now. Returns what happened, never raises for limits."""
        missing = self.missing()
        if missing:
            return {"called": False, "why": "Phone calls are not set up: " + ", ".join(missing)}
        now = self._clock()
        self._calls = [t for t in self._calls if now - t < 24 * 3600]
        if len(self._calls) >= MAX_PER_DAY:
            return {"called": False, "why": "I already called you 8 times today."}
        if self._calls and now - self._calls[-1] < MIN_GAP_SECONDS and not urgent:
            return {"called": False, "why": "I called you less than 10 minutes ago."}
        if self._store.active():
            return {"called": False, "why": "Another call is in progress."}
        if self.uses_gnani:
            return await self._call_with_gnani(reason, updates, now)
        record = self._store.create(
            phone=owner_phone(self._settings) or "",
            goal=reason,
            language=self._settings.get("FRIDAY_CALL_LANGUAGE", "en-IN"),
            context="",
            kind="owner",
        )
        try:
            record.twilio_sid = await self._dialer.place(record)
        except Exception as error:
            self._store.finish(record.id, "failed", error=str(error))
            return {"called": False, "why": f"The call could not be placed: {error}"}
        self._store.set_stage(record.id, "ringing")
        self._calls.append(now)
        return {"called": True, "call_id": record.id}

    async def _call_with_gnani(self, reason: str, updates: str, now: float) -> dict[str, Any]:
        assert self._gnani
        note = reason + (f"\nThe updates:\n{updates}" if updates else "")
        greeting = await self._gnani.greeting(note)
        prompt = gnani_owner_prompt(
            self._settings.owner_name, greeting, reason, updates, self._settings.timezone
        )
        try:
            await self._gnani.call(
                phone=owner_phone(self._settings) or "",
                greeting=greeting,
                prompt=prompt,
                reference=f"friday-{int(now)}",
            )
        except Exception as error:
            return {"called": False, "why": f"The call could not be placed: {error}"}
        self._calls.append(now)
        return {"called": True, "via": "gnani"}
