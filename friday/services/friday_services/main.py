"""Friday services: MCP tools for the on-screen browser, desktop apps and
WhatsApp, a live activity feed for the voice screen, the demo calendar, and
(parked for now) Twilio phone calls."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime
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
from friday_services.calls.inya import InyaDialer
from friday_services.calls.sarvam import SarvamDialer, recent_conversations
from friday_services.calls.store import CallStore
from friday_services.calls.twilio import (
    NOT_CONNECTED,
    TwilioDialer,
    point_number_at,
    stream_twiml,
    valid_signature,
)
from friday_services.config import CALL_SETTINGS, REPO_ROOT, Settings
from friday_services.desktop import DesktopApps, press_media_key
from friday_services.files import owner_folders
from friday_services.mcp_browser import build_browser_server
from friday_services.mcp_calendar import build_calendar_server
from friday_services.mcp_desktop import build_desktop_server, build_whatsapp_server
from friday_services.mcp_phone import Dialer, build_phone_server, call_someone
from friday_services.mcp_quick import build_quick_server
from friday_services.organizer import (
    Notes,
    OrganizerError,
    Reminders,
    parse_when,
    speak_with_windows,
    spoken_time,
)
from friday_services.owner_calls import OwnerCaller, owner_phone
from friday_services.screen import capture_screen, describe_screen, snap_window
from friday_services.tunnel import QuickTunnel, TunnelGuard
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
    tunnel: bool = False,
    speak: Callable[[str], None] | None = None,
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
    dialer = dialer or TwilioDialer(settings)
    owner_caller = OwnerCaller(
        settings, store, dialer, gnani=InyaDialer(settings), sarvam=SarvamDialer(settings)
    )
    ringing_back: set[asyncio.Task] = set()
    reminders = Reminders(settings.data_dir / "reminders.json")
    notes = Notes(settings.data_dir / "notes.txt")
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
            reminders=reminders,
            notes=notes,
            call_owner=owner_caller.call,
            data_dir=settings.data_dir,
            timezone=settings.timezone,
        ),
        "/calendar": build_calendar_server(calendar, settings.calendar_url),
        "/phone": build_phone_server(
            store, dialer, settings, sarvam=SarvamDialer(settings), reminders=reminders
        ),
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

    # Timers, reminders and deadlines: Friday says them when they come due, on
    # the voice screen or the notch, or with Windows' voice if neither is open.
    def announce(text: str) -> None:
        feed.emit("friday", "reminder", text, state="done")
        if feed.watched:
            feed.signal("announce", text)
        else:
            (speak or speak_with_windows)(text)

    # Friday also phones the owner: for a "call me" request, and for deadlines
    # an hour and 15 minutes before and when due (FRIDAY_CALL_DEADLINES=false
    # turns that off).
    def should_call(due) -> bool:
        if due.kind == "call":
            return True
        calls_for_deadlines = settings.get("FRIDAY_CALL_DEADLINES", "true").lower() != "false"
        return due.kind == "deadline" and calls_for_deadlines and due.minutes_left <= 60

    async def place_contact_call(due) -> None:
        """A call to someone else that was scheduled for now."""
        who = due.extra.get("name") or due.extra.get("phone")
        try:
            await call_someone(
                SarvamDialer(settings),
                settings,
                due.extra["phone"],
                due.extra.get("goal") or due.text,
                due.extra.get("opening") or "",
            )
            feed.emit("friday", "schedule_call", f"Calling {who} now.", state="done")
        except Exception as error:
            feed.emit("friday", "schedule_call", f"Could not call {who}: {error}", state="failed")

    async def reminder_clock() -> None:
        while True:
            try:
                for due in await asyncio.to_thread(reminders.due_now):
                    if due.kind == "contact_call":
                        await place_contact_call(due)
                        continue
                    announce(f"Calling your phone: {due.text}" if due.kind == "call" else due.text)
                    if should_call(due):
                        placed = await owner_caller.call(due.text, urgent=due.minutes_left == 0)
                        if not placed["called"]:
                            feed.emit("friday", "call_owner", placed["why"], state="failed")
            except Exception:
                pass  # a bad reminders file must not stop the clock
            await asyncio.sleep(5)

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
            clock = asyncio.create_task(reminder_clock(), name="friday-reminders")
            stack.callback(clock.cancel)
            if (
                tunnel
                and not settings.get("PUBLIC_URL")
                and settings.get("FRIDAY_TUNNEL", "cloudflared") != "off"
                # Only Twilio reaches Friday through the tunnel.
                and settings.get("TWILIO_ACCOUNT_SID")
            ):
                # Twilio reaches the call routes through a free quick tunnel;
                # its address is passed with each call.
                def tunnel_ready(url: str) -> None:
                    settings.values["PUBLIC_URL"] = url
                    try:
                        print(f"Phone calls: {point_number_at(settings, url)}")
                    except Exception as error:
                        print(f"Phone calls: could not point the Twilio number here: {error}")

                quick = QuickTunnel(settings.port, tunnel_ready)
                if await asyncio.to_thread(quick.start):
                    stack.callback(quick.stop)
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
    # Through the public tunnel only the Twilio call routes are reachable.
    app.add_middleware(TunnelGuard)
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
    async def activity_stream(request: Request, voice: str = "") -> StreamingResponse:
        # voice=1: a voice window (gets Caps Lock); voice=notch: the desktop notch.
        queue = feed.listen(voice=voice in ("1", "true"), notch=voice == "notch")

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

    # The main page's reminders panel.
    @app.get("/calls/recent", dependencies=[Depends(owner)])
    async def calls_recent() -> list[dict]:
        """Friday's last Sarvam calls and what was said, for the main page."""
        if not SarvamDialer(settings).ready:
            return []
        names: dict[str, str] = {}
        try:
            contacts = json.loads((REPO_ROOT / "data" / "friday-contacts.json").read_text("utf-8"))
            names = {
                re.sub(r"\D", "", str(c.get("phone", ""))): str(c.get("name")) for c in contacts
            }
        except (OSError, ValueError, AttributeError):
            pass
        mine = re.sub(r"\D", "", owner_phone(settings) or "")
        if mine:
            names[mine] = "You"
        try:
            return await recent_conversations(settings, names)
        except Exception as error:
            raise HTTPException(502, f"Could not read calls from Sarvam: {error}") from error

    @app.get("/reminders", dependencies=[Depends(owner)])
    async def reminders_list() -> list[dict]:
        return [
            {"id": r.id, "kind": r.kind, "text": r.text, "due": r.due}
            for r in await asyncio.to_thread(reminders.upcoming)
        ]

    @app.post("/reminders", dependencies=[Depends(owner)])
    async def reminders_add(request: Request) -> dict:
        body = await request.json()
        kind = str((body or {}).get("kind") or "reminder")
        text = str((body or {}).get("text") or "").strip()
        if kind not in ("reminder", "deadline", "timer") or not text or len(text) > 200:
            raise HTTPException(400, "Give a reminder or deadline with a short title.")
        try:
            item = await asyncio.to_thread(
                reminders.add, kind, text, parse_when(str(body.get("when") or ""))
            )
        except OrganizerError as error:
            raise HTTPException(400, str(error)) from error
        return {"id": item.id, "kind": item.kind, "text": item.text, "due": item.due}

    @app.post("/reminders/{reminder_id}/done", dependencies=[Depends(owner)])
    async def reminders_done(reminder_id: str) -> dict:
        return {"done": bool(await asyncio.to_thread(reminders.finish_id, reminder_id))}

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
            "owner_calls": {
                "via": owner_caller.via,
                "missing": owner_caller.missing(),
            },
            "calendar": {"ready": True, "missing": [], "browser_url": settings.calendar_url},
        }

    @app.post("/twilio/voice/{call_id}")
    async def twilio_voice(call_id: str, request: Request) -> Response:
        await twilio_params(request)
        record = store.get(call_id)
        if not record:
            raise HTTPException(status_code=404, detail="Unknown call.")
        return Response(stream_twiml(settings, record), media_type="application/xml")

    @app.post("/twilio/incoming")
    async def twilio_incoming(request: Request) -> Response:
        """The owner phoned Friday's number: Friday answers with their updates
        (with Gnani set up: lets it ring out and calls back)."""
        params = await twilio_params(request)
        caller = re.sub(r"\D", "", params.get("From", ""))
        mine = re.sub(r"\D", "", owner_phone(settings) or "")
        say = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>{}</Say><Hangup/></Response>'
        if not mine or caller != mine:
            # Only the owner may talk to Friday by phone.
            return Response(
                say.format("Sorry, Friday only takes calls from its owner."),
                media_type="application/xml",
            )
        if store.active():
            return Response(
                say.format("Friday is on another call. Please try again in a minute."),
                media_type="application/xml",
            )
        upcoming = [
            f"- {item.text} ({item.kind}), {spoken_time(datetime.fromtimestamp(item.due))}"
            for item in reminders.upcoming()[:6]
        ]
        today = [
            f"- {event['detail']}"
            for event in feed.recent(60)
            if event["state"] == "done" and event["actor"] != "control"
        ][-8:]
        context = "Coming up:\n" + ("\n".join(upcoming) or "- nothing")
        if today:
            context += "\nDone today:\n" + "\n".join(today)
        if owner_caller.agent:
            # A missed call is enough: Friday does not answer (so the call costs
            # nothing and no trial notice plays) and Gnani rings back with the
            # updates.
            async def ring_back() -> None:
                await asyncio.sleep(3)
                placed = await owner_caller.call(
                    "You gave me a missed call, so here are your updates.",
                    urgent=True,
                    updates=context,
                )
                if not placed["called"]:
                    feed.emit("friday", "call_owner", placed["why"], state="failed")

            task = asyncio.create_task(ring_back(), name="friday-ring-back")
            ringing_back.add(task)
            task.add_done_callback(ringing_back.discard)
            feed.emit("friday", "call_in", "Missed call from you: calling you back.", state="done")
            return Response(
                '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
                media_type="application/xml",
            )
        record = store.create(
            phone=params.get("From", ""),
            goal="The owner called for an update.",
            language=settings.get("FRIDAY_CALL_LANGUAGE", "en-IN"),
            context=context,
            kind="owner_in",
        )
        record.twilio_sid = params.get("CallSid")
        feed.emit("friday", "call_in", "You phoned Friday.", state="done")
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
        create_app(settings, wake=True, tunnel=True),
        host=settings.host,
        port=settings.port,
        # The voice screen's live streams never end by themselves; do not wait on them.
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
