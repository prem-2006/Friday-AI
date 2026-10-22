"""Shared fixtures. Nothing here reaches Twilio, Gnani, Evon or Telegram."""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import uvicorn

from friday_services.calls.store import CallRecord, CallStore
from friday_services.config import Settings
from friday_services.main import create_app

TOKEN = "test-token-0123456789abcdef"
FAKE_ENV = {
    "FRIDAY_SERVICES_TOKEN": TOKEN,
    "FRIDAY_OWNER_NAME": "Asha",
    "GNANI_API_KEY": "fake-gnani",
    "EVON_BASE_URL": "http://127.0.0.1:9/v1",
    "EVON_MODEL": "gnani-evon-v3.3",
    "TWILIO_ACCOUNT_SID": "AC00000000000000000000000000000000",
    "TWILIO_AUTH_TOKEN": "twilio-test-auth-token",
    "TWILIO_FROM_NUMBER": "+15550001111",
    "PUBLIC_URL": "https://friday.example.test",
    "TIMEZONE": "Asia/Kolkata",
}


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings.from_env(FAKE_ENV, data_dir=tmp_path)


class FakeDialer:
    def __init__(self):
        self.placed: list[CallRecord] = []
        self.error: Exception | None = None

    async def place(self, record: CallRecord) -> str:
        if self.error:
            raise self.error
        self.placed.append(record)
        return f"CA{len(self.placed):032d}"


class FakeCall:
    """Stands in for the Pipecat pipeline: records the call and ends it."""

    def __init__(self):
        self.runs: list[dict] = []

    async def __call__(self, websocket, *, record, store: CallStore, **kwargs):
        self.runs.append({"record": record, **kwargs})
        record.stream_started = True
        store.add_turn(record.id, "friday", "Hello, this is Friday.")
        store.finish(record.id, "answered", outcome="completed", summary="Booked for 6 PM.")
        await websocket.close()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def server(settings: Settings):
    dialer, call = FakeDialer(), FakeCall()
    app = create_app(settings, dialer=dialer, call_runner=call)
    port = free_port()
    uv = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    )
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not uv.started and time.time() < deadline:
        time.sleep(0.05)
    assert uv.started, "test server did not start"
    yield SimpleNamespace(
        url=f"http://127.0.0.1:{port}", app=app, dialer=dialer, call=call, settings=settings
    )
    uv.should_exit = True
    thread.join(10)
