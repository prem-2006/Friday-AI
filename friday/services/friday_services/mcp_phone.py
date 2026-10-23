"""MCP tools Friday's planner uses to make phone calls."""

from __future__ import annotations

import re
from typing import Annotated, Protocol

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.calls.sarvam import SarvamDialer
from friday_services.calls.store import CallRecord, CallStore
from friday_services.config import CALL_SETTINGS, Settings
from friday_services.voices import DEFAULT_LANGUAGE, LANGUAGES

PHONE_NUMBER = re.compile(r"^\+[1-9]\d{7,14}$")
# OpenDots stops an MCP call after 60 s, so one wait stays well below that.
MAX_WAIT_SECONDS = 40


class Dialer(Protocol):
    async def place(self, record: CallRecord) -> str: ...


def build_phone_server(
    store: CallStore, dialer: Dialer, settings: Settings, sarvam: SarvamDialer | None = None
) -> MCPServer:
    server = MCPServer(
        name="friday-phone",
        instructions=(
            "Real phone calls. start_call dials and returns at once; then call "
            "get_call_result until its status is answered, no_answer or failed."
        ),
    )

    @server.tool(
        name="start_call",
        title="Start a phone call",
        description=(
            "Phone someone else (a shop, a clinic, a friend) and let Friday, speaking as an "
            "AI assistant, pursue one goal. Never for the owner themself: to phone "
            f'{settings.owner_name} ("call me", "call {settings.owner_name}") use '
            "call_me instead. Returns a call_id straight away; then call get_call_result "
            "with it."
        ),
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
    )
    async def start_call(
        phone: Annotated[
            str, Field(description="Number in international format, e.g. +919812345678.")
        ],
        goal: Annotated[
            str,
            Field(
                description="The one thing this call must achieve, e.g. 'Book a dental check-up tomorrow at 6 PM'.",
                min_length=5,
                max_length=500,
            ),
        ],
        language: Annotated[
            str,
            Field(description=f"Language to speak: one of {', '.join(LANGUAGES)}."),
        ] = DEFAULT_LANGUAGE,
        context: Annotated[
            str,
            Field(
                description=(
                    "What Friday may share and accept, e.g. the owner's name, "
                    "acceptable alternative times. Never payment details."
                ),
                max_length=2000,
            ),
        ] = "",
        opening_line: Annotated[
            str,
            Field(
                description=(
                    "What Friday says first when they pick up, warm and short, e.g. "
                    "'Hi Didi, this is Friday, Prem's assistant. Prem says please sleep early.'"
                ),
                max_length=400,
            ),
        ] = "",
    ) -> dict:
        if not PHONE_NUMBER.match(phone):
            raise ToolError("Use an international number such as +919812345678.")
        if language not in LANGUAGES:
            raise ToolError(f"Unsupported language. Use one of: {', '.join(LANGUAGES)}.")
        if sarvam and sarvam.ready:
            # Sarvam's agent runs the call (an Indian number, no trial notice);
            # Twilio is the fallback when Sarvam refuses.
            owner = settings.owner_name
            greeting = opening_line.strip() or (
                f"Hello, this is Friday, an AI assistant calling for {owner}."
            )
            note = f"You are calling someone for {owner}, not {owner} themself. Goal: {goal}" + (
                f" What you may share or accept: {context}" if context else ""
            )
            try:
                await sarvam.call(
                    phone=phone,
                    greeting=greeting,
                    prompt="",
                    reference="",
                    note=note,
                    updates="none",
                )
                return {
                    "call_id": f"sarvam-{abs(hash((phone, goal))) % 10**8}",
                    "status": "placed",
                    "via": "sarvam",
                    "next_step": (
                        "Sarvam runs this call and does not report back. Tell the owner "
                        "the call was placed; do not call get_call_result."
                    ),
                }
            except Exception as error:
                if settings.missing(CALL_SETTINGS):
                    raise ToolError(f"The call could not be placed: {error}") from error
        missing = settings.missing(CALL_SETTINGS)
        if missing:
            raise ToolError(f"Phone calls are not set up. Missing in .env: {', '.join(missing)}.")
        busy = store.active()
        if busy:
            raise ToolError(f"Call {busy.id} is still in progress. Wait for its result first.")
        record = store.create(phone=phone, goal=goal, language=language, context=context)
        try:
            record.twilio_sid = await dialer.place(record)
        except Exception as error:
            store.finish(record.id, "failed", error=str(error))
            return record.result()
        store.set_stage(record.id, "ringing")
        return {
            **record.result(),
            "next_step": "Call get_call_result with this call_id to wait for the outcome.",
        }

    @server.tool(
        name="get_call_result",
        title="Get a phone call's result",
        description=(
            f"Wait up to {MAX_WAIT_SECONDS} seconds for a call started with start_call to finish. "
            "status is in_progress, answered, no_answer or failed. Repeat while in_progress."
        ),
        annotations=ToolAnnotations(read_only_hint=True),
    )
    async def get_call_result(
        call_id: Annotated[str, Field(description="The call_id from start_call.")],
        wait_seconds: Annotated[
            int,
            Field(description="How long to wait for the call to end.", ge=0, le=MAX_WAIT_SECONDS),
        ] = MAX_WAIT_SECONDS,
    ) -> dict:
        if call_id.startswith("sarvam-"):
            return {"call_id": call_id, "status": "placed", "via": "sarvam"}
        if not store.get(call_id):
            raise ToolError(f"No call with id {call_id}.")
        record = await store.wait(call_id, wait_seconds)
        return record.result()

    return server
