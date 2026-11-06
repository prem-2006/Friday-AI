"""Counting outside API calls for the Admin page. Nothing leaves the PC."""

from __future__ import annotations

import httpx
import pytest

from friday_services.usage import UsageBook, counted, usage

from .conftest import TOKEN


def test_calls_are_counted_with_the_last_error(tmp_path):
    now = [1_800_000_000.0]
    book = UsageBook(clock=lambda: now[0])
    book.configure(tmp_path / "usage.json")
    book.record("Phone calls", "Exotel", "calls Friday places", ok=True, ms=120)
    book.record(
        "Phone calls", "Exotel", "calls Friday places", ok=False, status=402, error="No credits"
    )
    (row,) = book.snapshot()["rows"]
    assert (row["calls"], row["ok"], row["failed"], row["avgMs"]) == (2, 1, 1, 120)
    assert row["statuses"] == {"402": 1}
    assert row["lastError"]["message"] == "No credits"
    # Kept across a restart on the same day; a new day starts from zero.
    again = UsageBook(clock=lambda: now[0])
    again.configure(tmp_path / "usage.json")
    assert again.snapshot()["rows"][0]["calls"] == 2
    now[0] += 86_400
    assert again.snapshot()["rows"] == []


async def test_counted_marks_errors_and_empty_answers():
    @counted("Tools", "Test API", "lookup", ok_if=lambda found: found is not None)
    def lookup(found):
        return found

    @counted("Tools", "Test API", "async")
    async def broken():
        raise RuntimeError("down")

    lookup("yes")
    lookup(None)
    with pytest.raises(RuntimeError):
        await broken()
    rows = {r["item"]: r for r in usage.snapshot()["rows"] if r["api"] == "Test API"}
    assert (rows["lookup"]["ok"], rows["lookup"]["failed"]) == (1, 1)
    assert rows["async"]["lastError"]["message"] == "down"


def test_usage_endpoint_needs_the_token(server):
    assert httpx.get(f"{server.url}/usage").status_code == 401
    body = httpx.get(f"{server.url}/usage", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert {"day", "rows", "live"} <= set(body)
    assert {"voice_windows", "notches", "owner_calls_via", "sarvam_ready", "exotel_ready"} <= set(
        body["live"]
    )
