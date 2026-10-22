"""Bearer-token guard for the MCP endpoints OpenDots connects to."""

from __future__ import annotations

import hmac
import json

from starlette.types import ASGIApp, Receive, Scope, Send


class BearerAuth:
    def __init__(self, app: ASGIApp, token: str):
        self._app = app
        self._expected = f"Bearer {token}".encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            supplied = dict(scope["headers"]).get(b"authorization", b"")
            if not hmac.compare_digest(supplied, self._expected):
                body = json.dumps({"error": "Missing or wrong bearer token."}).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self._app(scope, receive, send)
