"""WhatsApp and desktop-app logic, on a pretend screen."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from friday_services.desktop import DesktopApps, DesktopError, escape_text, to_send_keys
from friday_services.whatsapp import WhatsApp, WhatsAppError

from .conftest import FakeWhatsAppUI


def test_sends_to_the_exact_contact_and_signs_as_friday():
    ui = FakeWhatsAppUI()
    result = WhatsApp(ui, "Asha").send("priya sharma", "Running 10 minutes late")
    assert result["sent_to"] == "Priya Sharma"
    assert ("write", "Priya Sharma", result["message"]) in ui.log
    assert result["message"].endswith("sent by Friday, Asha's AI assistant")
    assert ui.log[-1] == ("enter", "Priya Sharma")


def test_ambiguous_or_missing_contacts_send_nothing():
    ui = FakeWhatsAppUI()
    with pytest.raises(WhatsAppError, match="Several chats match 'Priya'"):
        WhatsApp(ui, "Asha").send("Priya", "hi")
    with pytest.raises(WhatsAppError, match="No WhatsApp chat matches"):
        WhatsApp(ui, "Asha").send("Nobody", "hi")
    assert not [entry for entry in ui.log if entry[0] in ("write", "enter")]


def test_stops_if_the_wrong_chat_opens():
    ui = FakeWhatsAppUI()
    ui.misdirect = True
    with pytest.raises(WhatsAppError, match="nothing was sent"):
        WhatsApp(ui, "Asha").send("Rahul", "hi")
    assert not [entry for entry in ui.log if entry[0] in ("write", "enter")]


def test_phone_numbers_open_directly_with_india_code():
    ui = FakeWhatsAppUI()
    WhatsApp(ui, "Asha").send("98123 45678", "hi", sign=False)
    assert ("open_phone", "919812345678") in ui.log
    assert ("write", "+919812345678", "hi") in ui.log


def test_calls_start_and_the_owner_talks():
    ui = FakeWhatsAppUI()
    result = WhatsApp(ui, "Asha").call("Rahul", video=True)
    assert ui.log[-1] == ("call", "Rahul", True)
    assert result["type"] == "video" and "owner does the talking" in result["note"]


def test_key_names_become_pywinauto_keys():
    assert to_send_keys("Enter") == "{ENTER}"
    assert to_send_keys("Ctrl+Shift+N") == "^+n"
    assert to_send_keys("Alt+F4") == "%{F4}"
    assert to_send_keys("ctrl++") == "^{+}"
    with pytest.raises(DesktopError):
        to_send_keys("Hyper+X")
    assert escape_text("50% off (today) {x}") == "50{%} off {(}today{)} {{}x{}}"


class FakeControl:
    def __init__(self, kind, name, password=False):
        self.element_info = SimpleNamespace(
            control_type=kind, name=name, element=SimpleNamespace(CurrentIsPassword=password)
        )
        self.clicked = 0

    def is_visible(self):
        return True

    def click_input(self):
        self.clicked += 1


class FakeWindow:
    def __init__(self, title, controls):
        self.title = title
        self.controls = controls

    def window_text(self):
        return self.title

    def is_visible(self):
        return True

    def set_focus(self):
        pass

    def descendants(self):
        return self.controls


def make_apps(windows):
    typed = []
    launched = []
    apps = DesktopApps(
        list_apps=lambda: [
            {"name": "Notepad", "app_id": "notepad"},
            {"name": "WhatsApp", "app_id": "wa"},
            {"name": "Calculator", "app_id": "calc"},
            {"name": "Visual Studio Code", "app_id": "code"},
            {"name": "Visual Studio Installer", "app_id": "vsi"},
        ],
        launch=launched.append,
        desktop=SimpleNamespace(windows=lambda: windows),
        send_keys=lambda keys, **_: typed.append(keys),
    )
    return apps, typed, launched


def test_apps_open_by_name_but_never_whatsapp():
    note = FakeWindow("Untitled - Notepad", [])
    apps, _typed, launched = make_apps([note])
    assert apps.apps("visual") == ["Visual Studio Code", "Visual Studio Installer"]
    with pytest.raises(DesktopError, match="Several apps match"):
        apps.open("visual studio")
    with pytest.raises(DesktopError, match="WhatsApp tools"):
        apps.open("whatsapp")
    assert apps.open("notepad", wait_seconds=1)["window"] == "Untitled - Notepad"
    assert launched == ["notepad"]


def test_window_controls_are_numbered_and_passwords_refused():
    editor = FakeControl("Edit", "Text editor")
    secret = FakeControl("Edit", "Password", password=True)
    save = FakeControl("Button", "Save")
    window = FakeWindow("Login - App", [editor, FakeControl("Text", "label"), secret, save])
    chat = FakeWindow("WhatsApp", [FakeControl("Button", "Send")])
    apps, typed, _ = make_apps([window, chat])
    snap = apps.snapshot("login")
    assert snap["controls"].splitlines() == [
        '[1] Edit "Text editor"',
        '[2] Edit "Password"',
        '[3] Button "Save"',
    ]
    apps.type(1, "Hello (team)", press_enter=True)
    assert typed == ["Hello{SPACE}{(}team{)}".replace("{SPACE}", " "), "{ENTER}"]
    with pytest.raises(DesktopError, match="password"):
        apps.type(2, "hunter2")
    apps.click(3)
    assert save.clicked == 1
    with pytest.raises(DesktopError, match="WhatsApp"):
        apps.snapshot("whatsapp")
