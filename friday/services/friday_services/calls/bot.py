"""One phone call: Exotel audio -> Prisma -> Evon -> Timbre -> back to Exotel."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import aiohttp
from loguru import logger
from openai import AsyncOpenAI
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import EndWorkerFrame, LLMRunFrame, TTSSpeakFrame
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.serializers.exotel import ExotelFrameSerializer
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transcriptions.language import Language
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.workers.runner import WorkerRunner
from pipecat_gnani import GnaniSSETTSService

from friday_services.calls.language import reply_language, working_line
from friday_services.calls.prompts import (
    OUTCOMES,
    SUMMARY_PROMPT,
    client_prompt,
    owner_inbound_prompt,
    owner_prompt,
    phone_prompt,
    reception_prompt,
)
from friday_services.calls.store import CallRecord, CallStore
from friday_services.calls.stt import FramedGnaniSTTService, auto_language_settings
from friday_services.config import Settings
from friday_services.live_voice import allow_newer_timbre, one_voice_lock, steady_start
from friday_services.voices import LANGUAGES, voice_for

# Who Friday is talking to: someone for the owner, or the owner (either way).
PROMPTS = {
    "owner": owner_prompt,
    "owner_in": owner_inbound_prompt,
    "reception": reception_prompt,
    "client": client_prompt,
    "client_in": client_prompt,
}
# Calls with the owner, where Friday may do anything it can on the PC.
OWNER_KINDS = ("owner", "owner_in")
# Client calls for the owner's business: Friday calling them, or them calling.
CLIENT_KINDS = ("client", "client_in")

TELEPHONY_SAMPLE_RATE = 8000
# Timbre v3.0 sounds the most human and one voice speaks every Indian
# language, each reply in the language it is written in (FRIDAY_TTS_MODEL and
# FRIDAY_VOICE in .env change them). v2.5 has one voice per language.
TIMBRE_MODEL = "timbre-v3.0"
V3_VOICE = "Shivani"
MAX_CALL_SECONDS = 5 * 60
MAX_SILENCE_SECONDS = 45
# Exotel wants audio in chunks of at least 3.2 KB: 200 ms at 8 kHz.
EXOTEL_OUT_10MS_CHUNKS = 20
# ask_friday runs the request through the Friday Dot; PhoneDesk answers within 22 s.
ASK_FRIDAY_TIMEOUT_SECONDS = 30
# "One second" while ask_friday works, at most this often, so a request
# heard twice is not answered with "one second" twice.
WORKING_EVERY_SECS = 10.0
# The same request asked again this soon (a sentence heard in two turns) is
# the same request: it gets the first one's answer instead of running again.
SAME_ASK_SECS = 20.0

END_CALL = FunctionSchema(
    name="end_call",
    description="Hang up after saying goodbye, and record how the call went.",
    properties={
        "outcome": {"type": "string", "enum": list(OUTCOMES)},
        "summary": {
            "type": "string",
            "description": "One or two sentences for the owner about what was agreed.",
        },
        "details": {
            "type": "object",
            "description": "Facts worth keeping, e.g. confirmed_time, person, price_quoted.",
            "additionalProperties": {"type": "string"},
        },
    },
    required=["outcome", "summary"],
)
ASK_FRIDAY = FunctionSchema(
    name="ask_friday",
    description=(
        "Have Friday do what the owner asked on this call (messages, reminders, the "
        "calendar, the PC, searches), or pass on their yes or no to an OK Friday asked "
        "for. Returns the sentence to say back."
    ),
    properties={
        "request": {
            "type": "string",
            "description": "What the owner asked, in their own words.",
        },
    },
    required=["request"],
)
TAKE_MESSAGE = FunctionSchema(
    name="take_message",
    description="Save a message from the caller for the owner.",
    properties={
        "name": {"type": "string", "description": "Who is calling, as they said it."},
        "message": {"type": "string", "description": "The message, in a sentence or two."},
    },
    required=["message"],
)


@dataclass
class CallHelpers:
    """What a call can reach outside its pipeline (main.py wires these)."""

    # (record, request) -> what to say: the Friday Dot, for the owner's calls.
    ask: Callable[[CallRecord, str], Awaitable[str]] | None = None
    # (record, name, message): a caller's message, saved for the owner.
    take_message: Callable[[CallRecord, str, str], Awaitable[None]] | None = None
    # (record, date, time, name, topic) -> the booked event; raises when the
    # time is taken. Client calls only.
    book_meeting: Callable[[CallRecord, str, str, str, str], Awaitable[dict]] | None = None
    # (record, fields): a client call's lead, saved for the owner.
    save_lead: Callable[[CallRecord, dict[str, str]], Awaitable[None]] | None = None


BOOK_MEETING = FunctionSchema(
    name="book_meeting",
    description=(
        "Book a meeting the client agreed to into the owner's calendar. Fails if "
        "the time is already taken: then offer another time."
    ),
    properties={
        "date": {"type": "string", "description": "YYYY-MM-DD"},
        "time": {"type": "string", "description": "24-hour HH:MM, e.g. 16:00"},
        "name": {"type": "string", "description": "The client's name."},
        "topic": {"type": "string", "description": "What the meeting is about."},
    },
    required=["date", "time", "name"],
)
SAVE_LEAD = FunctionSchema(
    name="save_lead",
    description="Save who the client is and what they want, once per call.",
    properties={
        "name": {"type": "string"},
        "interest": {"type": "string", "description": "What they want or asked about."},
        "budget": {"type": "string", "description": "Budget or quantity, if they said."},
        "next_step": {
            "type": "string",
            "description": "What was agreed: a meeting, a callback, details on WhatsApp.",
        },
        "notes": {"type": "string", "description": "Questions to check with the team."},
    },
    required=["interest"],
)


@dataclass
class CallPipeline:
    pipeline: Pipeline
    worker: PipelineWorker
    transport: FastAPIWebsocketTransport
    ended_by_friday: asyncio.Event
    http: aiohttp.ClientSession | None = None


# Gemini wants each tool call it made sent back with its thought signature,
# which this client does not keep; Google's documented stand-in passes.
GEMINI_SIGNATURE = {"google": {"thought_signature": "skip_thought_signature_validator"}}


class CallLLM(OpenAILLMService):
    """Evon (or the model in its place) on a call. Gemini's thought signature
    arrives as a tool call with no name next to the real one, and every tool
    call sent back must carry a signature; otherwise every later request fails
    and Friday goes silent for the rest of the call. The nameless calls are
    dropped, and sent-back calls carry Google's stand-in signature."""

    gemini = False

    def build_chat_completion_params(self, params_from_context) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        if self.gemini and params.get("messages"):
            params["messages"] = [
                {
                    **message,
                    "tool_calls": [
                        {"extra_content": GEMINI_SIGNATURE, **call}
                        for call in message["tool_calls"]
                    ],
                }
                if isinstance(message, dict) and message.get("tool_calls")
                else message
                for message in params["messages"]
            ]
        return params

    async def run_function_calls(self, function_calls):
        named = [call for call in function_calls if call.function_name]
        if len(named) < len(function_calls):
            logger.warning(f"Dropped {len(function_calls) - len(named)} tool call(s) with no name")
        await super().run_function_calls(named)


