"""Friday's own one-step actions: each says what happened in friday_say, which
Friday speaks without another model call."""

from __future__ import annotations

import httpx
import pytest

from friday_services.screen import ScreenError, describe_screen, snap_rect

from .conftest import TOKEN
from .mcp_client import McpClient

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def quick(server) -> McpClient:
    mcp = McpClient(f"{server.url}/quick/mcp", TOKEN)
    mcp.initialize()
    return mcp


def test_quick_tools_and_which_only_look(server):
    tools = quick(server).tools()
    assert set(tools) == {
        "open_app",
        "write_in_app",
        "open_website",
        "play_youtube",
        "web_search",
        "look_at_screen",
        "snap_window",
    }
    assert tools["look_at_screen"]["annotations"]["readOnlyHint"] is True
    assert tools["play_youtube"]["annotations"]["readOnlyHint"] is False


def test_open_play_and_search_say_what_happened(server):
    client = quick(server)
    opened = client.call("open_app", {"name": "notepad"})["data"]
    assert opened["friday_say"] == "Notepad is open."
    assert server.launched == ["notepad"]
    site = client.call("open_website", {"url": "example.test"})["data"]
    assert site["friday_say"] == "Opened Example."
    played = client.call("play_youtube", {"query": "lofi"})["data"]
    assert played["friday_say"] == "Playing Lo-fi beats to study to on YouTube."
    found = client.call("web_search", {"site": "youtube", "query": "lofi"})["data"]
    assert found["friday_say"] == (
        "Top results on YouTube: Lo-fi beats to study to; Lo-fi channel; Rain sounds."
    )
    feed = httpx.get(f"{server.url}/activity", headers=AUTH).json()
    events = feed["events"] if isinstance(feed, dict) else feed
    assert {e["actor"] for e in events} == {"friday"}


def test_look_and_snap(server):
    client = quick(server)
    seen = client.call("look_at_screen", {"question": "What is open?"})["data"]
    assert seen["friday_say"] == "A code editor with a Python file open."
    assert server.looked == ["What is open?"]
    placed = client.call("snap_window", {"window": "notepad", "position": "top-left"})["data"]
    assert placed["friday_say"] == "Untitled - Notepad is on the top left."
    assert server.snapped == [("notepad", "top-left")]
    bad = client.call("snap_window", {"window": "notepad", "position": "middle"})
    assert bad["isError"]


def test_stop_switch_blocks_quick_actions(server):
    httpx.post(f"{server.url}/activity/stop", headers=AUTH)
    result = quick(server).call("open_app", {"name": "notepad"})
    assert result["isError"] and "pressed stop" in result["text"]
    assert server.launched == []


def test_snap_rect_halves_and_quarters():
    work = (0, 0, 1920, 1040)
    assert snap_rect(work, "left") == (0, 0, 960, 1040)
    assert snap_rect(work, "right") == (960, 0, 960, 1040)
    assert snap_rect(work, "bottom-right") == (960, 520, 960, 520)
    assert snap_rect((1920, 0, 3840, 1080), "top-left") == (1920, 0, 960, 540)
    with pytest.raises(ScreenError):
        snap_rect(work, "middle")


ENV = {"EVON_BASE_URL": "https://model.test/v1/", "EVON_API_KEY": "k", "EVON_MODEL": "m"}


def test_describe_screen_sends_the_picture_and_reports_limits():
    sent = {}

    def answer(request: httpx.Request) -> httpx.Response:
        sent["url"] = str(request.url)
        sent["body"] = request.read().decode()
        return httpx.Response(200, json={"choices": [{"message": {"content": " A  browser. "}}]})

    text = describe_screen("aGk=", "What?", ENV, transport=httpx.MockTransport(answer))
    assert text == "A browser."
    assert sent["url"] == "https://model.test/v1/chat/completions"
    assert "data:image/jpeg;base64,aGk=" in sent["body"]
    limited = httpx.MockTransport(lambda request: httpx.Response(429))
    with pytest.raises(ScreenError, match="rate limiting"):
        describe_screen("aGk=", "What?", ENV, transport=limited)
    with pytest.raises(ScreenError, match="EVON_API_KEY"):
        describe_screen("aGk=", "What?", {})


def test_write_in_app_types_into_the_app(server):
    client = quick(server)
    written = client.call("write_in_app", {"app": "notepad", "text": "Milk\nEggs"})["data"]
    assert written["friday_say"] == "Done, it is written in Notepad."
    assert server.launched == ["notepad"]  # it was not open yet
    assert server.typed == ["Milk", "{ENTER}", "Eggs"]
