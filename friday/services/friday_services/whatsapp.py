"""WhatsApp Desktop on the owner's PC: find a chat, send a message, start a
call. Every send and call is approved by the owner in OpenDots first; these
functions only run after that.

The screen work goes through WhatsAppUI, so tests use a fake screen and never
message real people. Control names come from WhatsApp Desktop's UI Automation
tree ("Search or start a new chat", "Voice call", "Video call").
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from typing import Any, Protocol

WHATSAPP_APP_ID = "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"
PHONE = re.compile(r"^\+?[\d\s-]{8,18}$")


class WhatsAppError(RuntimeError):
    pass


class WhatsAppUI(Protocol):
    def focus(self) -> None: ...
    def open_phone(self, digits: str) -> None: ...
    def search(self, query: str) -> list[str]: ...
    def open_result(self, name: str) -> None: ...
    def current_chat(self) -> str | None: ...
    def write(self, text: str) -> None: ...
    def press_enter(self) -> None: ...
    def start_call(self, video: bool) -> None: ...


def signed(text: str, owner: str) -> str:
    return f"{text.strip()}\n\n— sent by Friday, {owner}'s AI assistant"


class WhatsApp:
    def __init__(self, ui: WhatsAppUI, owner: str):
        self._ui = ui
        self._owner = owner

    def open_chat(self, contact: str) -> str:
        contact = contact.strip()
        if not contact:
            raise WhatsAppError("Say who: a saved contact name or a phone number.")
        self._ui.focus()
        if PHONE.match(contact):
            digits = re.sub(r"\D", "", contact)
            if len(digits) == 10:  # an Indian mobile without the country code
                digits = f"91{digits}"
            self._ui.open_phone(digits)
            chat = self._ui.current_chat()
            if not chat:
                raise WhatsAppError(f"WhatsApp did not open a chat for {contact}.")
            return chat
        results = self._ui.search(contact)
        exact = [name for name in results if name.casefold() == contact.casefold()]
        if len(set(exact)) == 1:
            choice = exact[0]
        elif len(set(results)) == 1:
            choice = results[0]
        elif not results:
            raise WhatsAppError(f"No WhatsApp chat matches {contact!r}.")
        else:
            options = ", ".join(sorted(set(results))[:5])
            raise WhatsAppError(
                f"Several chats match {contact!r}: {options}. Ask the owner which one."
            )
        self._ui.open_result(choice)
        chat = self._ui.current_chat()
        if not chat or chat.casefold() != choice.casefold():
            raise WhatsAppError(
                f"Opened {chat!r} instead of {choice!r}, so nothing was sent. Try again."
            )
        return chat

    def send(self, contact: str, text: str, sign: bool = True) -> dict:
        if not text.strip():
            raise WhatsAppError("The message is empty.")
        chat = self.open_chat(contact)
        message = signed(text, self._owner) if sign else text.strip()
        self._ui.write(message)
        self._ui.press_enter()
        return {"sent_to": chat, "message": message}

    def call(self, contact: str, video: bool = False) -> dict:
        chat = self.open_chat(contact)
        self._ui.start_call(video)
        return {
            "calling": chat,
            "type": "video" if video else "voice",
            "note": "The call is ringing in WhatsApp on the owner's PC; the owner does the talking.",
        }


class DesktopWhatsAppUI:
    """The real WhatsApp Desktop, through pywinauto. Use from one COM thread."""

    SEARCH = "Search or start a new chat"

    def __init__(self, send_keys: Any = None):
        self._window: Any = None
        self._send_keys = send_keys

    def _keys(self, keys: str) -> None:
        if self._send_keys is None:
            from pywinauto.keyboard import send_keys

            self._send_keys = send_keys
        self._send_keys(keys)

    def _find_window(self):
        from pywinauto import Desktop

        for window in Desktop(backend="uia").windows():
            if window.window_text() == "WhatsApp" and window.is_visible():
                return window
        return None

    def focus(self) -> None:
        window = self._find_window()
        if window is None:
            subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{WHATSAPP_APP_ID}"])
            for _ in range(30):
                time.sleep(0.5)
                window = self._find_window()
                if window is not None:
                    break
        if window is None:
            raise WhatsAppError("WhatsApp Desktop did not open. Is it installed and logged in?")
        if window.is_minimized():
            window.restore()
        window.set_focus()
        time.sleep(1.5)
        self._window = window

    def open_phone(self, digits: str) -> None:
        os.startfile(f"whatsapp://send?phone={digits}")
        time.sleep(3)
        self.focus()

    def search(self, query: str) -> list[str]:
        box = self._window.child_window(title=self.SEARCH, control_type="Edit")
        box.click_input()
        self._keys("^a{BACKSPACE}")
        from friday_services.desktop import escape_text

        self._keys(escape_text(query).replace(" ", "{SPACE}"))
        time.sleep(1.5)
        names = []
        for item in self._window.descendants(control_type="ListItem"):
            # A result reads "Name, last message, time"; keep only the name.
            name = (item.window_text() or "").split(",")[0].strip()
            if name and query.casefold() in name.casefold() and name not in names:
                names.append(name)
        return names

    def open_result(self, name: str) -> None:
        for item in self._window.descendants(control_type="ListItem"):
            if (item.window_text() or "").split(",")[0].strip() == name:
                item.click_input()
                time.sleep(1.5)
                return
        raise WhatsAppError(f"Could not click the chat {name!r}.")

    def current_chat(self) -> str | None:
        buttons = [b.window_text() for b in self._window.descendants(control_type="Button")]
        if "Profile details" in buttons:
            index = buttons.index("Profile details")
            if index + 1 < len(buttons):
                return buttons[index + 1].strip() or None
        return None

    def write(self, text: str) -> None:
        boxes = [
            e
            for e in self._window.descendants(control_type="Edit")
            if (e.window_text() or e.element_info.name or "") != self.SEARCH
        ]
        if not boxes:
            raise WhatsAppError("Could not find the message box.")
        boxes[-1].click_input()
        from friday_services.desktop import escape_text

        # Shift+Enter keeps line breaks inside one message.
        lines = [escape_text(line).replace(" ", "{SPACE}") for line in text.split("\n")]
        self._keys("+{ENTER}".join(lines))

    def press_enter(self) -> None:
        self._keys("{ENTER}")
        time.sleep(1)

    def start_call(self, video: bool) -> None:
        name = "Video call" if video else "Voice call"
        self._window.child_window(title=name, control_type="Button").click_input()
