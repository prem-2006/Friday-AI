"""Twilio REST and webhook helpers (no Twilio SDK needed)."""

from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Mapping
from xml.sax.saxutils import quoteattr

import httpx

from friday_services.calls.store import CallRecord
from friday_services.config import Settings

TWILIO_API = "https://api.twilio.com/2010-04-01"


class TwilioError(RuntimeError):
    pass


def signature(auth_token: str, url: str, params: Mapping[str, str]) -> str:
    """Twilio's X-Twilio-Signature: HMAC-SHA1 of the URL plus sorted params."""
    payload = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    digest = hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def valid_signature(
    auth_token: str, url: str, params: Mapping[str, str], supplied: str | None
) -> bool:
    if not auth_token or not supplied:
        return False
    return hmac.compare_digest(signature(auth_token, url, params), supplied)


def stream_twiml(settings: Settings, record: CallRecord) -> str:
    """Tells Twilio to stream the call audio to our WebSocket both ways."""
    stream_url = settings.public_url.replace("https://", "wss://", 1) + "/twilio/stream"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response><Connect>"
        f"<Stream url={quoteattr(stream_url)}>"
        f'<Parameter name="call_id" value={quoteattr(record.id)}/>'
        f'<Parameter name="token" value={quoteattr(record.stream_token)}/>'
        "</Stream>"
        "</Connect></Response>"
    )


# Twilio CallStatus -> Friday status, for calls whose audio never started.
NOT_CONNECTED = {
    "busy": "no_answer",
    "no-answer": "no_answer",
    "failed": "failed",
    "canceled": "failed",
}


class TwilioDialer:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._settings = settings
        self._client = client

    async def place(self, record: CallRecord) -> str:
        """Start an outbound call and return Twilio's call SID."""
        sid = self._settings.get("TWILIO_ACCOUNT_SID")
        public = self._settings.public_url
        data = {
            "To": record.phone,
            "From": self._settings.get("TWILIO_FROM_NUMBER"),
            "Url": f"{public}/twilio/voice/{record.id}",
            "Method": "POST",
            "StatusCallback": f"{public}/twilio/status/{record.id}",
            "StatusCallbackMethod": "POST",
            "StatusCallbackEvent": ["initiated", "ringing", "answered", "completed"],
            "Timeout": "30",
        }
        client = self._client or httpx.AsyncClient(timeout=15)
        try:
            response = await client.post(
                f"{TWILIO_API}/Accounts/{sid}/Calls.json",
                data=data,
                auth=(sid, self._settings.get("TWILIO_AUTH_TOKEN")),
            )
        finally:
            if not self._client:
                await client.aclose()
        body = response.json() if response.content else {}
        if response.status_code >= 400:
            raise TwilioError(
                f"Twilio refused the call (HTTP {response.status_code}): "
                f"{body.get('message', 'no details')}"
            )
        return str(body["sid"])
