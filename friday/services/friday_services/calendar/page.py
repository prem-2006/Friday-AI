"""The calendar web page: plain HTML with clearly labelled fields, so a
browser agent can read it and fill it in."""

from __future__ import annotations

from html import escape

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from friday_services.calendar.store import CalendarStore, InvalidEvent

STYLE = """
body { font-family: system-ui, sans-serif; max-width: 640px; margin: 32px auto; padding: 0 16px; color: #333641; }
h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 28px; }
form { display: grid; gap: 10px; }
label { display: grid; gap: 4px; font-size: 14px; }
input, textarea, button { font: inherit; padding: 8px; border: 1px solid #ccc; border-radius: 8px; }
button { background: #5269bb; color: white; border: 0; cursor: pointer; }
.notice { padding: 10px 12px; border-radius: 8px; background: #eef7ee; }
.error { background: #fbecec; }
li { margin: 6px 0; }
"""


def render(store: CalendarStore, *, notice: str = "", error: str = "") -> str:
    events = store.list()
    items = (
        "".join(
            f'<li data-event-id="{escape(e["id"])}"><strong>{escape(e["date"])} {escape(e["time"])}</strong>'
            f" — {escape(e['title'])}{(' (' + escape(e['notes']) + ')') if e['notes'] else ''}</li>"
            for e in events
        )
        or "<li>No events yet.</li>"
    )
    banner = (
        f'<p class="notice error" role="alert">{escape(error)}</p>'
        if error
        else f'<p class="notice" role="status">{escape(notice)}</p>'
        if notice
        else ""
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Friday demo calendar</title><style>{STYLE}</style></head>
<body>
<h1>Friday demo calendar</h1>
{banner}
<h2>Add an event</h2>
<form method="post" action="/calendar/events">
  <label for="title">Title <input id="title" name="title" required maxlength="120"></label>
  <label for="date">Date <input id="date" name="date" type="date" required></label>
  <label for="time">Time <input id="time" name="time" type="time" required></label>
  <label for="notes">Notes <textarea id="notes" name="notes" maxlength="500" rows="3"></textarea></label>
  <button type="submit">Add event</button>
</form>
<h2>Upcoming events</h2>
<ul id="events">{items}</ul>
</body></html>"""


def add_calendar_page(app: FastAPI, store: CalendarStore) -> None:
    @app.get("/calendar", response_class=HTMLResponse)
    async def calendar_page(added: str | None = None) -> str:
        event = next((e for e in store.list() if e["id"] == added), None) if added else None
        notice = f"Added: {event['title']} on {event['date']} at {event['time']}." if event else ""
        return render(store, notice=notice)

    @app.post("/calendar/events", response_model=None)
    async def add_event(request: Request) -> RedirectResponse | HTMLResponse:
        form = await request.form()
        try:
            event = store.add(
                str(form.get("title", "")),
                str(form.get("date", "")),
                str(form.get("time", "")),
                str(form.get("notes", "")),
                source="browser",
            )
        except InvalidEvent as error:
            return HTMLResponse(render(store, error=str(error)), status_code=400)
        return RedirectResponse(f"/calendar?added={event['id']}", status_code=303)
