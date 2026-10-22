"""MCP tools for Friday itself: one-step actions without handing work to a helper.

Handing a task to Navigator or Operator costs two or three extra model calls
(5 to 8 seconds). Opening an app or a site, playing a video, a quick search,
looking at the screen and arranging windows need none of that, so Friday does
them directly. Each result carries "friday_say": the sentence Friday speaks,
which also ends the turn without another model call (see
src/friday/server/quick-finish.ts).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.activity import ActivityFeed
from friday_services.browser import BrowserError, OnScreenBrowser
from friday_services.desktop import DesktopApps, DesktopError
from friday_services.screen import POSITIONS, Position, ScreenError
from friday_services.worker import Worker

ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False)
LOOK = ToolAnnotations(read_only_hint=True)
FAILURES = (BrowserError, DesktopError, ScreenError)
IN_BROWSER = {"open_website", "play_youtube", "browser_search"}


def _short(title: str, limit: int = 70) -> str:
    title = " ".join(title.split())
    return title if len(title) <= limit else title[: limit - 1].rstrip() + "…"


def build_quick_server(
    browser: OnScreenBrowser,
    browser_worker: Worker,
    desktop: DesktopApps,
    desktop_worker: Worker,
    feed: ActivityFeed,
    look: Callable[[str], str],
    snap: Callable[[str, str], dict[str, Any]],
) -> MCPServer:
    server = MCPServer(
        name="friday-quick",
        instructions=(
            "Friday's own one-step actions on the owner's PC. Each result's friday_say is "
            "spoken to the owner as is."
        ),
    )

    async def act(action: str, detail: str, run, *args) -> Any:
        feed.guard()
        feed.emit("friday", action, detail)
        try:
            result = await run(*args)
        except FAILURES as error:
            feed.emit("friday", action, str(error), state="failed")
            raise ToolError(str(error)) from error
        except Exception as error:
            feed.emit("friday", action, f"{detail} did not work.", state="failed")
            raise ToolError(f"That did not work: {error}") from error
        # The voice screen shows the page for browser actions.
        image = await browser_worker.run(browser.screenshot) if action in IN_BROWSER else ""
        feed.emit("friday", action, f"{detail} Done.", state="done", image=image or None)
        return result

    def in_browser(fn):
        return lambda *args: browser_worker.run(fn, *args)

    @server.tool(
        name="open_app",
        description="Open a Windows app by name, e.g. Notepad, Calculator, Spotify, VS Code.",
        annotations=ACT,
    )
    async def open_app(name: Annotated[str, Field(min_length=1, max_length=80)]) -> dict:
        opened = await act(
            "open_app",
            f"Opening {name}…",
            lambda: desktop_worker.run(desktop.open, name),
        )
        return {**opened, "friday_say": f"{opened['opened']} is open."}

    @server.tool(
        name="write_in_app",
        description=(
            "Type text into a Windows app, e.g. a shopping list into Notepad. Uses the "
            "app's open window, or opens the app first. Put each line on its own line."
        ),
        annotations=ACT,
    )
    async def write_in_app(
        app: Annotated[str, Field(min_length=1, max_length=80)],
        text: Annotated[str, Field(min_length=1, max_length=4000)],
    ) -> dict:
        written = await act(
            "write_in_app",
            f"Writing in {app}…",
            lambda: desktop_worker.run(desktop.write, app, text),
        )
        return {**written, "friday_say": f"Done, it is written in {written['app']}."}

    @server.tool(
        name="open_website",
        description="Open a website in the on-screen browser, e.g. gmail.com or irctc.co.in.",
        annotations=ACT,
    )
    async def open_website(url: Annotated[str, Field(min_length=3, max_length=500)]) -> dict:
        page = await act("open_website", f"Opening {url}.", in_browser(browser.open), url)
        return {
            "url": page["url"],
            "title": page["title"],
            "friday_say": f"Opened {_short(page['title'] or url)}.",
        }

    @server.tool(
        name="play_youtube",
        description="Play a song, video or topic on YouTube in the on-screen browser.",
        annotations=ACT,
    )
    async def play_youtube(query: Annotated[str, Field(min_length=1, max_length=200)]) -> dict:
        video = await act(
            "play_youtube",
            f'Playing "{query}" on YouTube.',
            in_browser(browser.play_youtube),
            query,
        )
        return {**video, "friday_say": f"Playing {_short(video['title'])} on YouTube."}

    @server.tool(
        name="web_search",
        description=(
            "Search YouTube or Google in the on-screen browser and name the top results. "
            "Use youtube for videos, channels, songs, tutorials or anything said to be on "
            "YouTube; google for everything else."
        ),
        annotations=ACT,
    )
    async def web_search(
        site: Literal["youtube", "google"],
        query: Annotated[str, Field(min_length=1, max_length=300)],
    ) -> dict:
        name = "YouTube" if site == "youtube" else "Google"
        found = await act(
            "browser_search",
            f'Searching {name} for "{query}".',
            in_browser(browser.search),
            site,
            query,
        )
        top = [_short(result["title"], 60) for result in found["results"][:3]]
        say = (
            f"Top results on {found['site']}: " + "; ".join(top) + "."
            if top
            else f"The results are on screen in {found['site']}."
        )
        return {"results": found["results"][:5], "friday_say": say}

    @server.tool(
        name="look_at_screen",
        description=(
            "Look at the owner's screen and answer a question about it, e.g. "
            "'What is on my screen?' or 'What does this error say?'"
        ),
        annotations=LOOK,
    )
    async def look_at_screen(
        question: Annotated[str, Field(max_length=300)] = "What is on the screen?",
    ) -> dict:
        answer = await act(
            "look_at_screen", "Looking at your screen…", lambda: asyncio.to_thread(look, question)
        )
        return {"answer": answer, "friday_say": answer}

    @server.tool(
        name="snap_window",
        description=(
            "Move an open window to a half or quarter of its screen, or maximize or "
            f"minimize it. Positions: {', '.join(POSITIONS)}."
        ),
        annotations=ACT,
    )
    async def snap_window(
        window: Annotated[
            str, Field(min_length=1, max_length=120, description="Part of its title")
        ],
        position: Position,
    ) -> dict:
        placed = await act(
            "snap_window",
            f"Moving {window} to the {position}.",
            lambda: asyncio.to_thread(snap, window, position),
        )
        where = {"maximize": "maximized", "minimize": "minimized"}.get(
            position, f"on the {position.replace('-', ' ')}"
        )
        return {**placed, "friday_say": f"{_short(placed['window'], 40)} is {where}."}

    return server