def evon_llm(settings: Settings, **extra_settings: Any) -> OpenAILLMService:
    extra: dict[str, Any] = {}
    if settings.evon_disable_thinking:
        extra["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
    llm = CallLLM(
        api_key=settings.get("EVON_API_KEY") or "not-needed",
        base_url=settings.get("EVON_BASE_URL"),
        settings=OpenAILLMService.Settings(
            model=settings.get("EVON_MODEL"),
            temperature=0.6,
            max_completion_tokens=300,
            extra=extra,
            **extra_settings,
        ),
    )
    llm.gemini = "googleapis.com" in settings.get("EVON_BASE_URL")
    return llm


# Said the moment the call connects, so nobody waits on the model to start.
GREETINGS = {
    "en-IN": {
        "owner": "Hi {owner}, it's Friday.",
        "owner_in": "Hi {owner}, Friday here.",
        "reception": "Hello, this is Friday, {owner}'s AI assistant. How can I help?",
        "business": "Hello, this is Friday, an AI assistant calling for {owner}.",
        "client_in": "Hello, this is Friday, the AI assistant. How can I help you today?",
    },
    "hi-IN": {
        "owner": "हाय {owner}, मैं फ्राइडे।",
        "owner_in": "हाँ {owner}, फ्राइडे बोल रही हूँ।",
        "reception": "नमस्ते, मैं फ्राइडे हूँ, {owner} की AI असिस्टेंट। बताइए, क्या मदद करूँ?",
        "business": "नमस्ते, मैं फ्राइडे हूँ, {owner} की तरफ़ से कॉल कर रही AI असिस्टेंट।",
        "client_in": "नमस्ते, मैं फ्राइडे हूँ, AI असिस्टेंट। बताइए, मैं आपकी क्या मदद करूँ?",
    },
}
# A greeting that is a whole turn: Friday then waits for the caller.
COMPLETE_GREETINGS = ("reception", "client_in")


def first_words(record: CallRecord, owner: str) -> str:
    """What Friday says as soon as the call connects; empty when only the
    model knows (a language with no ready greeting)."""
    if record.opening:
        return record.opening
    lines = GREETINGS.get(record.language) or {}
    if record.kind == "client":
        return ""  # the model says who it is and why, from the business profile
    line = lines.get(record.kind) or lines.get("business", "")
    return line.format(owner=owner)


def end_call_handler(store: CallStore, record: CallRecord, ended: asyncio.Event):
    async def end_call(params: FunctionCallParams):
        args = dict(params.arguments)
        outcome = args.get("outcome") if args.get("outcome") in OUTCOMES else "other"
        details = {str(k): str(v) for k, v in (args.get("details") or {}).items()}
        store.finish(
            record.id,
            "answered",
            outcome=outcome,
            summary=str(args.get("summary") or ""),
            details=details,
        )
        ended.set()
        await params.result_callback({"ok": True})
        # Ends the pipeline after queued speech; Exotel's flow then hangs up.
        await params.llm.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)

    return end_call


