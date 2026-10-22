"""MCP tools for the demo calendar: check it, or add to it without a browser."""

from __future__ import annotations

from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.calendar.store import CalendarStore, InvalidEvent


def build_calendar_server(store: CalendarStore, page_url: str) -> MCPServer:
    server = MCPServer(
        name="friday-calendar",
        instructions=(
            f"The owner's demo calendar. Prefer adding events with the browser at {page_url}; "
            "use add_event only when no browser tools are available."
        ),
    )

    @server.tool(
        name="list_events",
        title="List calendar events",
        description=f"List events in the owner's demo calendar (web page: {page_url}).",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    async def list_events(
        date: Annotated[
            str | None, Field(description="Only this day, as YYYY-MM-DD. Leave out for all.")
        ] = None,
    ) -> dict:
        return {"page_url": page_url, "events": store.list(date)}

    @server.tool(
        name="add_event",
        title="Add a calendar event",
        description=(
            "Add an event to the owner's demo calendar directly. Use the browser on the "
            "calendar page instead when browser tools are available."
        ),
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
    )
    async def add_event(
        title: Annotated[str, Field(description="For example 'Dentist, Smile Clinic'.")],
        date: Annotated[str, Field(description="YYYY-MM-DD in the owner's time zone.")],
        time: Annotated[str, Field(description="24-hour HH:MM, e.g. 18:00.")],
        notes: Annotated[str, Field(description="Address, phone or other details.")] = "",
    ) -> dict:
        try:
            return {"added": store.add(title, date, time, notes, source="tool")}
        except InvalidEvent as error:
            raise ToolError(str(error)) from error

    return server
