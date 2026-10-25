"""Media controls and the owner's own browser, with pretend windows and a
pretend media session: nothing here touches the real desktop."""

from __future__ import annotations

from friday_services.media import BrowserWindow, OwnerMedia

YOURS = BrowserWindow(1, "Gmail - Google Chrome", "Chrome", False)
YT = BrowserWindow(2, "Lo-fi beats - YouTube - Google Chrome", "Chrome", False)
FRIDAY_YT = BrowserWindow(3, "Song - YouTube", "Chrome", True)


def media(windows, session=lambda action, seconds: None):
    keys: list[str] = []
    focused: list[int] = []
    owner = OwnerMedia(
        None,
        windows=lambda: windows,
        session=session,
        send_keys=lambda k, **_: keys.append(k),
        focus_window=focused.append,
    )
    return owner, keys, focused


def test_windows_media_controls_come_first():
    owner, keys, _ = media([YT], session=lambda a, s: {"title": "Lo-fi beats", "app": "Chrome"})
    assert owner.control("pause") == {"title": "Lo-fi beats", "app": "Chrome"}
    assert keys == []


def test_youtube_keys_when_the_session_cannot():
    owner, keys, focused = media([YOURS, YT])
    assert owner.control("next")["app"] == "Chrome"
    assert focused == [2] and keys == ["+n"]
    owner.control("rewind", 30)
    assert keys[-3:] == ["j", "j", "j"]


def test_nothing_to_control():
    owner, keys, _ = media([YOURS])
    assert owner.control("pause") is None and keys == []


def test_a_song_goes_where_youtube_already_is():
    owner, _, _ = media([YOURS, YT])
    assert owner.for_youtube() == YT
    owner, _, _ = media([YOURS])
    assert owner.for_youtube() == YOURS  # no YouTube open: the browser used last
    owner, _, _ = media([YOURS, FRIDAY_YT])
    assert owner.for_youtube() == FRIDAY_YT  # Friday's own tab: played there


def test_open_url_in_the_same_tab_or_a_new_one():
    owner, keys, focused = media([YT])
    owner.open_url("https://www.youtube.com/watch?v=abc", YT, same_tab=True)
    assert focused == [2] and keys[0] == "^l" and keys[-1] == "{ENTER}"
    owner.open_url("https://example.com", YT, same_tab=False)
    assert "^t" in keys
