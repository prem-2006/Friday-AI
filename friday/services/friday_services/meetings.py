"""Google Calendar events, pre-filled from what the owner said.

Friday opens Calendar's own "new event" page with the details filled in and
saves it (sending the invitations when there are guests) only after the owner
approves the summary.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from urllib.parse import urlencode

STAMP = "%Y%m%dT%H%M%S"


class MeetingError(ValueError):
    pass


def calendar_event_url(
    title: str,
    start: str,
    minutes: int = 30,
    guests: list[str] | None = None,
    details: str = "",
    timezone: str = "Asia/Kolkata",
    account: str | None = None,
) -> str:
    try:
        begins = datetime.fromisoformat(start)
    except ValueError as error:
        raise MeetingError("Give the start as a date and time, e.g. 2026-10-24T15:00.") from error
    if begins.tzinfo is not None:
        begins = begins.replace(tzinfo=None)  # read as local time in `timezone`
    if not 5 <= minutes <= 24 * 60:
        raise MeetingError("A meeting runs between 5 minutes and a day.")
    for guest in guests or []:
        if "@" not in guest:
            raise MeetingError(f"{guest} is not an email address.")
    query = {
        "action": "TEMPLATE",
        "text": title,
        "dates": f"{begins.strftime(STAMP)}/{(begins + timedelta(minutes=minutes)).strftime(STAMP)}",
        "ctz": timezone,
    }
    if details:
        query["details"] = details
    if guests:
        query["add"] = ",".join(guests)
    if account:
        query["authuser"] = account
    return "https://calendar.google.com/calendar/render?" + urlencode(query)
