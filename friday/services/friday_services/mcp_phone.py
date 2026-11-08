"""MCP tools Friday's planner uses to make phone calls."""

from __future__ import annotations

import asyncio
import re
from typing import Annotated, Any, Literal, Protocol

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from friday_services.business import business_profile, client_context, lead_line
from friday_services.business_page import PURPOSES
from friday_services.calls.sarvam import SarvamDialer
from friday_services.calls.store import CallRecord, CallStore
from friday_services.config import Settings
from friday_services.organizer import OrganizerError, Reminders, parse_when, spoken_time
from friday_services.voices import DEFAULT_LANGUAGE, LANGUAGES

PHONE_NUMBER = re.compile(r"^\+[1-9]\d{7,14}$")
# OpenDots stops an MCP call after 60 s, so one wait stays well below that.
MAX_WAIT_SECONDS = 40


class Dialer(Protocol):
    async def place(self, record: CallRecord) -> str: ...


async def place_own_call(
    store: CallStore,
    dialer: Dialer,
    phone: str,
    goal: str,
    language: str = DEFAULT_LANGUAGE,
    context: str = "",
    opening_line: str = "",
    kind: str = "business",
) -> CallRecord:
    """Friday's own pipeline phones someone for the owner over Exotel.
    The record is failed, not raised, when the provider refuses."""
    busy = store.active()
    if busy:
        raise ToolError(f"Call {busy.id} is still in progress. Wait for its result first.")
    record = store.create(
        phone=phone,
        goal=goal,
        language=language,
        context=context,
        opening=opening_line.strip(),
        kind=kind,
    )
    try:
        record.call_sid = await dialer.place(record)
    except Exception as error:
        store.finish(record.id, "failed", error=str(error))
        return record
    store.set_stage(record.id, "ringing")
    return record


async def call_someone(
    sarvam: SarvamDialer,
    settings: Settings,
    phone: str,
    goal: str,
    opening_line: str = "",
    context: str = "",
) -> None:
    """Has the Sarvam agent phone someone other than the owner, for the owner."""
    owner = settings.owner_name
    greeting = opening_line.strip() or f"Hi, I'm Friday, {owner}'s AI assistant."
    note = f"You are calling someone for {owner}, not {owner} themself. Goal: {goal}" + (
        f" What you may share or accept: {context}" if context else ""
    )
    await sarvam.call(
        phone=phone, greeting=greeting, prompt="", reference="", note=note, updates="none"
    )


