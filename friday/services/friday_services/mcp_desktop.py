"""MCP tools for desktop apps (Operator Dot) and WhatsApp (Friday itself)."""

from __future__ import annotations

from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.activity import ActivityFeed
from friday_services.desktop import DesktopApps, DesktopError
from friday_services.whatsapp import WhatsApp, WhatsAppError
from friday_services.worker import Worker

ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False)
LOOK = ToolAnnotations(read_only_hint=True)
Ref = Annotated[int, Field(description="Control number from the latest window snapshot.", ge=1)]


async def _run(
    feed: ActivityFeed, worker: Worker, actor: str, action: str, detail: str, fn, *args, image=None
):
    feed.guard()
    feed.emit(actor, action, detail)
    try:
        result = await worker.run(fn, *args)
    except (DesktopError, WhatsAppError) as error:
        feed.emit(actor, action, str(error), state="failed")
        raise ToolError(str(error)) from error
    except Exception as error:
        feed.emit(actor, action, f"{detail} did not work.", state="failed")
        raise ToolError(f"The desktop could not do that: {error}") from error
    shot = await worker.run(image) if image else None
    feed.emit(actor, action, detail.replace("…", "") + " Done.", state="done", image=shot or None)
    return result


def build_desktop_server(apps: DesktopApps, worker: Worker, feed: ActivityFeed) -> MCPServer:
    server = MCPServer(
        name="friday-desktop",
        instructions=(
            "Apps on the owner's Windows PC. Open an app, snapshot its window to get "
            "numbered controls, then click or type by number. WhatsApp is not available "
            "here. Never type passwords and never pay for anything."
        ),
    )

    def run(action: str, detail: str, fn, *args):
        return _run(feed, worker, "operator", action, detail, fn, *args, image=apps.screenshot)

    @server.tool(
        name="list_apps",
        description="List installed apps, optionally filtered by name.",
        annotations=LOOK,
    )
    async def list_apps(query: str = "") -> dict:
        return {"apps": await run("list_apps", "Checking installed apps…", apps.apps, query)}

    @server.tool(
        name="open_app",
        description="Open an installed app by name, e.g. Notepad or Calculator.",
        annotations=ACT,
    )
    async def open_app(name: Annotated[str, Field(max_length=100)]) -> dict:
        return await run("open_app", f"Opening {name}…", apps.open, name)

    @server.tool(
        name="list_windows", description="List the open windows by title.", annotations=LOOK
    )
    async def list_windows() -> dict:
        return {"windows": await run("list_windows", "Looking at open windows…", apps.windows)}

    @server.tool(
        name="window_snapshot",
        description="Bring a window to the front and list its controls as numbers.",
        annotations=LOOK,
    )
    async def window_snapshot(
        window: Annotated[str, Field(description="Window title or part of it.")],
    ) -> dict:
        return await run("window_snapshot", f"Looking at {window}…", apps.snapshot, window)

    @server.tool(name="window_click", description="Click a control by its number.", annotations=ACT)
    async def window_click(ref: Ref) -> dict:
        return await run("window_click", f"Clicking control {ref}…", apps.click, ref)

    @server.tool(
        name="window_type", description="Type text into a control by its number.", annotations=ACT
    )
    async def window_type(
        ref: Ref, text: Annotated[str, Field(max_length=4000)], press_enter: bool = False
    ) -> dict:
        return await run("window_type", f'Typing "{text[:60]}"…', apps.type, ref, text, press_enter)

    @server.tool(
        name="press_keys",
        description="Press keys in the front window, e.g. Enter or Ctrl+S.",
        annotations=ACT,
    )
    async def press_keys(keys: Annotated[str, Field(max_length=40)]) -> dict:
        return await run("press_keys", f"Pressing {keys}…", apps.press, keys)

    return server


def build_whatsapp_server(whatsapp: WhatsApp, worker: Worker, feed: ActivityFeed) -> MCPServer:
    server = MCPServer(
        name="friday-whatsapp",
        instructions=(
            "WhatsApp Desktop on the owner's PC. Sending and calling always need the owner's "
            "OK. Calls ring on the owner's PC and the owner does the talking."
        ),
    )

    def run(action: str, detail: str, fn, *args):
        return _run(feed, worker, "friday", action, detail, fn, *args)

    @server.tool(
        name="whatsapp_find_chat",
        description="Check that a WhatsApp chat exists and open it, without sending anything.",
        annotations=LOOK,
    )
    async def whatsapp_find_chat(
        contact: Annotated[str, Field(description="Saved contact name or phone number.")],
    ) -> dict:
        chat = await run(
            "whatsapp_find_chat", f"Finding {contact} on WhatsApp…", whatsapp.open_chat, contact
        )
        return {"chat": chat}

    @server.tool(
        name="whatsapp_send_message",
        description=(
            "Send a WhatsApp message from the owner's account. The message is signed as sent by "
            "Friday, the owner's AI assistant, unless sign is false."
        ),
        annotations=ACT,
    )
    async def whatsapp_send_message(
        contact: Annotated[str, Field(description="Saved contact name or phone number.")],
        text: Annotated[str, Field(min_length=1, max_length=2000)],
        sign: bool = True,
    ) -> dict:
        return await run(
            "whatsapp_send_message",
            f"Sending a WhatsApp message to {contact}…",
            whatsapp.send,
            contact,
            text,
            sign,
        )

    @server.tool(
        name="whatsapp_call",
        description="Start a WhatsApp voice or video call; the owner talks on their PC.",
        annotations=ACT,
    )
    async def whatsapp_call(
        contact: Annotated[str, Field(description="Saved contact name or phone number.")],
        video: bool = False,
    ) -> dict:
        kind = "video" if video else "voice"
        return await run(
            "whatsapp_call",
            f"Starting a WhatsApp {kind} call with {contact}…",
            whatsapp.call,
            contact,
            video,
        )

    return server
