"""A real Chrome window on the owner's screen that the Navigator Dot drives.

It uses its own profile (data/browser-profile), so the owner's personal Chrome
logins are never touched. Pages are described as numbered elements, which a
text-only model like Evon can act on.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

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

SENSITIVE_FIELD_JS = """
(el) => el.type === 'password' || /^cc-|one-time-code/.test(el.autocomplete || '')
"""


class BrowserError(RuntimeError):
    pass


def _check_url(url: str) -> str:
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    return url


class OnScreenBrowser:
    """Use only from one thread (see worker.Worker)."""

    def __init__(self, profile_dir: Path, channel: str = "chrome", headless: bool = False):
        self._profile_dir = profile_dir
        self._channel = channel
        self._headless = headless  # tests only; the owner should see the window
        self._playwright: Any = None
        self._context: Any = None

    def _page(self):
        if self._context is None:
            from playwright.sync_api import sync_playwright

            self._profile_dir.mkdir(parents=True, exist_ok=True)
            self._playwright = sync_playwright().start()
            self._context = self._playwright.chromium.launch_persistent_context(
                str(self._profile_dir),
                channel=self._channel,
                headless=self._headless,
                no_viewport=True,
                args=["--start-maximized"],
            )
        pages = [page for page in self._context.pages if not page.is_closed()]
        page = pages[-1] if pages else self._context.new_page()
        page.bring_to_front()
        return page

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
        self._element(page, ref).click(timeout=8_000)
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

    def back(self) -> dict:
        page = self._page()
        page.go_back(wait_until="domcontentloaded", timeout=15_000)
        return self._describe(page)

    def close(self) -> None:
        if self._context is not None:
            self._context.close()
            self._playwright.stop()
            self._context = self._playwright = None
