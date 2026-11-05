"""How each outside API the services use is doing, for the Admin page.

The same counts as the app's usage tracker (src/friday/server/usage.ts):
today's calls, how many worked, the last error and how long calls take, for
Twilio, Exotel, Gnani's live voice, ngrok and the small tools. Counts
reset at local midnight and survive restarts (data/usage.json). Nothing
here stores what was said.
"""

from __future__ import annotations

import functools
import inspect
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


class UsageBook:
    def __init__(self, path: Path | None = None, timezone: str = "Asia/Kolkata", clock=time.time):
        self._path = path
        self._zone = timezone
        self._clock = clock
        self._lock = threading.Lock()
        self._saved: dict[str, Any] = {"day": self._today(), "rows": {}}
        self._dirty = False

    def configure(self, path: Path, timezone: str = "Asia/Kolkata") -> None:
        """Where to keep the counts (called once by the app)."""
        with self._lock:
            self._path, self._zone = path, timezone
            try:
                loaded = json.loads(path.read_text("utf-8"))
                if loaded.get("day") == self._today() and isinstance(loaded.get("rows"), dict):
                    self._saved = loaded
            except (OSError, ValueError):
                pass

    def _today(self) -> str:
        try:
            zone = ZoneInfo(self._zone)
        except Exception:
            zone = None
        return datetime.fromtimestamp(self._clock(), zone).strftime("%Y-%m-%d")

    def _row(self, group: str, api: str, item: str) -> dict[str, Any]:
        if self._saved["day"] != self._today():
            self._saved = {"day": self._today(), "rows": {}}
        return self._saved["rows"].setdefault(
            f"{group}|{api}|{item}",
            {
                "group": group,
                "api": api,
                "item": item,
                "calls": 0,
                "ok": 0,
                "failed": 0,
                "statuses": {},
                "avgMs": None,
                "lastAt": None,
                "lastOkAt": None,
                "lastError": None,
                "restingUntil": None,
                "totalMs": 0,
                "timed": 0,
            },
        )

    def record(
        self,
        group: str,
        api: str,
        item: str = "",
        *,
        ok: bool,
        status: int | None = None,
        ms: float | None = None,
        error: str = "",
    ) -> None:
        now = int(self._clock() * 1000)
        with self._lock:
            row = self._row(group, api, item)
            row["calls"] += 1
            row["lastAt"] = now
            if status is not None:
                row["statuses"][str(status)] = row["statuses"].get(str(status), 0) + 1
            if ms is not None:
                row["totalMs"] += ms
                row["timed"] += 1
                row["avgMs"] = round(row["totalMs"] / row["timed"])
            if ok:
                row["ok"] += 1
                row["lastOkAt"] = now
            else:
                row["failed"] += 1
                row["lastError"] = {
                    "at": now,
                    "status": status,
                    "message": (error or "Failed")[:300],
                }
            self._dirty = True
        self.save()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            if self._saved["day"] != self._today():
                self._saved = {"day": self._today(), "rows": {}}
            rows = [
                {k: v for k, v in row.items() if k not in ("totalMs", "timed")}
                for row in self._saved["rows"].values()
            ]
            return {"day": self._saved["day"], "rows": rows}

    def save(self) -> None:
        with self._lock:
            if not self._path or not self._dirty:
                return
            self._dirty = False
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                self._path.write_text(json.dumps(self._saved), "utf-8")
            except OSError:
                pass  # counting must never break a call


usage = UsageBook()


class timed:
    """Counts one call: `with timed("Phone calls", "Twilio", "calls placed"):`.
    An exception inside counts as a failure and is raised again."""

    def __init__(self, group: str, api: str, item: str = ""):
        self.group, self.api, self.item = group, api, item

    def __enter__(self):
        self.started = time.monotonic()
        return self

    def __exit__(self, kind, error, _trace):
        usage.record(
            self.group,
            self.api,
            self.item,
            ok=error is None,
            ms=(time.monotonic() - self.started) * 1000,
            error=str(error) if error else "",
        )
        return False


def counted(group: str, api: str, item: str = "", ok_if=None):
    """Counts every call of a function or coroutine for the Admin page.
    ok_if(result) can mark a result that is no answer (None) as a failure."""

    def wrap(fn):
        def finish(started: float, result: Any = None, error: BaseException | None = None):
            ok = error is None and (ok_if is None or bool(ok_if(result)))
            usage.record(
                group,
                api,
                item,
                ok=ok,
                ms=(time.monotonic() - started) * 1000,
                error=str(error) if error else ("" if ok else "No answer"),
            )

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def run_async(*args, **kwargs):
                started = time.monotonic()
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as error:
                    finish(started, error=error)
                    raise
                finish(started, result)
                return result

            return run_async

        @functools.wraps(fn)
        def run(*args, **kwargs):
            started = time.monotonic()
            try:
                result = fn(*args, **kwargs)
            except BaseException as error:
                finish(started, error=error)
                raise
            finish(started, result)
            return result

        return run

    return wrap