def _same_ask(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.lower()))


def ask_friday_handler(
    record: CallRecord,
    ask: Callable[[CallRecord, str], Awaitable[str]],
    clock: Callable[[], float] = time.monotonic,
):
    """Runs the owner's request through Friday. The same request asked again
    soon after (the model calling it twice, a sentence heard in two turns) is
    answered from the first run instead of doing the task twice."""
    recent: dict[str, tuple[float, asyncio.Task]] = {}

    async def run(request: str) -> str:
        try:
            return await ask(record, request)
        except Exception as error:
            logger.warning(f"[{record.id}] ask_friday failed: {error}")
            return f"Sorry, that did not work: {error}"

    async def ask_friday(params: FunctionCallParams):
        request = str(params.arguments.get("request") or "")
        key, now = _same_ask(request), clock()
        earlier = recent.get(key)
        if earlier and now - earlier[0] < SAME_ASK_SECS:
            task = earlier[1]
        else:
            task = asyncio.ensure_future(run(request))
            recent[key] = (now, task)
        reply = await asyncio.shield(task)
        await params.result_callback({"reply": reply})

    return ask_friday


def book_meeting_handler(
    record: CallRecord, book: Callable[[CallRecord, str, str, str, str], Awaitable[dict]]
):
    async def book_meeting(params: FunctionCallParams):
        args = dict(params.arguments)
        try:
            event = await book(
                record,
                str(args.get("date") or ""),
                str(args.get("time") or ""),
                str(args.get("name") or ""),
                str(args.get("topic") or ""),
            )
            record.details["meeting"] = f"{event.get('date')} {event.get('time')}"
            result = {"booked": True, "date": event.get("date"), "time": event.get("time")}
        except Exception as error:
            result = {"booked": False, "error": str(error)}
        await params.result_callback(result)

    return book_meeting


def save_lead_handler(
    record: CallRecord, save: Callable[[CallRecord, dict[str, str]], Awaitable[None]]
):
    saved: list[bool] = []

    async def save_lead(params: FunctionCallParams):
        if saved:  # once per call: a second call only repeats it
            await params.result_callback({"saved": True})
            return
        fields = {str(k): str(v) for k, v in dict(params.arguments).items() if v}
        await save(record, fields)
        saved.append(True)
        await params.result_callback({"saved": True})

    return save_lead


def call_voice(settings: Settings, record: CallRecord, http: aiohttp.ClientSession, heard):
    """Timbre for a call, at the phone line's 8 kHz: each reply in the language
    it is written in (heard() is the caller's language, for replies in Latin
    letters), started only once enough audio is in so it never stutters."""
    import pipecat_gnani.tts

    allow_newer_timbre(pipecat_gnani.tts)
    model = settings.get("FRIDAY_TTS_MODEL") or TIMBRE_MODEL
    v3 = model.startswith("timbre-v3")
    fixed_voice = settings.get("FRIDAY_VOICE") or (V3_VOICE if v3 else "")

    class CallVoice(GnaniSSETTSService):
        async def run_tts(self, text: str, context_id: str):
            code = reply_language(text, heard())
            try:
                self._settings.language = Language(code)
            except ValueError:
                pass
            if not v3 and not settings.get("FRIDAY_VOICE") and code in LANGUAGES:
                self._settings.voice = LANGUAGES[code].voice
            async with one_voice_lock():
                async for frame in steady_start(super().run_tts(text, context_id)):
                    yield frame

    return CallVoice(
        api_key=settings.get("GNANI_API_KEY"),
        aiohttp_session=http,
        voice_id=fixed_voice or voice_for(record.language).voice,
        model=model,
        sample_rate=TELEPHONY_SAMPLE_RATE,
    )


