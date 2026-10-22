"""The demo calendar: the web page a browser fills in, and its MCP tools."""

from __future__ import annotations

import httpx
import pytest

from friday_services.calendar.store import CalendarStore, InvalidEvent

from .conftest import TOKEN
from .mcp_client import McpClient


def test_store_validates_events(tmp_path):
    store = CalendarStore(tmp_path / "calendar.json")
    for title, date, time in [
        ("", "2026-10-23", "18:00"),
        ("Dentist", "23/10/2026", "18:00"),
        ("Dentist", "2026-02-30", "18:00"),
        ("Dentist", "2026-10-23", "6 PM"),
        ("Dentist", "2026-10-23", "24:00"),
    ]:
        with pytest.raises(InvalidEvent):
            store.add(title, date, time, source="tool")
    store.add("Later", "2026-10-24", "09:00", source="tool")
    store.add("Dentist", "2026-10-23", "18:00", "Smile Clinic", source="browser")
    assert [e["title"] for e in store.list()] == ["Dentist", "Later"]
    assert [e["title"] for e in store.list("2026-10-24")] == ["Later"]


def test_browser_can_fill_in_the_calendar_page(server):
    page = httpx.get(f"{server.url}/calendar")
    assert page.status_code == 200
    for field in ('for="title"', 'type="date"', 'type="time"', 'for="notes"', "Add event"):
        assert field in page.text

    added = httpx.post(
        f"{server.url}/calendar/events",
        data={
            "title": "Dentist <b>visit</b>",
            "date": "2026-10-23",
            "time": "18:00",
            "notes": "Smile Clinic",
        },
        follow_redirects=True,
    )
    assert added.status_code == 200
    assert "Added: Dentist &lt;b&gt;visit&lt;/b&gt; on 2026-10-23 at 18:00." in added.text
    assert "<b>visit</b>" not in added.text  # escaped, never rendered as HTML

    bad = httpx.post(
        f"{server.url}/calendar/events",
        data={"title": "Dentist", "date": "2026-10-23", "time": "6pm"},
    )
    assert bad.status_code == 400 and "24-hour time" in bad.text


def test_calendar_tools(server):
    assert McpClient(f"{server.url}/calendar/mcp", None).raw("tools/list").status_code == 401
    client = McpClient(f"{server.url}/calendar/mcp", TOKEN)
    client.initialize()
    tools = client.tools()
    assert tools["list_events"]["annotations"]["readOnlyHint"] is True
    assert tools["add_event"]["annotations"]["readOnlyHint"] is False

    httpx.post(
        f"{server.url}/calendar/events",
        data={"title": "From the browser", "date": "2026-10-23", "time": "18:00"},
    )
    added = client.call(
        "add_event", {"title": "From a tool", "date": "2026-10-23", "time": "19:30"}
    )
    assert added["data"]["added"]["source"] == "tool"
    bad = client.call("add_event", {"title": "x", "date": "tomorrow", "time": "19:30"})
    assert bad["isError"] and "2026-10-23" in bad["text"]

    listed = client.call("list_events", {"date": "2026-10-23"})["data"]
    assert [(e["title"], e["source"]) for e in listed["events"]] == [
        ("From the browser", "browser"),
        ("From a tool", "tool"),
    ]
    assert listed["page_url"] == "http://127.0.0.1:8765/calendar"
