"""Calls to Friday's Exotel number, and what Friday's own calls leave behind."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from friday_services.config import Settings

from .conftest import FAKE_ENV
from .test_exotel import KEY, stream

OWNER = "+919876543210"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # Overrides conftest's settings, so the server knows the owner's number.
    return Settings.from_env({**FAKE_ENV, "FRIDAY_OWNER_PHONE": OWNER}, data_dir=tmp_path)


def test_a_caller_hears_nothing_while_friday_is_on_another_call(server):
    store = server.app.state.calls
    talking = store.create(phone="+911111111111", goal="Book", language="en-IN", context="")
    talking.stream_started = True  # its audio is already flowing
    assert stream(server, KEY, "in-busy", "09876543210") == 1008
    assert server.call.runs == []


def test_through_the_tunnel_only_the_call_routes_answer(server):
    tunnel = {"x-friday-tunnel": "1"}
    assert httpx.get(f"{server.url}/health", headers=tunnel).status_code == 404
    assert httpx.post(f"{server.url}/phone/mcp", headers=tunnel).status_code == 404
    assert httpx.post(f"{server.url}/exotel/status/x", headers=tunnel).status_code == 403
    assert httpx.post(f"{server.url}/phone/ask", headers=tunnel).status_code == 401


def test_recent_calls_come_from_fridays_own_records(server):
    store = server.app.state.calls
    call = store.create(phone=OWNER, goal="Remind", language="en-IN", context="", kind="owner")
    store.add_turn(call.id, "friday", "Hi, it's Friday.")
    store.add_turn(call.id, "them", "Thanks.")
    store.finish(call.id, "answered", outcome="completed", summary="Reminded.")
    headers = {"Authorization": f"Bearer {FAKE_ENV['FRIDAY_SERVICES_TOKEN']}"}
    recent = httpx.get(f"{server.url}/calls/recent", headers=headers).json()
    assert recent[0]["who"] == "You" and recent[0]["ended_by"] == "completed"
    assert recent[0]["lines"] == [
        {"who": "Friday", "text": "Hi, it's Friday."},
        {"who": "Them", "text": "Thanks."},
    ]
