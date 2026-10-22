"""Windows desktop apps for the Operator Dot, through UI Automation.

Apps are listed from the Start menu and opened by name. A window is described
as numbered controls that the model acts on by number. WhatsApp windows are
off limits here: messages and calls go through the WhatsApp tools, which always
ask the owner first.
"""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

INTERACTIVE = {
    "Button",
    "Edit",
    "MenuItem",
    "ListItem",
    "TabItem",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "Hyperlink",
    "TreeItem",
    "Document",
    "SplitButton",
}
GUARDED_WINDOWS = ("whatsapp",)
SPECIAL_KEYS = {
    "enter": "ENTER",
    "return": "ENTER",
    "tab": "TAB",
    "escape": "ESC",
    "esc": "ESC",
    "backspace": "BACKSPACE",
    "delete": "DELETE",
    "space": "SPACE",
    "up": "UP",
    "down": "DOWN",
    "left": "LEFT",
    "right": "RIGHT",
    "home": "HOME",
    "end": "END",
    "pageup": "PGUP",
    "pagedown": "PGDN",
    **{f"f{n}": f"F{n}" for n in range(1, 13)},
}
MODIFIERS = {"ctrl": "^", "control": "^", "shift": "+", "alt": "%"}


class DesktopError(RuntimeError):
    pass


def to_send_keys(combo: str) -> str:
    """'Ctrl+Shift+N' -> '^+n', 'Enter' -> '{ENTER}' (pywinauto key syntax)."""
    combo = combo.strip()
    plus_key = len(combo) > 1 and combo.endswith("++")  # e.g. Ctrl++ (zoom in)
    parts = [part.strip() for part in combo.split("+") if part.strip()]
    if plus_key:
        parts.append("+")
    if not parts:
        raise DesktopError("Say which key to press, e.g. Enter or Ctrl+N.")
    *mods, key = parts
    prefix = ""
    for mod in mods:
        if mod.lower() not in MODIFIERS:
            raise DesktopError(f"Unknown modifier key: {mod}.")
        prefix += MODIFIERS[mod.lower()]
    name = key.lower()
    if name in SPECIAL_KEYS:
        return prefix + "{" + SPECIAL_KEYS[name] + "}"
    if len(key) == 1:
        return prefix + ("{" + key + "}" if key in "{}[]()+^%~" else key.lower())
    raise DesktopError(f"Unknown key: {key}.")


def escape_text(text: str) -> str:
    """Make free text safe for pywinauto send_keys."""
    return "".join("{" + c + "}" if c in "{}[]()+^%~" else c for c in text)


def start_menu_apps() -> list[dict[str, str]]:
    out = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout
    data = json.loads(out or "[]")
    rows = data if isinstance(data, list) else [data]
    return [{"name": row["Name"], "app_id": row["AppID"]} for row in rows if row.get("Name")]


