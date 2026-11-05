"""Calls to Friday's Twilio number, and what Friday's own calls leave behind."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from friday_services.calls.twilio import signature
from friday_services.config import Settings

from .conftest import FAKE_ENV

OWNER = "+919876543210"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # Overrides conftest's settings, so the server knows the owner's number.
    return Settings.from_env({**FAKE_ENV, "FRIDAY_OWNER_PHONE": OWNER}, data_dir=tmp_path)


def incoming(server, caller: str, *, sign: bool = True) -> httpx.Response:
    params = {"From": caller, "CallSid": "CA-in"}
    url = server.settings.public_url + "/twilio/incoming"
    headers = (
        {"X-Twilio-Signature": signature("twilio-test-auth-token", url, params)} if sign else {}
    )
    return httpx.post(f"{server.url}/twilio/incoming", data=params, headers=headers)


def the_call(server, sid: str = "CA-in"):
    calls = server.app.state.calls
    return next(call for call in calls._calls.values() if call.call_sid == sid)


def test_the_owner_calling_gets_friday_on_the_stream(server):
    answer = incoming(server, OWNER)
    assert answer.status_code == 200
    assert "wss://friday.example.test/twilio/stream" in answer.text
    call = the_call(server)
    assert call.kind == "owner_in" and "Coming up:" in call.context


def test_anyone_else_calling_gets_reception_on_the_stream(server):
    answer = incoming(server, "+911111111111")
    assert "wss://friday.example.test/twilio/stream" in answer.text
    call = the_call(server)
    assert call.kind == "reception" and "Coming up:" not in call.context


def test_a_second_caller_hears_friday_is_busy(server):
    incoming(server, OWNER)
    answer = incoming(server, "+911111111111")
    assert "<Say>Friday is on another call." in answer.text and "<Stream" not in answer.text


def test_an_unsigned_incoming_call_is_refused(server):
    assert incoming(server, OWNER, sign=False).status_code == 403


def test_through_the_tunnel_only_the_call_routes_answer(server):
    tunnel = {"x-friday-tunnel": "1"}
    assert httpx.get(f"{server.url}/health", headers=tunnel).status_code == 404
    assert httpx.post(f"{server.url}/phone/mcp", headers=tunnel).status_code == 404
    assert httpx.post(f"{server.url}/twilio/incoming", headers=tunnel).status_code == 403


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
