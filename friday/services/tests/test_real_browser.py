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


FAKE_HOME = """<!doctype html><title>YouTube</title>
<form action="/results"><input name="search_query" aria-label="Search"></form>"""
FAKE_RESULTS = """<!doctype html><title>results - YouTube</title><body>
<a href="/shorts/s1">Top 5 Python channels #shorts</a>
<a href="/watch?v=v1">Watch</a>
<a href="/watch?v=v1" title="Python full course for beginners">Python full course for beginners</a>
<a href="/@coreyms">Corey Schafer</a>
<a href="/watch?v=v2">12:34</a>
</body>"""


def test_search_types_in_youtubes_box_and_ranks_results(tmp_path):
    browser = OnScreenBrowser(tmp_path / "profile", headless=True)
    try:
        browser._page()  # start Chrome so a pretend YouTube can be served offline

        def serve(route):
            html = FAKE_RESULTS if "/results" in route.request.url else FAKE_HOME
            route.fulfill(status=200, content_type="text/html", body=html)

        browser._context.route("https://www.youtube.com/**", serve)
        found = browser.search("youtube", "best python channel")
        assert found["site"] == "YouTube"
        assert "search_query=best+python+channel" in found["url"]
        assert [(r["kind"], r["title"]) for r in found["results"]] == [
            ("channel", "Corey Schafer"),
            ("video", "Python full course for beginners"),
            ("short", "Top 5 Python channels #shorts"),
        ]
        with pytest.raises(BrowserError, match="YouTube or Google"):
            browser.search("bing", "x")
    finally:
        browser.close()
