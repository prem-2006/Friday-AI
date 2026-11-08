"""The business dashboard (#/business in the app): the owner's clients across
India, each called by Friday in their own language with one click, and what
came of it: the live call, outcomes, leads and booked meetings.

Clients live in data/friday-clients.json. The examples it starts with have no
phone numbers: Friday never calls anyone the owner did not add a number for.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request

from friday_services.business import business_profile, client_context
from friday_services.calls.language import NAMES
from friday_services.voices import LANGUAGES

PHONE = re.compile(r"^\+[1-9]\d{7,14}$")
PURPOSES = {
    "sales": "Introduce what fits them from the business profile and try to make a sale "
    "or book a meeting.",
    "follow_up": "Follow up on their interest, answer questions and agree a next step.",
    "meeting": "Book a meeting with them at a time that suits both sides.",
}
# Where each city is, for the regions on the dashboard.
REGIONS = {
    "North": "delhi noida gurugram gurgaon lucknow jaipur chandigarh amritsar ludhiana "
    "kanpur varanasi agra dehradun",
    "West": "mumbai pune nagpur nashik ahmedabad surat vadodara rajkot goa indore bhopal",
    "South": "bengaluru bangalore mysuru mysore chennai coimbatore madurai hyderabad "
    "vijayawada visakhapatnam kochi thiruvananthapuram kozhikode mangaluru",
    "East": "kolkata howrah bhubaneswar cuttack patna ranchi guwahati siliguri",
}
# Example clients, one for each language, to show how Friday speaks to all of
# India. They have no number until the owner adds one (their own, a friend's).
EXAMPLES = [
    ("Ramesh Iyer", "Chennai", "ta-IN", "Asked about rooftop solar for his house"),
    ("Lakshmi Reddy", "Hyderabad", "te-IN", "Runs a small hostel, wants lower power bills"),
    ("Manjunath Gowda", "Bengaluru", "kn-IN", "Interested in the 3 kW plan"),
    ("Anjali Nair", "Kochi", "ml-IN", "Wants a site visit"),
    ("Sneha Patil", "Pune", "mr-IN", "Follow up on last week's quote"),
    ("Hardik Shah", "Ahmedabad", "gu-IN", "Owns a shop, asked about EMI"),
    ("Gurpreet Singh", "Ludhiana", "pa-IN", "Wants a meeting this week"),
    ("Sourav Das", "Kolkata", "bn-IN", "Asked for prices"),
    ("Neha Sharma", "Delhi", "hi-IN", "New lead from the website"),
    ("Arjun Mehta", "Mumbai", "en-IN", "Office building, wants a call back"),
]


def region_of(city: str) -> str:
    key = city.strip().lower()
    return next((name for name, cities in REGIONS.items() if key in cities.split()), "Other")


class ClientBook:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()

    def _read(self) -> list[dict]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return [
                {
                    "id": f"client_ex{n}",
                    "name": name,
                    "city": city,
                    "language": language,
                    "phone": "",
                    "note": note,
                    "example": True,
                }
                for n, (name, city, language, note) in enumerate(EXAMPLES)
            ]
        return data if isinstance(data, list) else []

    def _write(self, clients: list[dict]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(clients, ensure_ascii=False, indent=2), encoding="utf-8")

    def all(self) -> list[dict]:
        return self._read()

    def get(self, client_id: str) -> dict | None:
        return next((c for c in self._read() if c.get("id") == client_id), None)

    def save(self, fields: dict[str, Any], client_id: str | None = None) -> dict:
        name = str(fields.get("name") or "").strip()[:80]
        phone = re.sub(r"[\s-]", "", str(fields.get("phone") or ""))
        city = str(fields.get("city") or "").strip()[:60]
        language = str(fields.get("language") or "en-IN")
        note = str(fields.get("note") or "").strip()[:300]
        if not name:
            raise ValueError("Give the client a name.")
        if phone and not PHONE.match(phone):
            raise ValueError("Use an international number such as +919812345678.")
        if language not in LANGUAGES:
            raise ValueError(f"Choose a language: {', '.join(LANGUAGES)}.")
        with self._lock:
            clients = self._read()
            client = next((c for c in clients if c.get("id") == client_id), None)
            if client is None:
                client = {"id": f"client_{uuid.uuid4().hex[:10]}", "added": time.time()}
                clients.append(client)
            client.update(name=name, phone=phone, city=city, language=language, note=note)
            if phone:
                client.pop("example", None)  # a real client now
            self._write(clients)
        return client

    def remove(self, client_id: str) -> bool:
        with self._lock:
            clients = self._read()
            kept = [c for c in clients if c.get("id") != client_id]
            self._write(kept)
        return len(kept) < len(clients)


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", phone)[-10:]


def _call_view(call: dict) -> dict:
    """A client call as the dashboard shows it."""
    transcript = call.get("transcript") or []
    lines = [
        {
            "who": "friday" if line.get("speaker") == "friday" else "client",
            "text": line.get("text", ""),
        }
        for line in transcript
        if isinstance(line, dict)
    ]
    details = call.get("details") or {}
    return {
        "id": call.get("id") or call.get("call_id"),
        "phone": call.get("phone"),
        "status": call.get("status"),
        "outcome": call.get("outcome"),
        "summary": call.get("summary"),
        "language": details.get("heard_language") or call.get("language"),
        "meeting": details.get("meeting"),
        "lines": lines,
        "at": call.get("created_at"),
        "error": call.get("error"),
    }


def add_business_page(
    app: FastAPI,
    owner: Any,
    *,
    settings: Any,
    store: Any,
    dialer: Any,
    calendar: Any,
    leads: Any,
    clients: ClientBook,
    place_call: Any,
) -> None:
    """Routes for the dashboard. place_call(phone, goal, language, context)
    starts a client call and returns its record."""

    def client_calls() -> list[dict]:
        live = [
            {
                "id": record.id,
                "phone": record.phone,
                "status": record.status,
                "outcome": record.outcome,
                "summary": record.summary,
                "details": record.details,
                "transcript": record.transcript,
                "language": record.language,
                "created_at": record.created_at,
                "error": record.error,
            }
            for record in store.live()
            if record.kind in ("client", "client_in")
        ]
        saved = [c for c in store.recent(60) if c.get("kind") in ("client", "client_in")]
        seen = {c["id"] for c in live}
        return [*live, *[c for c in saved if c.get("id") not in seen]]

    @app.get("/business", dependencies=[Depends(owner)])
    async def overview() -> dict:
        profile = business_profile(settings)
        calls = [_call_view(c) for c in client_calls()]
        by_phone: dict[str, dict] = {}
        for call in calls:  # newest first
            by_phone.setdefault(_digits(call["phone"] or ""), call)
        shown = []
        for client in clients.all():
            last = by_phone.get(_digits(client.get("phone") or "")) if client.get("phone") else None
            shown.append(
                {
                    **client,
                    "region": region_of(client.get("city", "")),
                    "language_name": NAMES.get(client.get("language", ""), ""),
                    "last_call": last,
                }
            )
        title = next(
            (line.lstrip("# ").strip() for line in profile.splitlines() if line.startswith("#")),
            "",
        )
        meetings = [e for e in calendar.list() if e.get("source") == "call"]
        busy = store.active()
        missing = settings.missing(settings.call_settings)
        return {
            "business": {"ready": bool(profile), "name": title},
            "calls_ready": not missing,
            "missing": missing,
            "busy": busy.id if busy else None,
            "clients": shown,
            "calls": calls[:20],
            "leads": list(reversed(leads.recent(20))),
            "meetings": meetings[-20:],
            "languages": {code: NAMES.get(code, code) for code in LANGUAGES},
        }

    @app.post("/business/clients", dependencies=[Depends(owner)])
    async def add_client(request: Request) -> dict:
        try:
            return clients.save(await request.json())
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.put("/business/clients/{client_id}", dependencies=[Depends(owner)])
    async def edit_client(client_id: str, request: Request) -> dict:
        if not clients.get(client_id):
            raise HTTPException(404, "No such client.")
        try:
            return clients.save(await request.json(), client_id)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.delete("/business/clients/{client_id}", dependencies=[Depends(owner)])
    async def remove_client(client_id: str) -> dict:
        return {"removed": clients.remove(client_id)}

    @app.post("/business/clients/{client_id}/call", dependencies=[Depends(owner)])
    async def call_client(client_id: str, request: Request) -> dict:
        client = clients.get(client_id)
        if not client:
            raise HTTPException(404, "No such client.")
        if not client.get("phone"):
            raise HTTPException(400, "Add the client's phone number first.")
        if not business_profile(settings):
            raise HTTPException(
                400,
                "Fill in the business profile (friday/business.md) so Friday knows what to say.",
            )
        missing = settings.missing(settings.call_settings)
        if missing:
            raise HTTPException(
                400, f"Phone calls are not set up. Missing in .env: {', '.join(missing)}."
            )
        if store.active():
            raise HTTPException(409, "Friday is already on a call. Wait for it to end.")
        body = await request.json() if await request.body() else {}
        purpose = body.get("purpose") if body.get("purpose") in PURPOSES else "sales"
        name = client.get("name", "")
        goal = f"{PURPOSES[purpose]} The client: {name}."
        context = client_context(settings, calendar, name)
        if client.get("note"):
            context += f"\n\nAbout this client: {client['note']}"
        record = await place_call(client["phone"], goal, client.get("language", "en-IN"), context)
        if record.final:
            raise HTTPException(502, record.error or "The call could not be placed.")
        return {"call_id": record.id, "status": record.status}
