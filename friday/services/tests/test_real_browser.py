"""The real on-screen browser code driving Chrome (headless here) through the
demo calendar, the same way the Navigator Dot would."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from friday_services.browser import BrowserError, OnScreenBrowser

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
pytestmark = pytest.mark.skipif(
    not CHROME.exists() and not shutil.which("chrome"), reason="Chrome is not installed"
)


def ref_of(elements: str, label: str) -> int:
    for line in elements.splitlines():
        if f'"{label}' in line:
            return int(line[1 : line.index("]")])
    raise AssertionError(f"{label!r} not in:\n{elements}")


def test_fills_in_the_calendar_like_navigator(server, tmp_path):
    browser = OnScreenBrowser(tmp_path / "profile", headless=True)
    try:
        page = browser.open(f"{server.url}/calendar")
        assert page["title"] == "Friday demo calendar"
        page = browser.type(ref_of(page["elements"], "Title"), "Dentist", press_enter=False)
        page = browser.type(ref_of(page["elements"], "Date"), "2026-10-23", press_enter=False)
        page = browser.type(ref_of(page["elements"], "Time"), "18:00", press_enter=False)
        page = browser.click(ref_of(page["elements"], "Add event"))
        assert "Added: Dentist on 2026-10-23 at 18:00." in browser.read()["text"]
        assert browser.screenshot()  # the owner's live view gets a picture
        with pytest.raises(BrowserError, match="No element"):
            browser.click(999)
    finally:
        browser.close()
