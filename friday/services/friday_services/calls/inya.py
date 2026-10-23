"""Friday phones its owner through Gnani's Inya voice agents.

Inya places the call from India and runs the whole conversation itself
(Gnani speech-to-text, LLM and voice, with barge-in), so there is no trial
notice to sit through and no tunnel is needed. Before each call Friday writes
the agent's greeting and prompt for that call, then triggers it:

  PUT  /v1/agents/{botId}                greetingMessage, systemPrompt, endMessage
  POST /v1/agents/{botId}/trigger_call   phone, countryCode, name, clientReferenceId

The owner's number must be whitelisted in the Inya console (Phone Numbers ->
Whitelisted, verified with an OTP). Docs: https://docs.gnani.ai/Platform/Trigger_Call.md
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from loguru import logger
from openai import AsyncOpenAI

from friday_services.config import Settings

INYA_API = "https://api.inya.ai/platform"
AGENT_NAME = "Friday"

POLISH_PROMPT = """You write the first thing Friday, {owner}'s friendly personal AI assistant, says when {owner} picks up Friday's phone call.
Turn Friday's note into one or two short, warm, natural sentences, starting with "Hi {owner}, it's Friday." Keep every fact (times, names, what is due), say times the way people speak them ("nine fifty PM"), and fix odd wording. Use the note's language: English, or Hindi/Hinglish in Latin letters.
Reply with only the words to say. Current local time: {now}."""


class InyaError(RuntimeError):
    pass


def jinja_safe(text: str) -> str:
    """Inya prompts are Jinja2 templates; Friday's own text must not be one."""
    return text.replace("{", "(").replace("}", ")").replace("%", " percent")


def plain_reason(text: str) -> str:
    """Friday's note ("Reminder: X is due in 1 hour.", "Reminder to eat
    dinner") as words to say, for when no model can word it."""
    text = text.strip()
    shape = re.match(r"(?i)(reminder\s*:|reminder to|remind me to)\s*(.+)", text)
    if shape:
        rest = shape.group(2)
        joiner = ", " if shape.group(1).endswith(":") else " to "
        text = f"Just a reminder{joiner}{rest[0].lower() + rest[1:] if joiner == ' to ' else rest}"
    if text and text[-1] not in ".!?":
        text += "."
    return text


class InyaDialer:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._settings = settings
        self._client = client
        self._agent_file = settings.data_dir / "inya-agent.json"
        self._agent_id = settings.get("INYA_AGENT_ID") or None

    @property
    def ready(self) -> bool:
        return bool(self._settings.get("INYA_API_KEY"))

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        client = self._client or httpx.AsyncClient(timeout=20)
        try:
            response = await client.request(
                method,
                f"{INYA_API}{path}",
                headers={"x-api-key": self._settings.get("INYA_API_KEY")},
                **kwargs,
            )
        finally:
            if not self._client:
                await client.aclose()
        body = response.json() if response.content else {}
        if response.status_code >= 400 or body.get("status") == "failure":
            raise InyaError(
                f"Gnani refused (HTTP {response.status_code}): {body.get('message', 'no details')}"
            )
        return body

    async def agent_id(self) -> str:
        """INYA_AGENT_ID, else the agent named Friday (found once, or made)."""
        if self._agent_id:
            return self._agent_id
        try:
            self._agent_id = json.loads(self._agent_file.read_text("utf-8"))["botId"]
            return self._agent_id
        except (OSError, ValueError, KeyError):
            pass
        listed = await self._request("GET", "/v1/agents", params={"pageNo": 1, "pageSize": 50})
        found = [
            agent["botId"]
            for agent in agents_in(listed)
            if str(agent.get("botName", "")).strip().lower() == AGENT_NAME.lower()
        ]
        if found:
            self._agent_id = found[0]
        else:
            made = await self._request(
                "POST",
                "/v1/agents",
                json={
                    "botName": AGENT_NAME,
                    "description": "Friday, a personal AI assistant, phoning its owner.",
                    "region": "asia",
                    "timeZone": self._settings.timezone,
                },
            )
            self._agent_id = made["response"]["botId"]
        self._agent_file.parent.mkdir(parents=True, exist_ok=True)
        self._agent_file.write_text(json.dumps({"botId": self._agent_id}), encoding="utf-8")
        return self._agent_id

    async def greeting(self, note: str) -> str:
        """What Friday says when the owner picks up: the note, said nicely by
        Evon (or the fallback model when Evon is out of quota); the plain note
        if neither answers."""
        owner = self._settings.owner_name
        now = datetime.now(ZoneInfo(self._settings.timezone)).strftime("%A %I:%M %p")
        messages = [
            {"role": "system", "content": POLISH_PROMPT.format(owner=owner, now=now)},
            {"role": "user", "content": f"Friday's note: {note}"},
        ]
        for prefix in ("EVON_", "FRIDAY_FALLBACK_"):
            base_url = self._settings.get(f"{prefix}BASE_URL")
            if not base_url:
                continue
            client = AsyncOpenAI(
                api_key=self._settings.get(f"{prefix}API_KEY") or "not-needed",
                base_url=base_url,
                timeout=8,
            )
            thinking_off = prefix == "EVON_" and self._settings.evon_disable_thinking
            try:
                reply = await client.chat.completions.create(
                    model=self._settings.get(f"{prefix}MODEL"),
                    messages=messages,
                    max_completion_tokens=120,
                    temperature=0.5,
                    extra_body=(
                        {"chat_template_kwargs": {"enable_thinking": False}}
                        if thinking_off
                        else None
                    ),
                )
                text = reply.choices[0].message.content or ""
                text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
                text = re.sub(r"\s+", " ", text).strip().strip('"')
                if 10 <= len(text) <= 400:
                    return text
            except Exception as error:
                logger.warning(f"Could not polish the call greeting with {prefix}MODEL: {error}")
            finally:
                await client.close()
        # Only the first line: the agent tells any updates once the owner answers.
        return f"Hi {owner}, it's Friday. {plain_reason(note.splitlines()[0])}"

    async def call(self, *, phone: str, greeting: str, prompt: str, reference: str) -> str:
        """Set this call's greeting and prompt on the agent, then ring the
        owner. Returns Gnani's request id."""
        digits = re.sub(r"\D", "", phone)
        if len(digits) < 11:
            raise InyaError(f"{phone} is not a full international number.")
        bot = await self.agent_id()
        await self._request(
            "PUT",
            f"/v1/agents/{bot}",
            json={
                "greetingMessage": jinja_safe(greeting),
                "systemPrompt": jinja_safe(prompt),
                "endMessage": "Okay, bye! Talk soon.",
            },
        )
        placed = await self._request(
            "POST",
            f"/v1/agents/{bot}/trigger_call",
            params={"environment": self._settings.get("INYA_ENVIRONMENT", "development")},
            json={
                "phone": digits[-10:],
                "countryCode": "+" + digits[:-10],
                "name": self._settings.owner_name,
                "clientReferenceId": reference,
            },
        )
        return str(placed.get("requestId") or "")


def agents_in(body: Any) -> list[dict[str, Any]]:
    """Every agent ({botId, botName}) anywhere in a list-agents reply."""
    if isinstance(body, dict):
        if "botId" in body:
            return [body]
        return [agent for value in body.values() for agent in agents_in(value)]
    if isinstance(body, list):
        return [agent for value in body for agent in agents_in(value)]
    return []
