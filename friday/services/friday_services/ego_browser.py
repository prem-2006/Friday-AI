"""Navigator in ego lite (citrolabs/ego-lite): a browser built for AI agents,
where Friday's helpers work in their own Space, with the owner's logins, while
the owner keeps using theirs. Chrome stays for YouTube and music, Obscura for
background research.

Each step is a short script run by `ego-browser nodejs`; the Space is named, so
every step resumes the same page. Values reach the script as JSON, never as
code. The same rules as Friday's Chrome apply: no sending without the owner's
OK and no typing into password, card or OTP fields.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

from friday_services.browser import SENDING_NEEDS_OK, BrowserError, _check_url

MARKER = "__FRIDAY_EGO__"
STEP_SECONDS = 60
SNAPSHOT_CHARS = 12_000
SENSITIVE = re.compile(r"password|passcode|\botp\b|one[- ]time|\bcvv\b|card number|upi pin", re.I)
SEND = re.compile(r"""(?:^|["'\s])send\b""", re.I)

# Runs before each step: the Space, its first Page, and helpers for the step.
PRELUDE = """
const args = JSON.parse(process.env.FRIDAY_EGO_ARGS || "{}");
const task = await taskSpace(args.space);
const page = (await task.pages())[0] ?? (await task.newPage());
const lineOf = (snapshot, ref) =>
  String(snapshot).split("\\n").find((line) => new RegExp(`@${ref}(?!\\\\d)`).test(line)) || "";
const done = async (extra = {}) => {
  const snapshot = String(await page.snapshot());
  console.log(`MARKER${JSON.stringify({ url: await page.url(), title: await page.title(),
    page: snapshot.slice(0, args.limit), ...extra })}`);
};
""".replace("MARKER", MARKER)

STEPS = {
    "open": "await page.goto(args.url); await done();",
    "snapshot": "await done();",
    "click": """
const line = lineOf(await page.snapshot(), args.ref);
if (!line) throw new Error(`NOREF ${args.ref}`);
if (new RegExp(args.send, "i").test(line)) throw new Error("SEND");
await page.click(`@${args.ref}`);
await page.waitForTimeout(700);
await done();
""",
    "type": """
const line = lineOf(await page.snapshot(), args.ref);
if (!line) throw new Error(`NOREF ${args.ref}`);
if (new RegExp(args.sensitive, "i").test(line)) throw new Error("SENSITIVE");
await page.fill(`@${args.ref}`, args.text);
if (args.enter) { await page.press(`@${args.ref}`, "Enter"); await page.waitForTimeout(900); }
await done();
""",
    "press": "await page.keyboard.press(args.key); await page.waitForTimeout(500); await done();",
    "scroll": "await page.mouse.wheel(0, args.dy, { label: 'scroll the page' }); await done();",
    "back": "await page.evaluate(() => history.back()); await page.waitForTimeout(900); await done();",
    "read": """
const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
console.log(`MARKER${JSON.stringify({ url: await page.url(), title: await page.title(),
  text: String(text).replace(/\\s+/g, " ").slice(0, 8000) })}`);
""".replace("MARKER", MARKER),
    "finish": "await task.finish({ keep: ['p1'] }); console.log(`MARKER{}`);".replace(
        "MARKER", MARKER
    ),
}


def ego_command() -> str | None:
    """The ego-browser command, which ego lite's onboarding puts on the PATH."""
    return shutil.which("ego-browser")


def navigator_uses_ego(setting: str, command: str | None = None) -> bool:
    """FRIDAY_NAVIGATOR_BROWSER: ego, chrome, or auto (ego lite when installed)."""
    choice = (setting or "auto").strip().lower()
    if choice == "chrome":
        return False
    return choice == "ego" or (command or ego_command()) is not None


def parse_result(output: str) -> dict[str, Any]:
    """The step's result: the last line the step marked, as JSON."""
    lines = [line for line in output.splitlines() if line.startswith(MARKER)]
    if not lines:
        raise BrowserError("ego lite gave no answer for that step.")
    return json.loads(lines[-1][len(MARKER) :])


def explain(error_text: str, ref: int | None = None) -> str:
    """ego lite's error as something Navigator can act on."""
    if "NOREF" in error_text:
        return f"No element [{ref}] on this page. Take a new snapshot first."
    if "SENSITIVE" in error_text:
        return (
            "That is a password, card or one-time-code field. Ask the owner to type it themselves."
        )
    if "SEND" in error_text:
        return SENDING_NEEDS_OK
    last = [line for line in error_text.strip().splitlines() if line.strip()]
    return f"ego lite could not do that: {last[-1][:200] if last else 'no detail'}"


def search_url(site: str, query: str) -> str:
    if site == "youtube":
        return f"https://www.youtube.com/results?search_query={quote_plus(query)}"
    return f"https://www.google.com/search?q={quote_plus(query)}"


class EgoBrowser:
    """The same steps as Friday's Chrome (browser.OnScreenBrowser), in ego lite."""

    def __init__(self, space: str = "Friday Navigator", command: str | None = None, run=None):
        self._space = space
        self._command = command or ego_command() or "ego-browser"
        self._run_process = run or subprocess.run

    def _step(self, name: str, ref: int | None = None, **values: Any) -> dict[str, Any]:
        args = {
            "space": self._space,
            "limit": SNAPSHOT_CHARS,
            "ref": ref,
            "send": SEND.pattern,
            "sensitive": SENSITIVE.pattern,
            **values,
        }
        with tempfile.NamedTemporaryFile(
            "w", suffix=".mjs", delete=False, encoding="utf-8"
        ) as script:
            script.write(PRELUDE + STEPS[name])
        try:
            done = self._run_process(
                [self._command, "nodejs", "-e", f"await import('{Path(script.name).as_uri()}')"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=STEP_SECONDS,
                env={**os.environ, "FRIDAY_EGO_ARGS": json.dumps(args)},
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except FileNotFoundError as error:
            raise BrowserError(
                "ego lite is not installed, or its command is not set up yet."
            ) from error
        except subprocess.TimeoutExpired as error:
            raise BrowserError("ego lite took too long on that step.") from error
        finally:
            Path(script.name).unlink(missing_ok=True)
        if done.returncode != 0:
            raise BrowserError(explain(f"{done.stdout}\n{done.stderr}", ref))
        return parse_result(done.stdout)

    def open(self, url: str) -> dict:
        return self._step("open", url=_check_url(url))

    def search(self, site: str, query: str) -> dict:
        if site not in ("youtube", "google"):
            raise BrowserError("Search YouTube or Google.")
        return self._step("open", url=search_url(site, query))

    def snapshot(self) -> dict:
        return self._step("snapshot")

    def click(self, ref: int) -> dict:
        return self._step("click", ref=ref)

    def type(self, ref: int, text: str, press_enter: bool) -> dict:
        return self._step("type", ref=ref, text=text, enter=press_enter)

    def press(self, key: str) -> dict:
        combo = key.replace(" ", "").lower()
        if combo in ("control+enter", "ctrl+enter", "meta+enter"):
            raise BrowserError(SENDING_NEEDS_OK)  # Gmail and chat boxes send on it
        return self._step("press", key=key)

    def scroll(self, direction: str) -> dict:
        return self._step("scroll", dy=700 if direction == "down" else -700)

    def back(self) -> dict:
        return self._step("back")

    def read(self) -> dict:
        return self._step("read")

    def finish(self) -> None:
        self._step("finish")

    def screenshot(self) -> str:
        return ""  # ego lite shows the Space itself; the feed carries no picture

    def code_editor(self, code: str | None = None) -> dict:
        raise BrowserError("The code editor tools work in Friday's Chrome only.")

    def cdp_url(self) -> str:
        raise BrowserError("Navigator works step by step in ego lite.")
