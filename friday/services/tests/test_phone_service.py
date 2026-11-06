"""The running service: the phone MCP tools and their calls."""

from __future__ import annotations

import httpx

from .conftest import TOKEN
from .mcp_client import McpClient


def phone(server, token: str | None = TOKEN) -> McpClient:
    client = McpClient(f"{server.url}/phone/mcp", token)
    return client


def test_health_reports_what_is_configured(server):
    body = httpx.get(f"{server.url}/health").json()
    assert body["calls"] == {"ready": True, "missing": []}


def test_mcp_requires_the_bearer_token(server):
    assert phone(server, token=None).raw("tools/list").status_code == 401
    assert phone(server, token="wrong-token-wrong-token-1").raw("tools/list").status_code == 401


def test_phone_tools_and_approval_hints(server):
    client = phone(server)
    assert client.initialize()["serverInfo"]["name"] == "friday-phone"
    tools = client.tools()
    assert set(tools) == {"start_call", "get_call_result", "schedule_call"}
    # OpenDots runs read-only tools directly and asks the owner before the rest.
    assert tools["start_call"]["annotations"]["readOnlyHint"] is False
    assert tools["get_call_result"]["annotations"]["readOnlyHint"] is True
    schema = tools["start_call"]["inputSchema"]
    assert set(schema["required"]) == {"phone", "goal"}
    assert schema["properties"]["language"]["default"] == "en-IN"


def test_start_call_rejects_bad_input(server):
    client = phone(server)
    bad_number = client.call("start_call", {"phone": "98123", "goal": "Book a check-up"})
    assert bad_number["isError"] and "international number" in bad_number["text"]
    bad_language = client.call(
        "start_call", {"phone": "+919812345678", "goal": "Book a check-up", "language": "fr-FR"}
    )
    assert bad_language["isError"] and "Unsupported language" in bad_language["text"]
    assert server.dialer.placed == []


def test_a_call_nobody_answers(server):
    client = phone(server)
    started = client.call("start_call", {"phone": "+919812345678", "goal": "Book a check-up"})
    assert not started["isError"], started["text"]
    call_id = started["data"]["call_id"]
    assert started["data"]["status"] == "in_progress"
    assert started["data"]["stage"] == "ringing"

    busy = client.call("start_call", {"phone": "+919800000000", "goal": "Another call"})
    assert busy["isError"] and "still in progress" in busy["text"]

    status = f"{server.url}/exotel/status/{call_id}"
    key = server.settings.get("EXOTEL_STREAM_KEY")
    assert httpx.post(status, params={"key": key}, data={"Status": "no-answer"}).status_code == 204
    result = client.call("get_call_result", {"call_id": call_id, "wait_seconds": 1})["data"]
    assert result["status"] == "no_answer" and result["summary"] == "Nobody answered."
