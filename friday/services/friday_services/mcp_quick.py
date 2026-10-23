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
from pathlib import Path
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.activity import ActivityFeed
from friday_services.browser import BrowserError, OnScreenBrowser
from friday_services.desktop import DesktopApps, DesktopError
from friday_services.files import FilesError, find_files, open_file
from friday_services.meetings import MeetingError, calendar_event_url
from friday_services.screen import POSITIONS, Position, ScreenError
from friday_services.worker import Worker

ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False)
SENDS = ToolAnnotations(read_only_hint=False, destructive_hint=True)
LOOK = ToolAnnotations(read_only_hint=True)
FAILURES = (BrowserError, DesktopError, ScreenError, FilesError, MeetingError)
MediaAction = Literal["pause", "play", "next", "previous", "volume_up", "volume_down", "mute"]
MEDIA_SAID = {
    "pause": "Paused.",
    "play": "Playing.",
    "next": "Next one.",
    "previous": "Going back.",
    "volume_up": "Louder.",
    "volume_down": "Quieter.",
    "mute": "Sound toggled.",
}
IN_BROWSER = {
    "open_website",
    "play_youtube",
    "browser_search",
    "send_email",
    "schedule_meeting",
}


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
    media_key: Callable[[str], None],
    file_roots: Callable[[], list[Path]],
    open_path: Callable[[str], None],
    timezone: str = "Asia/Kolkata",
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
        replace: Annotated[
            bool, Field(description="True to replace everything already in the app with text.")
        ] = False,
    ) -> dict:
        written = await act(
            "write_in_app",
            f"Writing in {app}…",
            lambda: desktop_worker.run(desktop.write, app, text, replace),
        )
        return {**written, "friday_say": f"Done, it is written in {written['app']}."}

    @server.tool(
        name="clear_in_app",
        description="Remove all the text in an app's window, e.g. clear Notepad.",
        annotations=ACT,
    )
    async def clear_in_app(app: Annotated[str, Field(min_length=1, max_length=80)]) -> dict:
        cleared = await act(
            "clear_in_app", f"Clearing {app}…", lambda: desktop_worker.run(desktop.clear, app)
        )
        return {**cleared, "friday_say": f"{cleared['app']} is cleared."}

    @server.tool(
        name="press_keys_in_app",
        description=(
            "Press keys in an app's window: Ctrl+S to save, Ctrl+Z to undo, Ctrl+Y to redo, "
            "Enter, Escape, Ctrl+N for new and so on."
        ),
        annotations=ACT,
    )
    async def press_keys_in_app(
        app: Annotated[str, Field(min_length=1, max_length=80)],
        keys: Annotated[list[str], Field(min_length=1, max_length=10)],
    ) -> dict:
        pressed = await act(
            "press_keys_in_app",
            f"Pressing {', '.join(keys)} in {app}.",
            lambda: desktop_worker.run(desktop.keys_in, app, keys),
        )
        return {**pressed, "friday_say": "Done."}

    @server.tool(
        name="media_control",
        description=(
            "Control what is playing: pause, play, next, previous, volume_up, volume_down "
            "or mute. Works on Friday's YouTube tab, otherwise on any player (YouTube app, "
            "Spotify) through the media keys."
        ),
        annotations=ACT,
    )
    async def media_control(action: MediaAction) -> dict:
        async def run():
            video = await browser_worker.run(browser.youtube_control, action)
            if video is not None:
                return video
            await desktop_worker.run(media_key, action)
            return {"media_key": action}

        done = await act("media_control", f"Media: {action.replace('_', ' ')}.", run)
        return {**done, "friday_say": MEDIA_SAID[action]}

    @server.tool(
        name="find_files",
        description=(
            "Find files on the owner's PC by name (Desktop, Documents, Downloads, Pictures, "
            "Music, Videos), newest first."
        ),
        annotations=LOOK,
    )
    async def find_files_tool(query: Annotated[str, Field(min_length=1, max_length=120)]) -> dict:
        found = await act(
            "find_files",
            f'Looking for "{query}" in your files.',
            lambda: asyncio.to_thread(find_files, query, file_roots()),
        )
        names = [item["name"] for item in found[:3]]
        say = (
            f"I found {len(found)}: " + "; ".join(names) + "."
            if found
            else f'No file named like "{query}" in your folders.'
        )
        return {"files": found, "friday_say": say}

    @server.tool(
        name="open_file",
        description="Open a file that find_files found, by its full path, in its usual app.",
        annotations=ACT,
    )
    async def open_file_tool(path: Annotated[str, Field(min_length=3, max_length=600)]) -> dict:
        opened = await act(
            "open_file",
            "Opening the file…",
            lambda: asyncio.to_thread(open_file, path, file_roots(), open_path),
        )
        return {**opened, "friday_say": f"Opened {opened['opened']}."}

    @server.tool(
        name="schedule_meeting",
        description=(
            "Add an event to the owner's Google Calendar in Friday's Chrome, inviting guests "
            "by email. start is local date and time, e.g. 2026-10-24T15:00. The owner "
            "approves every meeting before it is saved and invitations go out."
        ),
        annotations=SENDS,
    )
    async def schedule_meeting(
        title: Annotated[str, Field(min_length=1, max_length=200)],
        start: Annotated[str, Field(min_length=10, max_length=25)],
        minutes: Annotated[int, Field(ge=5, le=1440)] = 30,
        guests: Annotated[list[str], Field(max_length=20)] = [],  # noqa: B006
        details: Annotated[str, Field(max_length=2000)] = "",
    ) -> dict:
        try:
            url = calendar_event_url(title, start, minutes, guests, details, timezone)
        except MeetingError as error:
            raise ToolError(str(error)) from error
        saved = await act(
            "schedule_meeting",
            f"Scheduling {title}…",
            in_browser(browser.schedule_meeting),
            url,
            bool(guests),
        )
        say = (
            f"{title} is on your calendar"
            + (
                f", and {len(guests)} invitation{'s' if len(guests) > 1 else ''} sent."
                if guests
                else "."
            )
            if saved.get("saved")
            else "I filled in the meeting, but Calendar did not confirm it was saved."
        )
        return {**saved, "friday_say": say}

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
        name="send_email",
        description=(
            "Send the email draft that is open in Gmail in the on-screen browser. First have "
            "Navigator prepare the draft and read it back to the owner; the owner approves "
            "every send."
        ),
        annotations=SENDS,
    )
    async def send_email() -> dict:
        sent = await act("send_email", "Sending the email…", in_browser(browser.send_open_email))
        say = (
            "The email is sent."
            if sent.get("sent")
            else "I clicked Send; Gmail has not confirmed yet."
        )
        return {**sent, "friday_say": say}

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