def visible_window_titles() -> list[str]:
    """Titles of visible top-level windows, straight from Win32: about 2 ms,
    where walking UI Automation takes most of a second."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    titles: list[str] = []

    def add(hwnd, _param):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length:
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                title = buffer.value.strip()
                if title and title not in titles:
                    titles.append(title)
        return True

    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(add)
    user32.EnumWindows(callback, 0)
    return titles


def launch_app(app_id: str) -> None:
    subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{app_id}"])


@dataclass
class Control:
    ref: int
    kind: str
    name: str
    wrapper: Any


class DesktopApps:
    """Use only from one COM thread (see worker.Worker)."""

    def __init__(
        self,
        list_apps: Callable[[], list[dict[str, str]]] = start_menu_apps,
        launch: Callable[[str], None] = launch_app,
        desktop: Any = None,
        send_keys: Callable[..., None] | None = None,
        window_titles: Callable[[], list[str]] | None = None,
    ):
        self._list_apps = list_apps
        # Tests that pass a fake desktop read its windows instead.
        self._titles = window_titles or (visible_window_titles if desktop is None else None)
        self._launch = launch
        self._desktop = desktop
        self._send_keys = send_keys
        self._apps: list[dict[str, str]] | None = None
        self._controls: dict[int, Control] = {}
        self._window: Any = None

    def _uia(self):
        if self._desktop is None:
            from pywinauto import Desktop

            self._desktop = Desktop(backend="uia")
        return self._desktop

    def _keys(self, keys: str, **kwargs) -> None:
        if self._send_keys is None:
            from pywinauto.keyboard import send_keys

            self._send_keys = send_keys
        self._send_keys(keys, **kwargs)

    def warm(self) -> None:
        """Load the Start menu list ahead of the first request (about 2 s)."""
        if self._apps is None:
            self._apps = self._list_apps()

    def apps(self, query: str = "") -> list[str]:
        if self._apps is None:
            self._apps = self._list_apps()
        names = sorted({app["name"] for app in self._apps})
        return [name for name in names if query.casefold() in name.casefold()][:60]

    def _find_app(self, name: str) -> dict[str, str]:
        if self._apps is None:
            self._apps = self._list_apps()
        wanted = name.casefold().strip()
        exact = [app for app in self._apps if app["name"].casefold() == wanted]
        partial = [app for app in self._apps if wanted in app["name"].casefold()]
        matches = exact or partial
        if not matches:
            raise DesktopError(f"No app called {name!r}. Use list_apps to see what is installed.")
        if not exact and len({app["name"] for app in partial}) > 1:
            options = ", ".join(sorted({app["name"] for app in partial})[:6])
            raise DesktopError(f"Several apps match {name!r}: {options}. Say which one.")
        return matches[0]

    def windows(self) -> list[str]:
        if self._titles:
            return self._titles()
        titles = []
        for window in self._uia().windows():
            title = (window.window_text() or "").strip()
            if title and window.is_visible() and title not in titles:
                titles.append(title)
        return titles

    def _window_named(self, title: str):
        wanted = title.casefold().strip()
        windows = [w for w in self._uia().windows() if w.is_visible() and w.window_text()]
        exact = [w for w in windows if w.window_text().casefold() == wanted]
        partial = [w for w in windows if wanted in w.window_text().casefold()]
        window = (exact or partial or [None])[0]
        if window is None:
            raise DesktopError(f"No open window called {title!r}. Use list_windows.")
        if any(guard in window.window_text().casefold() for guard in GUARDED_WINDOWS):
            raise DesktopError(
                "WhatsApp is controlled only through the WhatsApp tools, which ask the owner first."
            )
        return window

    def open(self, name: str, wait_seconds: float = 12) -> dict:
        app = self._find_app(name)
        if any(guard in app["name"].casefold() for guard in GUARDED_WINDOWS):
            raise DesktopError("Use the WhatsApp tools for WhatsApp; they ask the owner first.")
        before = set(self.windows())
        self._launch(app["app_id"])
        deadline = time.time() + wait_seconds
        first_word = app["name"].split()[0].casefold()
        while time.time() < deadline:
            time.sleep(0.2)
            titles = self.windows()
            new = [t for t in titles if t not in before]
            match = [t for t in titles if first_word in t.casefold()]
            if new or match:
                return {"opened": app["name"], "window": (new or match)[0]}
        return {"opened": app["name"], "window": None, "note": "Started; no new window seen yet."}

    def write(self, name: str, text: str) -> dict:
        """Type text into an app: into its open window, or open it first.

        Lines become separate lines (Enter between them). The text goes where
        the app's cursor is, as if the owner typed it."""
        if any(guard in name.casefold() for guard in GUARDED_WINDOWS):
            raise DesktopError("Use the WhatsApp tools for WhatsApp; they ask the owner first.")
        app = self._find_app(name)
        first_word = app["name"].split()[0].casefold()
        title = next((t for t in self.windows() if first_word in t.casefold()), None)
        opened = title is None
        if opened:
            title = self.open(name)["window"]
            if not title:
                raise DesktopError(f"{app['name']} has not opened a window yet. Try again.")
        window = self._window_named(title)
        try:
            window.set_focus()
        except Exception:
            pass
        time.sleep(0.6 if opened else 0.2)  # let a new window take the keyboard
        lines = text.replace("\r\n", "\n").split("\n")
        for index, line in enumerate(lines):
            if line:
                self._keys(escape_text(line), with_spaces=True, pause=0.005)
            if index < len(lines) - 1:
                self._keys("{ENTER}")
        return {"app": app["name"], "window": window.window_text(), "opened": opened}

    def snapshot(self, title: str) -> dict:
        window = self._window_named(title)
        try:
            window.set_focus()
        except Exception:
            pass
        self._window = window
        self._controls = {}
        lines = []
        for element in window.descendants():
            info = element.element_info
            if info.control_type not in INTERACTIVE:
                continue
            try:
                if not element.is_visible():
                    continue
            except Exception:
                continue
            ref = len(self._controls) + 1
            name = " ".join((info.name or "").split())[:80]
            self._controls[ref] = Control(ref, info.control_type, name, element)
            lines.append(f'[{ref}] {info.control_type} "{name}"')
            if ref >= 150:
                break
        return {"window": window.window_text(), "controls": "\n".join(lines)}

    def _control(self, ref: int) -> Control:
        if ref not in self._controls:
            raise DesktopError(f"No control [{ref}]. Take a new snapshot of the window first.")
        return self._controls[ref]

    def click(self, ref: int) -> dict:
        control = self._control(ref)
        control.wrapper.click_input()
        time.sleep(0.6)
        return {"clicked": f'{control.kind} "{control.name}"'}

    def type(self, ref: int, text: str, press_enter: bool = False) -> dict:
        control = self._control(ref)
        try:
            secret = bool(control.wrapper.element_info.element.CurrentIsPassword)
        except Exception:
            secret = False
        if secret:
            raise DesktopError("That is a password field. Ask the owner to type it themselves.")
        control.wrapper.click_input()
        self._keys(escape_text(text), with_spaces=True, with_newlines=False, pause=0.01)
        if press_enter:
            self._keys("{ENTER}")
        return {"typed_into": f'{control.kind} "{control.name}"', "pressed_enter": press_enter}

    def press(self, combo: str) -> dict:
        if self._window is not None and any(
            guard in (self._window.window_text() or "").casefold() for guard in GUARDED_WINDOWS
        ):
            raise DesktopError("Use the WhatsApp tools for WhatsApp.")
        self._keys(to_send_keys(combo))
        return {"pressed": combo}

    def screenshot(self) -> str:
        """JPEG of the window last worked on, for the owner's live view."""
        if self._window is None:
            return ""
        try:
            import base64
            import io

            image = self._window.capture_as_image()
            if image is None:
                return ""
            image.thumbnail((1280, 800))
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=45)
            return base64.b64encode(buffer.getvalue()).decode()
        except Exception:
            return ""
