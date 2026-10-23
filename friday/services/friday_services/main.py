"""Friday services: MCP tools for the on-screen browser, desktop apps and
WhatsApp, a live activity feed for the voice screen, the demo calendar, and
(parked for now) Twilio phone calls."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import StreamingResponse
from pipecat.runner.utils import parse_telephony_websocket

from friday_services.activity import ActivityFeed
from friday_services.auth import BearerAuth
from friday_services.browser import BrowserError, OnScreenBrowser
from friday_services.browser_agent import BrowserAgent, agent_from_settings
from friday_services.calendar.page import add_calendar_page
from friday_services.calendar.store import CalendarStore
from friday_services.calls.bot import run_call
from friday_services.calls.store import CallStore
from friday_services.calls.twilio import (
    NOT_CONNECTED,
    TwilioDialer,
    stream_twiml,
    valid_signature,
)
from friday_services.config import CALL_SETTINGS, REPO_ROOT, Settings
from friday_services.desktop import DesktopApps, press_media_key
from friday_services.files import owner_folders
from friday_services.mcp_browser import build_browser_server
from friday_services.mcp_calendar import build_calendar_server
from friday_services.mcp_desktop import build_desktop_server, build_whatsapp_server
from friday_services.mcp_phone import Dialer, build_phone_server
from friday_services.mcp_quick import build_quick_server
from friday_services.screen import capture_screen, describe_screen, snap_window
from friday_services.whatsapp import DesktopWhatsAppUI, WhatsApp, WhatsAppUI
from friday_services.worker import Worker, com_thread

CallRunner = Callable[..., Awaitable[None]]


def create_app(
    settings: Settings | None = None,
    *,
    dialer: Dialer | None = None,
    call_runner: CallRunner = run_call,
    browser: OnScreenBrowser | None = None,
    browser_agent: BrowserAgent | None = None,
    desktop: DesktopApps | None = None,
    look: Callable[[str], str] | None = None,
    snap: Callable[[str, str], dict] | None = None,
    media_key: Callable[[str], None] | None = None,
    file_roots: Callable[[], list] | None = None,
    open_path: Callable[[str], None] | None = None,
    wake: bool = False,
    whatsapp_ui: WhatsAppUI | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if len(settings.services_token) < 24:
        raise RuntimeError(
            "Set FRIDAY_SERVICES_TOKEN in .env to a random value of 24+ characters. "
            "OpenDots sends it as the bearer token for Friday's MCP connections."
        )
    store = CallStore(settings.data_dir)
    calendar = CalendarStore(settings.data_dir / "calendar.json")
    feed = ActivityFeed()
    browser = browser or OnScreenBrowser(
        settings.data_dir / "browser-profile",
        cdp_port=settings.browser_cdp_port,
        chrome_path=settings.get("FRIDAY_CHROME_PATH") or None,
    )
    browser_agent = browser_agent or agent_from_settings(
        settings.browser_agent_dir, settings.data_dir
    )
    browser_worker = Worker("friday-browser")
    desktop_worker = Worker("friday-desktop", initializer=com_thread)
    desktop = desktop or DesktopApps()
    whatsapp = WhatsApp(whatsapp_ui or DesktopWhatsAppUI(), settings.owner_name)
    servers = {
        "/browser": build_browser_server(browser, browser_worker, feed, browser_agent),
        "/desktop": build_desktop_server(desktop, desktop_worker, feed),
        "/whatsapp": build_whatsapp_server(whatsapp, desktop_worker, feed),
        "/quick": build_quick_server(
            browser,
            browser_worker,
            desktop,
            desktop_worker,
            feed,
            look=look
            or (lambda question: describe_screen(capture_screen(), question, settings.values)),
            snap=snap or snap_window,
            media_key=media_key or press_media_key,
            file_roots=file_roots or owner_folders,
            open_path=open_path or os.startfile,
            timezone=settings.timezone,
        ),
        "/calendar": build_calendar_server(calendar, settings.calendar_url),
        "/phone": build_phone_server(store, dialer or TwilioDialer(settings), settings),
    }
    mcp_apps = {
        path: (
            server,
            server.streamable_http_app(
                streamable_http_path="/mcp", stateless_http=True, json_response=True
            ),
        )
        for path, server in servers.items()
    }

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with AsyncExitStack() as stack:
            for server, _asgi in mcp_apps.values():
                await stack.enter_async_context(server.session_manager.run())
            # The first "open an app" should not wait for the Start menu list.
            warming = asyncio.ensure_future(desktop_worker.run(desktop.warm))
            warming.add_done_callback(lambda task: task.cancelled() or task.exception())
            if wake:
                stack.callback(start_wake(settings, feed, asyncio.get_running_loop()))
            # Starting Chrome takes about five seconds; do it before the first request.
            if settings.browser_prewarm:
                opening = asyncio.ensure_future(browser_worker.run(browser.warm))
                opening.add_done_callback(lambda task: task.cancelled() or task.exception())
            yield
        for task in list(live["tasks"]):
            task.cancel()
        if live["handler"]:
            await live["handler"].close()
        try:
            await asyncio.wait_for(browser_worker.run(browser.close), 10)
        except Exception:
            pass
        browser_worker.close()
        desktop_worker.close()

    app = FastAPI(title="Friday services", lifespan=lifespan)
    app.state.settings = settings
    app.state.calls = store
    app.state.calendar = calendar
    app.state.activity = feed

    def owner(request: Request) -> None:
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {settings.services_token}"):
            raise HTTPException(status_code=401, detail="Missing or wrong bearer token.")

    @app.get("/activity", dependencies=[Depends(owner)])
    async def activity() -> dict[str, Any]:
        return {"stopped": feed.stopped, "events": feed.recent()}

    @app.get("/activity/stream", dependencies=[Depends(owner)])
    async def activity_stream(request: Request, voice: bool = False) -> StreamingResponse:
        queue = feed.listen(voice=voice)

        async def events():
            try:
                yield ": connected\n\n"
                while not await request.is_disconnected():
                    try:
                        event = await asyncio.wait_for(queue.get(), 15)
                        yield f"data: {json.dumps(event.public())}\n\n"
                    except TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                feed.unlisten(queue)

        return StreamingResponse(events(), media_type="text/event-stream")

    # The main page: Friday's Google account and one-click shortcuts.
    async def in_browser(fn, *args):
        try:
            return await browser_worker.run(fn, *args)
        except BrowserError as error:
            raise HTTPException(409, str(error)) from error
        except Exception as error:
            raise HTTPException(503, f"Friday's browser is not available: {error}") from error

    @app.get("/account/google", dependencies=[Depends(owner)])
    async def google_status() -> dict:
        return await in_browser(browser.google_account)

    @app.post("/account/google/connect", dependencies=[Depends(owner)])
    async def google_connect(request: Request) -> dict:
        body = await request.json() if await request.body() else {}
        email = str((body or {}).get("email") or "").strip() or None
        if email and ("@" not in email or len(email) > 120):
            raise HTTPException(400, "That does not look like an email address.")
        feed.emit(
            "friday", "google_sign_in", "Showing Google sign-in. Type your password yourself."
        )
        return await in_browser(browser.connect_google, email)

    @app.post("/browser/open", dependencies=[Depends(owner)])
    async def browser_open(request: Request) -> dict:
        body = await request.json()
        url = str((body or {}).get("url") or "")
        if not url.startswith(("https://", "http://")):
            raise HTTPException(400, "Send a web address starting with https://.")
        feed.emit("friday", "browser_open", f"Opening {url}.")
        page = await in_browser(browser.open, url)
        return {"url": page["url"], "title": page["title"]}

    live: dict[str, Any] = {"handler": None, "tasks": set()}

    @app.post("/voice/offer", dependencies=[Depends(owner)])
    async def voice_offer(request: Request) -> dict:
        """WebRTC offer from the voice screen: starts a live voice pipeline."""
        from pipecat.transports.smallwebrtc.request_handler import (
            SmallWebRTCRequest,
            SmallWebRTCRequestHandler,
        )

        from friday_services.live_voice import LiveVoiceSession
        from friday_services.voices import DEFAULT_LANGUAGE, voice_for

        api_key = settings.get("GNANI_API_KEY")
        if not api_key:
            raise HTTPException(503, "Set GNANI_API_KEY in .env for Friday's live voice.")
        body = await request.json()
        if not isinstance(body, dict) or "sdp" not in body or "type" not in body:
            raise HTTPException(400, "Send a WebRTC offer (sdp and type).")
        wanted = (body.get("request_data") or {}).get("language") or DEFAULT_LANGUAGE
        try:
            voice = voice_for(wanted)
        except ValueError:
            voice = voice_for(DEFAULT_LANGUAGE)
        live["handler"] = live["handler"] or SmallWebRTCRequestHandler()

        async def started(connection) -> None:
            session = LiveVoiceSession(connection, api_key, voice.code, voice.voice)
            task = asyncio.create_task(session.run(), name="friday-live-voice")
            live["tasks"].add(task)
            task.add_done_callback(live["tasks"].discard)

        return await live["handler"].handle_web_request(
            SmallWebRTCRequest(sdp=body["sdp"], type=body["type"], pc_id=body.get("pc_id")),
            started,
        )

    @app.post("/activity/stop", dependencies=[Depends(owner)])
    async def activity_stop() -> dict[str, bool]:
        feed.stop()
        return {"stopped": True}

    @app.post("/activity/resume", dependencies=[Depends(owner)])
    async def activity_resume() -> dict[str, bool]:
        feed.resume()
        return {"stopped": False}

    # Before the MCP mounts, so /calendar stays the web page and only
    # /calendar/mcp goes to the tools.
    add_calendar_page(app, calendar)

    async def twilio_params(request: Request) -> dict[str, str]:
        """Read a Twilio webhook and reject it unless Twilio signed it."""
        params = {key: str(value) for key, value in (await request.form()).items()}
        url = settings.public_url + request.url.path
        if request.url.query:
            url += f"?{request.url.query}"
        if not valid_signature(
            settings.get("TWILIO_AUTH_TOKEN"),
            url,
            params,
            request.headers.get("x-twilio-signature"),
        ):
            raise HTTPException(status_code=403, detail="Invalid Twilio signature.")
        return params

    @app.get("/health")
    async def health() -> dict[str, Any]:
        calls_missing = settings.missing(CALL_SETTINGS)
        return {
            "ok": True,
            "calls": {"ready": not calls_missing, "missing": calls_missing},
            "calendar": {"ready": True, "missing": [], "browser_url": settings.calendar_url},
        }

    @app.post("/twilio/voice/{call_id}")
    async def twilio_voice(call_id: str, request: Request) -> Response:
        await twilio_params(request)
        record = store.get(call_id)
        if not record:
            raise HTTPException(status_code=404, detail="Unknown call.")
        return Response(stream_twiml(settings, record), media_type="application/xml")

    @app.post("/twilio/status/{call_id}")
    async def twilio_status(call_id: str, request: Request) -> Response:
        params = await twilio_params(request)
        record = store.get(call_id)
        if not record:
            raise HTTPException(status_code=404, detail="Unknown call.")
        status = params.get("CallStatus", "")
        if status == "ringing":
            store.set_stage(call_id, "ringing")
        elif status in NOT_CONNECTED:
            store.finish(
                call_id,
                NOT_CONNECTED[status],
                summary="Nobody answered." if NOT_CONNECTED[status] == "no_answer" else None,
                error=None
                if NOT_CONNECTED[status] == "no_answer"
                else f"Twilio reported {status}.",
            )
        elif status == "completed" and not record.stream_started:
            store.finish(
                call_id,
                "failed",
                error="The call connected but its audio never reached Friday. Check PUBLIC_URL and the tunnel.",
            )
        return Response(status_code=204)

    @app.websocket("/twilio/stream")
    async def twilio_stream(websocket: WebSocket) -> None:
        await websocket.accept()
        provider, call_data = await parse_telephony_websocket(websocket)
        custom = call_data.get("body") or {}
        record = store.get(str(custom.get("call_id", "")))
        if (
            provider != "twilio"
            or not record
            or record.stream_started
            or not hmac.compare_digest(str(custom.get("token", "")), record.stream_token)
        ):
            await websocket.close(code=1008)
            return
        await call_runner(
            websocket,
            stream_sid=call_data["stream_id"],
            twilio_call_sid=call_data["call_id"],
            record=record,
            store=store,
            settings=settings,
        )

    for path, (_server, asgi) in mcp_apps.items():
        app.mount(path, BearerAuth(asgi, settings.services_token))
    return app


def start_wake(settings: Settings, feed: ActivityFeed, loop) -> Callable[[], None]:
    """Caps Lock push-to-talk and double-clap wake; returns how to stop them."""
    import logging
    import webbrowser

    from friday_services.wake import ClapCounter, ClapListener, PushToTalkKey

    log = logging.getLogger("friday.wake")
    stops: list[Callable[[], None]] = []

    def signal(action: str) -> None:
        loop.call_soon_threadsafe(feed.signal, action)

    def clapped() -> None:
        # Friday hears only while Caps Lock is held; a clap just brings up its screen.
        if not feed.watched:
            webbrowser.open(settings.stage_url)

    if settings.push_to_talk:
        try:
            key = PushToTalkKey(signal)
            key.start()
            stops.append(key.stop)
            print("Push-to-talk: hold Caps Lock and speak.")
        except Exception:
            log.exception("Caps Lock push-to-talk is unavailable")
    if settings.clap_wake:
        try:
            clap = ClapListener(clapped, ClapCounter(min_peak=settings.clap_level))
            clap.start()
            stops.append(clap.stop)
            print("Clap wake: clap twice to call Friday.")
        except Exception:
            log.exception("Clap wake is unavailable (no microphone?)")

    def stop() -> None:
        for halt in stops:
            try:
                halt()
            except Exception:
                pass

    return stop


def main() -> None:
    import uvicorn

    load_dotenv(REPO_ROOT / ".env")
    settings = Settings.from_env()
    uvicorn.run(
        create_app(settings, wake=True),
        host=settings.host,
        port=settings.port,
        # The voice screen's live streams never end by themselves; do not wait on them.
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
