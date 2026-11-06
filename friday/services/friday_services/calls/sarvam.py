"""Friday phones its owner through a Sarvam voice agent.

Sarvam places the call from its Indian number and runs the conversation
with the agent made on indus.sarvam.ai. That agent's greeting is the input
variable {{opening_line}}, so the call opens with this call's reminder; the
variables `reason` and `updates` carry the rest for its instructions.

  POST https://apps.sarvam.ai/api/outbounds/v1/orgs/{org}/workspaces/{ws}/outbounds

Every value comes from the Sarvam website (see .env.example, SARVAM_*).
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from friday_services.config import Settings
from friday_services.usage import counted

SARVAM_API = "https://apps.sarvam.ai/api/outbounds/v1"
SARVAM_SETTINGS = (
    "SARVAM_API_KEY",
    "SARVAM_ORG_ID",
    "SARVAM_WORKSPACE_ID",
    "SARVAM_APP_ID",
    "SARVAM_APP_VERSION",
    "SARVAM_CONNECTION_ID",
    "SARVAM_AGENT_NUMBER",
)


# What the agent says when someone calls Friday's number: the default value of
# its opening_line variable in the Sarvam agent (calls Friday places set it).
INBOUND_GREETING = "Hi, I'm Friday. How can I help you?"


class SarvamError(RuntimeError):
    pass


def opening(greeting: str, owner: str) -> str:
    """A call Friday places opens by saying it is Friday, then why it called."""
    greeting = " ".join(greeting.split())
    if "friday" in greeting.casefold():
        return greeting
    intro = f"Hi, I'm Friday, {owner}'s AI assistant."
    return f"{intro} {greeting}".strip()


class SarvamDialer:
    name = "sarvam"

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._settings = settings
        self._client = client

    @property
    def ready(self) -> bool:
        return not self._settings.missing(SARVAM_SETTINGS)

    @counted("Phone calls", "Sarvam", "calls Friday places")
    async def call(
        self, *, phone: str, greeting: str, prompt: str, reference: str, note: str, updates: str
    ) -> str:
        """Ring the owner with this call's opening line. Returns Sarvam's reply."""
        get = self._settings.get
        digits = re.sub(r"\D", "", phone)
        if len(digits) < 11:
            raise SarvamError(f"{phone} is not a full international number.")
        greeting = opening(greeting, self._settings.owner_name)
        body: dict[str, Any] = {
            "app_config": {
                "app_id": get("SARVAM_APP_ID"),
                "app_version": int(get("SARVAM_APP_VERSION", "1")),
                "connection_config": {
                    "connection_id": get("SARVAM_CONNECTION_ID"),
                    "agent_phone_number": get("SARVAM_AGENT_NUMBER"),
                },
                "agent_variables": {
                    "opening_line": greeting,
                    "reason": note,
                    "updates": updates or "none",
                },
                # Sarvam ignores this when the greeting is {{opening_line}}; kept
                # so an agent with a plain greeting still opens with the reason.
                "app_overrides": {
                    "initial_bot_message": greeting,
                    "initial_language_name": get("SARVAM_CALL_LANGUAGE", "English"),
                },
            },
            "user_config": {"user_phone_number": f"+{digits}"},
        }
        url = (
            f"{SARVAM_API}/orgs/{get('SARVAM_ORG_ID')}"
            f"/workspaces/{get('SARVAM_WORKSPACE_ID')}/outbounds"
        )
        client = self._client or httpx.AsyncClient(timeout=15)
        try:
            response = await client.post(
                url, json=body, headers={"X-API-Key": get("SARVAM_API_KEY")}
            )
        finally:
            if not self._client:
                await client.aclose()
        if response.status_code >= 400:
            raise SarvamError(
                f"Sarvam refused the call (HTTP {response.status_code}): {response.text[:200]}"
            )
        return response.text[:200]


SARVAM_ANALYTICS = "https://apps.sarvam.ai/api/analytics/v1"


@counted("Phone calls", "Sarvam", "call history (Calls page)")
async def recent_conversations(
    settings: Settings,
    names: dict[str, str],
    days: int = 7,
    limit: int = 20,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, Any]]:
    """The agent's last calls with what was said, newest first. `names` maps
    a number's digits to a contact's name; other numbers show masked."""
    from datetime import UTC, datetime, timedelta

    get = settings.get
    end = datetime.now(UTC)
    url = (
        f"{SARVAM_ANALYTICS}/{get('SARVAM_ORG_ID')}/{get('SARVAM_WORKSPACE_ID')}"
        f"/{get('SARVAM_APP_ID')}/interactions"
    )
    params = {
        "start_datetime": (end - timedelta(days=days)).isoformat(timespec="seconds"),
        "end_datetime": end.isoformat(timespec="seconds"),
        "include_transcript": "true",
        "sort_by": "start_datetime",
        "sort_order": "desc",
        "limit": str(limit),
    }
    http = client or httpx.AsyncClient(timeout=20)
    try:
        response = await http.get(url, params=params, headers={"X-API-Key": get("SARVAM_API_KEY")})
    finally:
        if not client:
            await http.aclose()
    if response.status_code >= 400:
        raise SarvamError(f"Sarvam refused (HTTP {response.status_code}): {response.text[:200]}")
    calls = []
    for item in response.json().get("items") or []:
        digits = re.sub(r"\D", "", str(item.get("user_contact") or ""))
        name = next((n for d, n in names.items() if d and digits.endswith(d[-10:])), None)
        calls.append(
            {
                "id": item.get("interaction_id"),
                "who": name or item.get("user_contact_masked") or "Unknown",
                "started": f"{item.get('start_datetime')}+00:00",
                "seconds": round(float(item.get("duration_in_seconds") or 0)),
                "ended_by": item.get("ended_by"),
                "lines": [
                    {
                        "who": "Friday" if line.get("role") == "agent" else "Them",
                        "text": line.get("text", ""),
                    }
                    for line in item.get("original_transcript") or []
                ],
            }
        )
    return calls
