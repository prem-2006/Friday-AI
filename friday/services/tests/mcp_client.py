"""A minimal MCP client over Streamable HTTP, enough to test Friday's tools."""

from __future__ import annotations

import json
from typing import Any

import httpx

PROTOCOL_VERSION = "2025-06-18"


class McpClient:
    def __init__(self, url: str, token: str | None):
        self._url = url
        self._headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
            **({"Authorization": f"Bearer {token}"} if token else {}),
        }
        self._id = 0

    def raw(self, method: str, params: dict | None = None) -> httpx.Response:
        self._id += 1
        body = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}
        return httpx.post(self._url, headers=self._headers, json=body, timeout=60)

    def request(self, method: str, params: dict | None = None) -> dict[str, Any]:
        response = self.raw(method, params)
        response.raise_for_status()
        if response.headers.get("content-type", "").startswith("text/event-stream"):
            data = [
                line[5:].strip() for line in response.text.splitlines() if line.startswith("data:")
            ]
            message = json.loads(data[-1])
        else:
            message = response.json()
        if "error" in message:
            raise RuntimeError(message["error"])
        return message["result"]

    def initialize(self) -> dict[str, Any]:
        return self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "friday-tests", "version": "1"},
            },
        )

    def tools(self) -> dict[str, dict]:
        return {tool["name"]: tool for tool in self.request("tools/list")["tools"]}

    def call(self, name: str, arguments: dict) -> dict[str, Any]:
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "".join(item.get("text", "") for item in result.get("content", []))
        data = result.get("structuredContent")
        if data is None and not result.get("isError"):
            data = json.loads(text)  # OpenDots reads the same JSON text
        return {"isError": bool(result.get("isError")), "text": text, "data": data}
