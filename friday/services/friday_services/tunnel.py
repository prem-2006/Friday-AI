"""Friday's fixed public address (ngrok), so the phone line reaches it.

Exotel's call flow and Sarvam's agent both have this address typed in, so it
must stay the same after every restart (NGROK_DOMAIN).

TunnelGuard keeps everything except the call routes off the internet:
requests that come through Cloudflare or ngrok carry their headers, and only
the CALL_ROUTES paths answer them.
"""

from __future__ import annotations

import logging

from friday_services.usage import counted

log = logging.getLogger("friday.tunnel")
# What the phone providers reach through the tunnel; nothing else answers there.
CALL_ROUTES = ("/exotel/", "/phone/ask")
NGROK_MARK = "x-friday-tunnel"


class NgrokTunnel:
    """A fixed public address (NGROK_DOMAIN, free with an ngrok account), so
    Exotel and Sarvam's agent reach Friday at the same URL after every restart.
    Every request through it carries NGROK_MARK, which TunnelGuard checks."""

    def __init__(self, port: int, authtoken: str, domain: str):
        self._port = port
        self._authtoken = authtoken
        self._domain = domain.removeprefix("https://").strip("/")
        self._session = None

    @counted("Connections", "ngrok", "tunnel start")
    async def start(self) -> str:
        import ngrok

        self._session = await ngrok.SessionBuilder().authtoken(self._authtoken).connect()
        listener = await (
            self._session.http_endpoint()
            .domain(self._domain)
            .request_header(NGROK_MARK, "1")
            .listen_and_forward(f"http://127.0.0.1:{self._port}")
        )
        url = listener.url()
        print(f"Phone: Friday answers at {url}")
        return url

    async def stop(self) -> None:
        if self._session:
            await self._session.close()


class TunnelGuard:
    """ASGI middleware: through a tunnel, only the call routes answer (Exotel's
    /exotel/ and Sarvam's /phone/ask)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {name.lower() for name, _ in scope.get("headers") or []}
            from_internet = (
                b"cf-connecting-ip" in headers
                or b"cf-ray" in headers
                or NGROK_MARK.encode() in headers
                or b"x-forwarded-for" in headers
            )
            if from_internet and not scope["path"].startswith(CALL_ROUTES):
                if scope["type"] == "http":
                    await send({"type": "http.response.start", "status": 404, "headers": []})
                    await send({"type": "http.response.body", "body": b"Not found."})
                else:
                    await send({"type": "websocket.close", "code": 1008})
                return
        await self.app(scope, receive, send)
