"""MCP tools for the Navigator Dot: a Chrome window on the owner's screen."""

from __future__ import annotations

from typing import Annotated, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.activity import ActivityFeed
from friday_services.browser import BrowserError, OnScreenBrowser
from friday_services.worker import Worker

ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False)
LOOK = ToolAnnotations(read_only_hint=True)
Ref = Annotated[int, Field(description="Element number from the latest page description.", ge=1)]


def build_browser_server(browser: OnScreenBrowser, worker: Worker, feed: ActivityFeed) -> MCPServer:
    server = MCPServer(
        name="friday-browser",
        instructions=(
            "A real Chrome window on the owner's screen. Each result lists the page's "
            'elements as [number] role "label"; act on them by number. Never type '
            "passwords, card numbers or OTPs, and never pay for anything."
        ),
    )

    async def act(action: str, detail: str, fn, *args) -> dict:
        feed.guard()
        event = feed.emit("navigator", action, detail)
        try:
            result = await worker.run(fn, *args)
        except BrowserError as error:
            event.state = "failed"
            feed.emit("navigator", action, str(error), state="failed")
            raise ToolError(str(error)) from error
        except Exception as error:
            feed.emit("navigator", action, f"{detail} did not work.", state="failed")
            raise ToolError(f"The browser could not do that: {error}") from error
        title = result.get("title") or result.get("url", "")
        feed.emit(
            "navigator",
            action,
            f"{detail} Now on: {title}"[:200],
            state="done",
            image=await worker.run(browser.screenshot) or None,
        )
        return result

    @server.tool(
        name="browser_open",
        description="Open a web address in the on-screen browser.",
        annotations=ACT,
    )
    async def browser_open(
        url: Annotated[str, Field(description="Web address, e.g. google.com")],
    ) -> dict:
        return await act("browser_open", f"Opening {url}.", browser.open, url)

    @server.tool(
        name="browser_snapshot",
        description="Describe the current page and its numbered elements.",
        annotations=LOOK,
    )
    async def browser_snapshot() -> dict:
        return await act("browser_snapshot", "Looking at the page.", browser.snapshot)

    @server.tool(
        name="browser_click", description="Click an element by its number.", annotations=ACT
    )
    async def browser_click(ref: Ref) -> dict:
        return await act("browser_click", f"Clicking element {ref}.", browser.click, ref)

    @server.tool(
        name="browser_type",
        description="Type text into a field by its number, optionally pressing Enter.",
        annotations=ACT,
    )
    async def browser_type(
        ref: Ref,
        text: Annotated[str, Field(max_length=2000)],
        press_enter: bool = False,
    ) -> dict:
        return await act(
            "browser_type", f'Typing "{text[:60]}".', browser.type, ref, text, press_enter
        )

    @server.tool(
        name="browser_press",
        description="Press a key such as Enter, Escape, Tab or ArrowDown.",
        annotations=ACT,
    )
    async def browser_press(key: Annotated[str, Field(max_length=30)]) -> dict:
        return await act("browser_press", f"Pressing {key}.", browser.press, key)

    @server.tool(name="browser_scroll", description="Scroll the page up or down.", annotations=ACT)
    async def browser_scroll(direction: Literal["up", "down"] = "down") -> dict:
        return await act("browser_scroll", f"Scrolling {direction}.", browser.scroll, direction)

    @server.tool(
        name="browser_read",
        description="Read the visible text of the current page.",
        annotations=LOOK,
    )
    async def browser_read() -> dict:
        return await act("browser_read", "Reading the page.", browser.read)

    @server.tool(name="browser_back", description="Go back to the previous page.", annotations=ACT)
    async def browser_back() -> dict:
        return await act("browser_back", "Going back.", browser.back)

    return server