def build_phone_server(
    store: CallStore,
    dialer: Dialer,
    settings: Settings,
    sarvam: SarvamDialer | None = None,
    reminders: Reminders | None = None,
    calendar: Any = None,
    leads: Any = None,
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
        own_ready = settings.own_calls_ready
        # Friday's own pipeline when it is set up; Sarvam's agent otherwise.
        if sarvam and sarvam.ready and not own_ready:
            # Sarvam's agent runs the call until Friday's own Exotel line is set up.
            try:
                await call_someone(sarvam, settings, phone, goal, opening_line, context)
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
                if not own_ready:
                    raise ToolError(f"The call could not be placed: {error}") from error
        missing = settings.missing(settings.call_settings)
        if missing:
            raise ToolError(f"Phone calls are not set up. Missing in .env: {', '.join(missing)}.")
        record = await place_own_call(store, dialer, phone, goal, language, context, opening_line)
        if record.final:
            return record.result()
        return {
            **record.result(),
            "next_step": "Call get_call_result with this call_id to wait for the outcome.",
        }

    @server.tool(
        name="schedule_call",
        title="Schedule a phone call",
        description=(
            "Phone someone else at a later time: when is the owner's local "
            "time in India with no time zone, e.g. 2026-10-24T12:00. Use the owner's "
            "contacts for names. goal is everything to say or ask; opening_line is the "
            "warm first sentence, e.g. 'Hi Didi, this is Friday, Prem's assistant. Time "
            "for lunch!'. For the owner themself use call_me with when instead."
        ),
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
    )
    async def schedule_call(
        phone: Annotated[
            str, Field(description="Number in international format, e.g. +919812345678.")
        ],
        when: Annotated[str, Field(max_length=25)],
        goal: Annotated[str, Field(min_length=5, max_length=500)],
        opening_line: Annotated[str, Field(max_length=400)] = "",
        name: Annotated[str, Field(description="Who is called, e.g. Didi.", max_length=60)] = "",
    ) -> dict:
        if not PHONE_NUMBER.match(phone):
            raise ToolError("Use an international number such as +919812345678.")
        missing = [] if sarvam and sarvam.ready else settings.missing(settings.call_settings)
        if reminders is None or missing:
            raise ToolError(
                f"Scheduled calls are not set up. Missing in .env: {', '.join(missing)}."
            )
        try:
            due = parse_when(when)
            await asyncio.to_thread(
                reminders.add,
                "contact_call",
                f"Call {name or phone}: {goal}",
                due,
                {"phone": phone, "name": name, "goal": goal, "opening": opening_line},
            )
        except OrganizerError as error:
            raise ToolError(str(error)) from error
        return {"friday_say": f"Okay, I'll call {name or 'them'} {spoken_time(due)}."}

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

    # Client calls for the owner's business (business.py): Friday's own line.

    @server.tool(
        name="call_client",
        title="Call a client for the business",
        description=(
            "Phone a client or customer for the owner's business: to sell, follow up or "
            "book a meeting. Friday speaks the client's language (any Indian language), "
            "answers from the business profile, books agreed meetings into the calendar "
            "and saves the client as a lead. Returns a call_id; then call get_call_result."
        ),
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
    )
    async def call_client(
        phone: Annotated[
            str, Field(description="Number in international format, e.g. +919812345678.")
        ],
        purpose: Literal["sales", "follow_up", "meeting"],
        name: Annotated[str, Field(description="The client's name.", max_length=80)] = "",
        about: Annotated[
            str,
            Field(
                description="Anything else for this call, e.g. what they asked about last time.",
                max_length=1000,
            ),
        ] = "",
        language: Annotated[
            str,
            Field(description=f"Language to start in: one of {', '.join(LANGUAGES)}."),
        ] = DEFAULT_LANGUAGE,
    ) -> dict:
        if not PHONE_NUMBER.match(phone):
            raise ToolError("Use an international number such as +919812345678.")
        if language not in LANGUAGES:
            raise ToolError(f"Unsupported language. Use one of: {', '.join(LANGUAGES)}.")
        if not business_profile(settings) or calendar is None:
            raise ToolError(
                "The business profile is not filled in yet: fill in friday/business.md "
                "so Friday knows what to tell clients."
            )
        missing = settings.missing(settings.call_settings)
        if missing:
            raise ToolError(f"Phone calls are not set up. Missing in .env: {', '.join(missing)}.")
        goal = PURPOSES[purpose] + (f" The client: {name}." if name else "")
        context = client_context(settings, calendar, name)
        if about:
            context += f"\n\nFor this call: {about}"
        record = await place_own_call(store, dialer, phone, goal, language, context, kind="client")
        if record.final:
            return record.result()
        return {
            **record.result(),
            "next_step": "Call get_call_result with this call_id to wait for the outcome.",
        }

    @server.tool(
        name="recent_leads",
        title="Recent leads from client calls",
        description="Who the latest client calls talked to and what they want, newest last.",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    async def recent_leads(count: Annotated[int, Field(ge=1, le=20)] = 5) -> dict:
        found = leads.recent(count) if leads is not None else []
        if not found:
            return {"leads": [], "friday_say": "No leads from calls yet."}
        lines = [lead_line(lead) for lead in found]
        return {"leads": found, "friday_say": "Latest leads: " + "; ".join(lines) + "."}

    return server
