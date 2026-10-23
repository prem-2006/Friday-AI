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
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
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
from friday_services.organizer import (
    Notes,
    OrganizerError,
    Reminders,
    battery,
    gmail_compose_url,
    load_modes,
    lock_screen,
    maps_directions_url,
    parse_when,
    spoken_time,
    status_sentence,
    take_screenshot,
    weather,
)
from friday_services.screen import POSITIONS, Position, ScreenError
from friday_services.worker import Worker

ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False)
SENDS = ToolAnnotations(read_only_hint=False, destructive_hint=True)
LOOK = ToolAnnotations(read_only_hint=True)
FAILURES = (BrowserError, DesktopError, ScreenError, FilesError, MeetingError, OrganizerError)
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
    "directions",
    "draft_email",
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
    reminders: Reminders,
    notes: Notes,
    data_dir: Path,
    call_owner: Callable[[str], Awaitable[dict]],
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

    def time_of(text: str):
        try:
            return parse_when(text)
        except OrganizerError as error:
            raise ToolError(str(error)) from error

    @server.tool(
        name="set_timer",
        description="Set a timer; Friday says out loud when it is done.",
        annotations=ACT,
    )
    async def set_timer(
        minutes: Annotated[float, Field(gt=0, le=720)],
        label: Annotated[str, Field(max_length=120)] = "",
    ) -> dict:
        due = datetime.now() + timedelta(minutes=minutes)
        name = label or f"{minutes:g} minutes"
        await act(
            "set_timer",
            f"Timer: {name}.",
            lambda: asyncio.to_thread(reminders.add, "timer", name, due),
        )
        span = f"{minutes:g} minute{'s' if minutes != 1 else ''}"
        return {"friday_say": f"Timer set for {span}{f' for {label}' if label else ''}."}

    @server.tool(
        name="add_reminder",
        description=(
            "Remind the owner of something at a time; Friday says it out loud then. "
            "when is the owner's local time in India with no time zone, e.g. 2026-10-24T17:00."
        ),
        annotations=ACT,
    )
    async def add_reminder(
        text: Annotated[str, Field(min_length=1, max_length=200)],
        when: Annotated[str, Field(min_length=10, max_length=25)],
    ) -> dict:
        due = time_of(when)
        await act(
            "add_reminder",
            f"Reminder: {text}.",
            lambda: asyncio.to_thread(reminders.add, "reminder", text, due),
        )
        return {"friday_say": f"Okay, I'll remind you {spoken_time(due)}."}

    @server.tool(
        name="add_deadline",
        description=(
            "Save a deadline (an assignment, a bill, a project). Friday reminds the owner "
            "24 hours, 3 hours, 1 hour and 15 minutes before, and when it is due. due is "
            "the owner's local time in India with no time zone, e.g. 2026-10-24T17:00."
        ),
        annotations=ACT,
    )
    async def add_deadline(
        title: Annotated[str, Field(min_length=1, max_length=200)],
        due: Annotated[str, Field(min_length=10, max_length=25)],
    ) -> dict:
        moment = time_of(due)
        await act(
            "add_deadline",
            f"Deadline: {title}.",
            lambda: asyncio.to_thread(reminders.add, "deadline", title, moment),
        )
        return {
            "friday_say": f"Saved. {title} is due {spoken_time(moment)}; I'll remind you before."
        }

    @server.tool(
        name="list_reminders",
        description="Say what timers, reminders and deadlines are coming up.",
        annotations=LOOK,
    )
    async def list_reminders() -> dict:
        items = await asyncio.to_thread(reminders.upcoming)
        listed = [
            {
                "text": item.text,
                "kind": item.kind,
                "due": datetime.fromtimestamp(item.due).isoformat(),
            }
            for item in items
        ]
        if not items:
            say = "Nothing is coming up."
        else:
            first = "; ".join(
                f"{item.text} {spoken_time(datetime.fromtimestamp(item.due))}" for item in items[:3]
            )
            say = f"You have {len(items)} coming up: {first}."
        return {"items": listed, "friday_say": say}

    @server.tool(
        name="finish_reminder",
        description="Mark a deadline as done or cancel a reminder or timer, by its name.",
        annotations=ACT,
    )
    async def finish_reminder(title: Annotated[str, Field(min_length=1, max_length=200)]) -> dict:
        done = await asyncio.to_thread(reminders.finish, title)
        if not done:
            raise ToolError(f"Nothing called {title} is coming up.")
        feed.emit("friday", "finish_reminder", f"Done: {done.text}.", state="done")
        return {"friday_say": f"Done, {done.text} is off the list."}

    @server.tool(
        name="call_me",
        description=(
            'Phone the owner\'s own mobile, for "call me" or when the owner names '
            'themself ("call Prem"); no OK needed. Now, or at a time to remind them (when is the '
            "owner's local time in India with no time zone, e.g. 2026-10-24T17:00). Friday "
            "says why it is calling and talks briefly. message is the reminder in plain "
            "words, e.g. 'time to have your dinner'."
        ),
        annotations=ACT,
    )
    async def call_me(
        message: Annotated[str, Field(min_length=3, max_length=300)],
        when: Annotated[str, Field(max_length=25)] = "",
    ) -> dict:
        if when:
            due = time_of(when)
            await act(
                "call_me",
                f"Calling you {spoken_time(due)}: {message}",
                lambda: asyncio.to_thread(reminders.add, "call", message, due),
            )
            return {"friday_say": f"Okay, I'll call you {spoken_time(due)}."}
        feed.guard()
        placed = await call_owner(message)
        if not placed["called"]:
            raise ToolError(placed["why"])
        feed.emit("friday", "call_me", f"Calling your phone: {message}", state="done")
        return {"friday_say": "Calling your phone now."}

    @server.tool(name="take_note", description="Save a note the owner dictates.", annotations=ACT)
    async def take_note(text: Annotated[str, Field(min_length=1, max_length=2000)]) -> dict:
        await act("take_note", "Saving a note.", lambda: asyncio.to_thread(notes.add, text))
        return {"friday_say": "Noted."}

    @server.tool(name="read_notes", description="Read the latest notes aloud.", annotations=LOOK)
    async def read_notes(count: Annotated[int, Field(ge=1, le=10)] = 3) -> dict:
        latest = await asyncio.to_thread(notes.latest, count)
        say = (
            ("Your latest notes: " + "; ".join(latest) + ".")
            if latest
            else "You have no notes yet."
        )
        return {"notes": latest, "friday_say": say}

    @server.tool(name="show_notes", description="Open the notes file on screen.", annotations=ACT)
    async def show_notes() -> dict:
        if not notes.path.exists():
            raise ToolError("You have no notes yet.")
        await act(
            "show_notes",
            "Opening your notes.",
            lambda: asyncio.to_thread(open_path, str(notes.path)),
        )
        return {"friday_say": "Your notes are on screen."}

    @server.tool(
        name="run_mode",
        description=(
            "Switch the PC into a mode that opens its sites, apps and music: work, study, "
            "chill or news (more can be added in data/modes.json)."
        ),
        annotations=ACT,
    )
    async def run_mode(mode: Annotated[str, Field(min_length=1, max_length=40)]) -> dict:
        modes = load_modes(data_dir / "modes.json")
        chosen = modes.get(mode.strip().lower())
        if not chosen:
            raise ToolError(f"No {mode} mode. Modes: {', '.join(modes)}.")

        async def run():
            for app in chosen.get("apps", []):
                try:
                    await desktop_worker.run(desktop.open, app)
                except DesktopError:
                    pass  # not installed here; the rest still opens
            if chosen.get("sites"):
                await browser_worker.run(browser.open_tabs, chosen["sites"])
            if chosen.get("music"):
                await browser_worker.run(browser.play_youtube, chosen["music"])
            return {"mode": mode}

        await act("run_mode", f"{mode.title()} mode.", run)
        return {"friday_say": chosen.get("say", f"{mode.title()} mode is on.")}

    @server.tool(
        name="focus_session",
        description=(
            "Start a focus session: opens the topic's file if there is one, plays focus music "
            "and says when the time is up."
        ),
        annotations=ACT,
    )
    async def focus_session(
        minutes: Annotated[int, Field(ge=1, le=180)] = 25,
        topic: Annotated[str, Field(max_length=120)] = "",
    ) -> dict:
        async def run():
            opened = ""
            if topic:
                found = await asyncio.to_thread(find_files, topic, file_roots(), 1)
                if found:
                    await asyncio.to_thread(open_file, found[0]["path"], file_roots(), open_path)
                    opened = found[0]["name"]
            await browser_worker.run(browser.play_youtube, "lofi focus music")
            await asyncio.to_thread(
                reminders.add,
                "timer",
                f"{minutes} minute focus session{f' on {topic}' if topic else ''}; take a short break",
                datetime.now() + timedelta(minutes=minutes),
            )
            return {"opened": opened}

        done = await act("focus_session", f"Focus session: {minutes} minutes.", run)
        extra = f" I opened {done['opened']}." if done.get("opened") else ""
        return {"friday_say": f"Focus for {minutes} minutes.{extra} I'll tell you when time is up."}

    @server.tool(
        name="system_status",
        description="Say the time, the date and the battery level.",
        annotations=LOOK,
    )
    async def system_status() -> dict:
        power = await asyncio.to_thread(battery)
        return {**power, "friday_say": status_sentence(power)}

    @server.tool(
        name="lock_screen",
        description="Lock the PC. The owner approves it first.",
        annotations=SENDS,
    )
    async def lock_screen_tool() -> dict:
        await act("lock_screen", "Locking the PC.", lambda: asyncio.to_thread(lock_screen))
        return {"friday_say": "Locked."}

    @server.tool(
        name="take_screenshot",
        description="Save a screenshot of the whole screen in Pictures, Friday.",
        annotations=ACT,
    )
    async def take_screenshot_tool() -> dict:
        folder = Path.home() / "Pictures" / "Friday"
        path = await act(
            "take_screenshot",
            "Taking a screenshot.",
            lambda: asyncio.to_thread(take_screenshot, folder),
        )
        return {
            "path": str(path),
            "friday_say": "Screenshot saved in your Pictures, Friday folder.",
        }

    @server.tool(
        name="weather",
        description="Today's weather for a city, spoken.",
        annotations=LOOK,
    )
    async def weather_tool(city: Annotated[str, Field(min_length=2, max_length=80)]) -> dict:
        said = await act("weather", f"Weather in {city}.", lambda: asyncio.to_thread(weather, city))
        return {"friday_say": said}

    @server.tool(
        name="directions",
        description="Show Google Maps directions to a place in Friday's Chrome.",
        annotations=ACT,
    )
    async def directions(
        destination: Annotated[str, Field(min_length=2, max_length=200)],
        origin: Annotated[str, Field(max_length=200)] = "",
    ) -> dict:
        url = maps_directions_url(destination, origin)
        await act("directions", f"Directions to {destination}.", in_browser(browser.open), url)
        return {"friday_say": f"Directions to {destination} are on screen."}

    @server.tool(
        name="draft_email",
        description=(
            "Open a Gmail draft with these details in Friday's Chrome, not sent. Read it back "
            "to the owner; send it with send_email after their OK."
        ),
        annotations=ACT,
    )
    async def draft_email(
        to: Annotated[str, Field(max_length=300)],
        subject: Annotated[str, Field(max_length=300)],
        body: Annotated[str, Field(max_length=5000)],
    ) -> dict:
        url = gmail_compose_url(to, subject, body)
        await act("draft_email", "Writing the email draft.", in_browser(browser.open), url)
        return {"friday_say": "The draft is ready in Gmail. Shall I send it?"}

    @server.tool(
        name="schedule_meeting",
        description=(
            "Add an event to the owner's Google Calendar in Friday's Chrome, inviting guests "
            "by email. start is the owner's local time in India with no time zone, e.g. 2026-10-24T22:00 for 10 PM. The owner "
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
