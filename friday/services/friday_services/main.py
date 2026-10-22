"""Friday services: Twilio webhooks, call audio, and MCP endpoints for OpenDots."""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from pipecat.runner.utils import parse_telephony_websocket

from friday_services.auth import BearerAuth
from friday_services.calls.bot import run_call
from friday_services.calls.store import CallStore
from friday_services.calls.twilio import (
    NOT_CONNECTED,
    TwilioDialer,
    stream_twiml,
    valid_signature,
)
from friday_services.config import CALL_SETTINGS, REPO_ROOT, Settings
from friday_services.mcp_phone import Dialer, build_phone_server

CallRunner = Callable[..., Awaitable[None]]


def create_app(
    settings: Settings | None = None,
    *,
    dialer: Dialer | None = None,
    call_runner: CallRunner = run_call,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if len(settings.services_token) < 24:
        raise RuntimeError(
            "Set FRIDAY_SERVICES_TOKEN in .env to a random value of 24+ characters. "
            "OpenDots sends it as the bearer token for Friday's MCP connections."
        )
    store = CallStore(settings.data_dir)
    phone = build_phone_server(store, dialer or TwilioDialer(settings), settings)
    mcp_apps = {
        "/phone": (
            phone,
            phone.streamable_http_app(
                streamable_http_path="/mcp", stateless_http=True, json_response=True
            ),
        )
    }

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with AsyncExitStack() as stack:
            for server, _asgi in mcp_apps.values():
                await stack.enter_async_context(server.session_manager.run())
            yield

    app = FastAPI(title="Friday services", lifespan=lifespan)
    app.state.settings = settings
    app.state.calls = store
    for path, (_server, asgi) in mcp_apps.items():
        app.mount(path, BearerAuth(asgi, settings.services_token))

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

    return app


def main() -> None:
    import uvicorn

    load_dotenv(REPO_ROOT / ".env")
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
