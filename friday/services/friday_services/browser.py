"""A real Chrome window on the owner's screen that the Navigator Dot drives.

It uses its own profile (data/browser-profile), so the owner's personal Chrome
logins are never touched. The owner may sign in to one Google account in it
(they type the password themselves); Friday then works in Gmail, Calendar and
Drive there. Pages are described as numbered elements, which a text-only model
like Evon can act on.

On the owner's screen it is an ordinary Chrome process with a debugging port
on 127.0.0.1, which Playwright and the browser-use agent attach to. Chrome
started by Playwright itself is marked as automated, and Google refuses to
sign in there. Tests use a headless Playwright Chrome instead.
"""

from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

# Gives every visible interactive element a number and describes it.
SNAPSHOT_JS = """
() => {
  document.querySelectorAll('[data-friday-ref]').forEach(e => e.removeAttribute('data-friday-ref'));
  const selector = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [contenteditable=true]';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') continue;
    if (box.bottom < 0 || box.top > innerHeight * 3) continue;
    n += 1;
    el.setAttribute('data-friday-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') + ' field' : tag);
    const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.innerText || el.value || el.title || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const value = (tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value ? ` = "${String(el.value).slice(0, 40)}"` : '';
    out.push(`[${n}] ${role} "${label}"${value}`);
    if (n >= 150) break;
  }
  return out;
}
"""

# Where each site's search box is, and its results page as a fallback.
SEARCH_SITES = {
    "youtube": {
        "name": "YouTube",
        "home": "https://www.youtube.com/",
        "box": "input[name=search_query]",
        "results": "https://www.youtube.com/results?search_query=",
        "ready": 'a[href*="/watch?v="], a[href^="/shorts/"], a[href^="/@"]',
    },
    "google": {
        "name": "Google",
        "home": "https://www.google.com/",
        "box": "textarea[name=q], input[name=q]",
        "results": "https://www.google.com/search?q=",
        "ready": "#search a h3, #rso a h3",
    },
    # Used when Google asks "are you a robot?"; Friday never solves CAPTCHAs.
    "duckduckgo": {
        "name": "DuckDuckGo",
        "home": "https://html.duckduckgo.com/html/",
        "box": "input[name=q]",
        "results": "https://html.duckduckgo.com/html/?q=",
        "ready": "a.result__a",
    },
}

# The top results as title, link and kind, read from links, not from the
# sites' internal component names, which change often.
RESULTS_JS = r"""
(site) => {
  const seen = new Set();
  const out = [];
  const links =
    site === 'youtube'
      ? [...document.querySelectorAll('a[href*="/watch?v="], a[href^="/shorts/"], a[href^="/@"]')]
      : site === 'google'
        ? [...document.querySelectorAll('#search a h3, #rso a h3')].map((h) => h.closest('a'))
        : [...document.querySelectorAll('a.result__a')];
  for (const a of links) {
    if (!a) continue;
    const box = a.getBoundingClientRect();
    const title = (a.getAttribute('title') || a.innerText || a.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim();
    const url = a.href.split('&pp=')[0];
    // Thumbnails are labelled "Watch" or with a duration; the real title link follows.
    if (!title || title.length < 6 || /^(watch|play|\d+:\d+)/i.test(title) || !box.width || seen.has(url)) continue;
    seen.add(url);
    const kind = url.includes('/shorts/') ? 'short' : url.includes('/@') ? 'channel' : url.includes('watch?v=') ? 'video' : 'page';
    out.push({ title: title.slice(0, 140), url, kind });
    if (out.length >= 16) break;
  }
  // Full videos and channels first: "best" answers rarely live in Shorts.
  const rank = { channel: 0, video: 1, page: 1, short: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 8);
}
"""

SENSITIVE_FIELD_JS = """
(el) => el.type === 'password' || /^cc-|one-time-code/.test(el.autocomplete || '')
"""


# Cookies Google sets once someone is signed in.
GOOGLE_SESSION_COOKIES = {"SID", "__Secure-1PSID", "__Secure-3PSID"}
GOOGLE_SIGN_IN = (
    "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2F"
)

