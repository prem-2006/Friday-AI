"""A free Cloudflare quick tunnel, so Twilio can reach Friday's call routes.

The services start `cloudflared tunnel --url http://127.0.0.1:<port>` and use
the address it prints (https://<random>.trycloudflare.com) as PUBLIC_URL for
each call; no Twilio console settings are needed for outbound calls. The
address changes when the tunnel restarts, which is fine for that reason.

TunnelGuard keeps everything except the Twilio routes off the internet:
requests that come through Cloudflare carry its headers, and only /twilio/
paths answer them.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path

log = logging.getLogger("friday.tunnel")
TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def find_cloudflared() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    for base in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        root = os.environ.get(base)
        if root:
            for candidate in (
                Path(root) / "cloudflared" / "cloudflared.exe",
                Path(root) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe",
            ):
                if candidate.exists():
                    return str(candidate)
    return None


class QuickTunnel:
    def __init__(self, port: int, on_url: Callable[[str], None], binary: str | None = None):
        self._port = port
        self._on_url = on_url
        self._binary = binary
        self._process: subprocess.Popen | None = None

    def start(self) -> bool:
        binary = self._binary or find_cloudflared()
        if not binary:
            log.warning(
                "cloudflared is not installed; phone calls need it (winget install Cloudflare.cloudflared)"
            )
            return False
        self._process = subprocess.Popen(
            [binary, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{self._port}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        def read() -> None:
            assert self._process and self._process.stderr
            for line in self._process.stderr:
                match = TUNNEL_URL.search(line)
                if match:
                    self._on_url(match.group(0))
                    print(f"Phone calls: tunnel ready at {match.group(0)}")

        threading.Thread(target=read, name="friday-tunnel", daemon=True).start()
        return True

    def stop(self) -> None:
        if self._process and self._process.poll() is None:
            self._process.terminate()


class TunnelGuard:
    """ASGI middleware: through the tunnel, only Twilio's call routes answer."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {name.lower() for name, _ in scope.get("headers") or []}
            from_internet = b"cf-connecting-ip" in headers or b"cf-ray" in headers
            if from_internet and not scope["path"].startswith("/twilio/"):
                if scope["type"] == "http":
                    await send({"type": "http.response.start", "status": 404, "headers": []})
                    await send({"type": "http.response.body", "body": b"Not found."})
                else:
                    await send({"type": "websocket.close", "code": 1008})
                return
        await self.app(scope, receive, send)