def auto_language_on(settings: Settings) -> bool:
    """Calls follow the caller's language unless FRIDAY_CALL_AUTO_LANGUAGE=false."""
    return settings.get("FRIDAY_CALL_AUTO_LANGUAGE", "true").lower() != "false"


def take_message_handler(
    record: CallRecord, take: Callable[[CallRecord, str, str], Awaitable[None]]
):
    async def take_message(params: FunctionCallParams):
        args = dict(params.arguments)
        await take(record, str(args.get("name") or ""), str(args.get("message") or ""))
        await params.result_callback({"saved": True})

    return take_message


def call_transport(websocket: Any, stream_sid: str, call_sid: str) -> FastAPIWebsocketTransport:
    """The call's audio over Exotel's WebSocket; Exotel's call flow hangs up
    when the socket closes."""
    return FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            audio_out_10ms_chunks=EXOTEL_OUT_10MS_CHUNKS,
            serializer=ExotelFrameSerializer(stream_sid=stream_sid, call_sid=call_sid),
        ),
    )


def build_call_pipeline(
    websocket: Any,
    *,
    stream_sid: str,
    call_sid: str,
    record: CallRecord,
    store: CallStore,
    settings: Settings,
    helpers: CallHelpers | None = None,
) -> CallPipeline:
    """Wire the pipeline for one call. Nothing connects until it runs."""
    gnani_key = settings.get("GNANI_API_KEY")
    helpers = helpers or CallHelpers()
    transport = call_transport(websocket, stream_sid, call_sid)
    tools = [END_CALL]
    if record.kind in OWNER_KINDS and helpers.ask:
        tools.append(ASK_FRIDAY)
    if record.kind in ("reception", *CLIENT_KINDS) and helpers.take_message:
        tools.append(TAKE_MESSAGE)
    if record.kind in CLIENT_KINDS and helpers.book_meeting:
        tools.append(BOOK_MEETING)
    if record.kind in CLIENT_KINDS and helpers.save_lead:
        tools.append(SAVE_LEAD)
    auto = auto_language_on(settings)
    # Prisma finds the caller's language itself (indic-auto), turn by turn.
    stt = FramedGnaniSTTService(
        api_key=gnani_key,
        sample_rate=TELEPHONY_SAMPLE_RATE,
        settings=auto_language_settings(format="transcribe")
        if auto
        else FramedGnaniSTTService.Settings(
            language=Language(record.language), format="transcribe"
        ),
    )
    if auto:
        stt.heard = record.language  # until the caller first speaks
    llm = evon_llm(settings)
    http = aiohttp.ClientSession()
    tts = call_voice(settings, record, http, lambda: stt.heard)
    greeting = first_words(record, settings.owner_name)
    start = (
        f'[The call has just been answered and you have already said: "{greeting}". '
        "Do not greet or introduce yourself again; go straight on.]"
        if greeting
        else "[The call has just been answered. Speak first.]"
    )
    context = LLMContext(
        messages=[
            {
                "role": "system",
                "content": PROMPTS.get(record.kind, phone_prompt)(
                    record, settings.owner_name, settings.timezone, auto_language=auto
                ),
            },
            {"role": "user", "content": start},
        ],
        tools=ToolsSchema(standard_tools=tools),
    )
    user, assistant = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
    )
    pipeline = Pipeline([transport.input(), stt, user, llm, tts, transport.output(), assistant])

    # Target: under about 2 s from the end of their speech to Friday's first audio.
    latency = UserBotLatencyObserver()

    @latency.event_handler("on_latency_measured")
    async def on_latency(_observer, seconds: float):
        milliseconds = round(seconds * 1000)
        store.add_latency(record.id, milliseconds)
        logger.info(f"[{record.id}] end of speech -> first audio: {milliseconds} ms")

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=TELEPHONY_SAMPLE_RATE,
            audio_out_sample_rate=TELEPHONY_SAMPLE_RATE,
            enable_metrics=True,
        ),
        observers=[latency],
        idle_timeout_secs=MAX_SILENCE_SECONDS,
    )
    ended_by_friday = asyncio.Event()
    llm.register_function("end_call", end_call_handler(store, record, ended_by_friday))
    if ASK_FRIDAY in tools:
        # Friday waits for the answer before it speaks. If the owner talks
        # over it, the request still finishes (PhoneDesk keeps it running and
        # tells them when they ask).
        llm.register_function(
            "ask_friday",
            ask_friday_handler(record, helpers.ask),
            timeout_secs=ASK_FRIDAY_TIMEOUT_SECONDS,
        )

        said_working = [0.0]

        @llm.event_handler("on_function_calls_started")
        async def on_working(service, function_calls):
            if not any(call.function_name == "ask_friday" for call in function_calls):
                return
            if time.monotonic() - said_working[0] < WORKING_EVERY_SECS:
                return
            said_working[0] = time.monotonic()
            await service.push_frame(TTSSpeakFrame(working_line(stt.heard)))

    if TAKE_MESSAGE in tools:
        llm.register_function("take_message", take_message_handler(record, helpers.take_message))
    if BOOK_MEETING in tools:
        llm.register_function("book_meeting", book_meeting_handler(record, helpers.book_meeting))
    if SAVE_LEAD in tools:
        llm.register_function("save_lead", save_lead_handler(record, helpers.save_lead))

    @transport.event_handler("on_client_connected")
    async def on_connected(_transport, _client):
        store.set_stage(record.id, "in_progress")
        frames = [TTSSpeakFrame(greeting)] if greeting else []
        if not (greeting and record.opening == "" and record.kind in COMPLETE_GREETINGS):
            # The model goes on (why Friday called, the updates) while the
            # greeting plays.
            frames.append(LLMRunFrame())
        await worker.queue_frames(frames)

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        await worker.cancel(reason="caller hung up")

    @user.event_handler("on_user_turn_stopped")
    async def on_their_turn(_aggregator, _strategy, message):
        store.add_turn(record.id, "them", message.content or "")

    @assistant.event_handler("on_assistant_turn_stopped")
    async def on_friday_turn(_aggregator, message):
        store.add_turn(record.id, "friday", message.content or "")

    return CallPipeline(
        pipeline=pipeline,
        worker=worker,
        transport=transport,
        ended_by_friday=ended_by_friday,
        http=http,
    )