# The words on whatever is about to be clicked.
LABEL_JS = """
(el) => (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.innerText || el.value || '').trim()
"""
SENDING_NEEDS_OK = (
    "Sending needs the owner's OK. Leave the draft open and tell Friday it is ready: "
    "Friday reads it back and sends it once the owner approves."
)


class BrowserError(RuntimeError):
    pass


def find_chrome() -> str:
    """Where Google Chrome is installed (FRIDAY_CHROME_PATH overrides)."""
    for base in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        root = os.environ.get(base)
        if root:
            candidate = Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if candidate.exists():
                return str(candidate)
    found = shutil.which("chrome") or shutil.which("google-chrome")
    if not found:
        raise BrowserError("Google Chrome is not installed. Install it or set FRIDAY_CHROME_PATH.")
    return found


def is_send_label(label: str) -> bool:
    return bool(re.match(r"send\b", label.strip(), re.IGNORECASE))


def _check_url(url: str) -> str:
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    return url


class OnScreenBrowser:
    """Use only from one thread (see worker.Worker)."""

    def __init__(
        self,
        profile_dir: Path,
        channel: str = "chrome",
        headless: bool = False,
        user_agent: str | None = None,
        cdp_port: int | None = None,
        chrome_path: str | None = None,
    ):
        self._profile_dir = profile_dir
        self._chrome_path = chrome_path
        # Its own Chrome process on the owner's screen (see the module notes).
        self._own_window = cdp_port is not None and not headless
        self._cdp_browser: Any = None
        # The browser-use agent attaches to this same window over Chrome's
        # debugging port, which Chrome serves on 127.0.0.1 only.
        self._cdp_port = cdp_port
        self._channel = channel
        self._headless = headless  # tests only; the owner should see the window
        self._user_agent = user_agent  # tests only
        self._playwright: Any = None
        self._context: Any = None

    def _attach(self):
        """Connects to Friday's Chrome, starting it first if it is not running."""
        url = f"http://127.0.0.1:{self._cdp_port}"
        chromium = self._playwright.chromium
        try:
            browser = chromium.connect_over_cdp(url, timeout=1500)
        except Exception:
            subprocess.Popen(
                [
                    self._chrome_path or find_chrome(),
                    f"--user-data-dir={self._profile_dir}",
                    f"--remote-debugging-port={self._cdp_port}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--start-maximized",
                    # "Play X on YouTube" should start playing, with sound.
                    "--autoplay-policy=no-user-gesture-required",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            deadline = time.monotonic() + 20
            while True:
                try:
                    browser = chromium.connect_over_cdp(url, timeout=2000)
                    break
                except Exception as error:
                    if time.monotonic() > deadline:
                        raise BrowserError("Friday's Chrome window did not start.") from error
                    time.sleep(0.3)
        self._cdp_browser = browser
        return browser.contexts[0] if browser.contexts else browser.new_context(no_viewport=True)

    def _page(self, front: bool = True):
        if self._cdp_browser is not None and not self._cdp_browser.is_connected():
            # The owner closed Friday's Chrome window: open it again.
            self._context = self._cdp_browser = None
        if self._context is None and self._own_window:
            from playwright.sync_api import sync_playwright

            self._profile_dir.mkdir(parents=True, exist_ok=True)
            self._playwright = self._playwright or sync_playwright().start()
            self._context = self._attach()
        if self._context is None:
            from playwright.sync_api import sync_playwright

            self._profile_dir.mkdir(parents=True, exist_ok=True)
            self._playwright = sync_playwright().start()
            self._context = self._playwright.chromium.launch_persistent_context(
                str(self._profile_dir),
                channel=self._channel,
                headless=self._headless,
                no_viewport=True,
                args=[
                    "--start-maximized",
                    # "Play X on YouTube" should start playing, with sound.
                    "--autoplay-policy=no-user-gesture-required",
                    *([f"--remote-debugging-port={self._cdp_port}"] if self._cdp_port else []),
                ],
                **({"user_agent": self._user_agent} if self._user_agent else {}),
            )
        pages = [page for page in self._context.pages if not page.is_closed()]
        page = pages[-1] if pages else self._context.new_page()
        if front:
            page.bring_to_front()
        return page

    def warm(self) -> None:
        """Start Chrome now, so the first request does not wait for it."""
        self._page()

    def cdp_url(self) -> str:
        """Opens the window if needed and returns where the agent can attach."""
        if not self._cdp_port:
            raise BrowserError("This browser was started without a debugging port.")
        self._page()
        return f"http://127.0.0.1:{self._cdp_port}"

    def _describe(self, page) -> dict:
        page.wait_for_load_state("domcontentloaded", timeout=15_000)
        elements = page.evaluate(SNAPSHOT_JS)
        return {"url": page.url, "title": page.title(), "elements": "\n".join(elements)}

    def screenshot(self) -> str:
        if self._context is None:
            return ""
        data = self._page().screenshot(type="jpeg", quality=45, scale="css")
        return base64.b64encode(data).decode()

    def open(self, url: str) -> dict:
        page = self._page()
        page.goto(_check_url(url), wait_until="domcontentloaded", timeout=30_000)
        return self._describe(page)

    def snapshot(self) -> dict:
        return self._describe(self._page())

    def _element(self, page, ref: int):
        element = page.locator(f'[data-friday-ref="{ref}"]')
        if element.count() == 0:
            raise BrowserError(f"No element [{ref}] on this page. Take a new snapshot first.")
        return element.first

    def click(self, ref: int) -> dict:
        page = self._page()
        element = self._element(page, ref)
        if is_send_label(element.evaluate(LABEL_JS) or ""):
            raise BrowserError(SENDING_NEEDS_OK)
        element.click(timeout=8_000)
        page.wait_for_timeout(600)
        return self._describe(page)

    def type(self, ref: int, text: str, press_enter: bool) -> dict:
        page = self._page()
        element = self._element(page, ref)
        if element.evaluate(SENSITIVE_FIELD_JS):
            raise BrowserError(
                "That is a password, card or one-time-code field. Ask the owner to type it themselves."
            )
        element.fill(text, timeout=8_000)
        if press_enter:
            element.press("Enter")
            page.wait_for_timeout(800)
        return self._describe(page)

    def press(self, key: str) -> dict:
        page = self._page()
        combo = key.replace(" ", "").lower()
        if combo in ("control+enter", "ctrl+enter", "meta+enter") and "mail.google." in page.url:
            raise BrowserError(SENDING_NEEDS_OK)  # Gmail sends on Ctrl+Enter
        page.keyboard.press(key)
        page.wait_for_timeout(500)
        return self._describe(page)

    def scroll(self, direction: str) -> dict:
        page = self._page()
        page.mouse.wheel(0, 700 if direction == "down" else -700)
        page.wait_for_timeout(400)
        return self._describe(page)

    def read(self) -> dict:
        page = self._page()
        text = page.evaluate("() => document.body ? document.body.innerText : ''")
        return {"url": page.url, "title": page.title(), "text": " ".join(text.split())[:8000]}

    def search(self, site: str, query: str) -> dict:
        """Type a query into YouTube's or Google's own search box, like a person."""
        if site not in ("youtube", "google"):
            raise BrowserError("Search YouTube or Google.")
        page = self._page()
        used = self._search_on(page, site, query)
        if used == "google" and (
            "/sorry/" in page.url or page.locator("form#captcha-form").count()
        ):
            used = self._search_on(page, "duckduckgo", query)
        try:
            page.wait_for_selector(SEARCH_SITES[used]["ready"], timeout=12_000)
        except Exception:
            pass  # read whatever is there
        if used == "youtube":
            page.mouse.wheel(0, 2400)  # full videos load below the first Shorts
            page.wait_for_timeout(1200)
            page.mouse.wheel(0, -2400)
        page.wait_for_timeout(700)
        results = page.evaluate(RESULTS_JS, used)
        return {
            "site": SEARCH_SITES[used]["name"],
            "query": query,
            "url": page.url,
            "title": page.title(),
            "results": results,
            "note": ""
            if results
            else "No results could be read; use browser_read or browser_snapshot.",
        }

    def play_youtube(self, query: str) -> dict:
        """Start the first full video (not a Short) YouTube finds for the query.

        Goes straight to the results page: for playing, typing into the home
        page's search box would only add a page load."""
        page = self._page()
        page.goto(
            SEARCH_SITES["youtube"]["results"] + quote_plus(query),
            wait_until="domcontentloaded",
            timeout=20_000,
        )
        try:
            page.wait_for_selector('a[href*="/watch?v="]', timeout=10_000)
        except Exception:
            pass
        results = page.evaluate(RESULTS_JS, "youtube")
        videos = [r for r in results if r["kind"] == "video"] or [
            r for r in results if r["kind"] == "short"
        ]
        if not videos:
            raise BrowserError(f'YouTube showed no video for "{query}".')
        video = videos[0]
        path = video["url"].split("youtube.com", 1)[-1]
        try:
            # Clicking lets YouTube switch pages itself, far quicker than a reload.
            page.locator(f'a[href^="{path.split("&")[0]}"]').first.click(timeout=3_000)
            page.wait_for_url("**/watch**", timeout=8_000)
        except Exception:
            page.goto(video["url"], wait_until="domcontentloaded", timeout=20_000)
        return {"title": video["title"], "url": page.url}

    def _search_on(self, page, site: str, query: str) -> str:
        config = SEARCH_SITES[site]
        try:
            page.goto(config["home"], wait_until="domcontentloaded", timeout=20_000)
            box = page.locator(config["box"]).first
            box.wait_for(state="visible", timeout=8_000)
            box.click()
            box.fill(query)
            box.press("Enter")
            page.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            page.goto(
                config["results"] + quote_plus(query),
                wait_until="domcontentloaded",
                timeout=20_000,
            )
        return site

    def back(self) -> dict:
        page = self._page()
        page.go_back(wait_until="domcontentloaded", timeout=15_000)
        return self._describe(page)

    def google_account(self) -> dict:
        """Whether the owner is signed in to Google in Friday's Chrome."""
        self._page(front=False)  # a status check must not pull the window up
        cookies = self._context.cookies(["https://accounts.google.com", "https://mail.google.com"])
        return {"signed_in": any(c["name"] in GOOGLE_SESSION_COOKIES for c in cookies)}

    def connect_google(self) -> dict:
        """Shows Google's sign-in page; the owner signs in themselves."""
        self._page()
        page = self._context.new_page()
        page.goto(GOOGLE_SIGN_IN, wait_until="domcontentloaded", timeout=30_000)
        page.bring_to_front()
        return {"url": page.url, "title": page.title()}

    def send_open_email(self) -> dict:
        """Clicks Send on the email draft open in Gmail (only after the owner's OK)."""
        page = self._page()
        if "mail.google." not in page.url:
            raise BrowserError("No Gmail draft is open. Ask Navigator to prepare the email first.")
        button = page.locator('div[role="button"][aria-label^="Send"] >> visible=true').first
        if button.count() == 0:
            raise BrowserError("No Send button is visible, so no draft is open.")
        button.click(timeout=5_000)
        try:
            page.get_by_text(re.compile("message sent", re.IGNORECASE)).first.wait_for(
                timeout=8_000
            )
            return {"sent": True}
        except Exception:
            return {"sent": False, "note": "Send was clicked, but Gmail did not confirm yet."}

    def close(self) -> None:
        if self._cdp_browser is not None:
            # Leaves Friday's Chrome window open (and signed in) for next time.
            self._cdp_browser.close()
            self._playwright.stop()
            self._cdp_browser = self._context = self._playwright = None
        elif self._context is not None:
            self._context.close()
            self._playwright.stop()
            self._context = self._playwright = None