async def summarize(settings: Settings, record: CallRecord) -> dict[str, Any]:
    """Ask Evon for an outcome when the call ended without end_call."""
    if not record.transcript:
        return {"outcome": "other", "summary": "The call connected but nobody spoke."}
    client = AsyncOpenAI(
        api_key=settings.get("EVON_API_KEY") or "not-needed",
        base_url=settings.get("EVON_BASE_URL"),
    )
    lines = "\n".join(record.result()["transcript"])
    extra = (
        {"chat_template_kwargs": {"enable_thinking": False}}
        if settings.evon_disable_thinking
        else {}
    )
    try:
        reply = await client.chat.completions.create(
            model=settings.get("EVON_MODEL"),
            messages=[
                {"role": "system", "content": SUMMARY_PROMPT},
                {"role": "user", "content": f"Goal: {record.goal}\n\nTranscript:\n{lines}"},
            ],
            max_completion_tokens=300,
            extra_body=extra or None,
        )
        text = reply.choices[0].message.content or ""
        data = json.loads(text[text.find("{") : text.rfind("}") + 1])
        outcome = data.get("outcome") if data.get("outcome") in OUTCOMES else "other"
        return {
            "outcome": outcome,
            "summary": str(data.get("summary") or ""),
            "details": {str(k): str(v) for k, v in (data.get("details") or {}).items()},
        }
    except Exception as error:  # the transcript is still returned
        logger.warning(f"[{record.id}] summary failed: {error}")
        return {"outcome": "other", "summary": "The call ended. See the transcript."}
    finally:
        await client.close()


async def run_call(
    websocket: Any,
    *,
    stream_sid: str,
    call_sid: str,
    record: CallRecord,
    store: CallStore,
    settings: Settings,
    helpers: CallHelpers | None = None,
) -> None:
    store.set_stage(record.id, "in_progress")
    record.stream_started = True
    call = build_call_pipeline(
        websocket,
        stream_sid=stream_sid,
        call_sid=call_sid,
        record=record,
        store=store,
        settings=settings,
        helpers=helpers,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(call.worker)
    try:
        await asyncio.wait_for(runner.run(), MAX_CALL_SECONDS)
    except TimeoutError:
        await call.worker.cancel(reason="call time limit")
        store.finish(
            record.id,
            "answered",
            outcome="other",
            summary=f"Friday stopped the call after {MAX_CALL_SECONDS // 60} minutes.",
        )
    except Exception as error:
        logger.exception(f"[{record.id}] call pipeline failed")
        store.finish(record.id, "failed", error=f"Call audio failed: {error}")
    finally:
        if call.http is not None:
            await call.http.close()
    if not store.get(record.id).final:
        store.finish(record.id, "answered", **await summarize(settings, record))
