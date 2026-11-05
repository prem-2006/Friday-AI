"""Show me where, Draw on screen and Point at your screen, with a pretend model."""

from __future__ import annotations

import asyncio
import base64
import io
import json

import pytest
from PIL import Image

from friday_services.overlay import Overlay, clean_mark, crop_image, parse_marks, valid_rect
from friday_services.screen import ScreenError


def test_keeps_marks_on_screen_and_drops_broken_ones():
    assert clean_mark({"kind": "ring", "x": 900, "y": -5, "w": 500, "h": 50, "text": "Here"}) == {
        "kind": "ring",
        "x": 900,
        "y": 0,
        "text": "Here",
        "w": 100,
        "h": 50,
    }
    assert clean_mark({"kind": "ring", "x": 1, "y": 1}) is None  # no size
    assert clean_mark({"kind": "script", "x": 1, "y": 1}) is None
    assert clean_mark({"kind": "text", "x": 1, "y": 1}) is None  # nothing to write
    assert clean_mark({"kind": "arrow", "x": "a", "y": 1, "x2": 1, "y2": 1}) is None
    assert clean_mark("no") is None


def test_reads_the_models_answer_with_or_without_a_fence():
    plain = '{"say": "Top right.", "marks": [{"kind": "text", "x": 5, "y": 5, "text": "Hi"}]}'
    assert parse_marks(plain)[0] == "Top right."
    assert len(parse_marks(f"```json\n{plain}\n```")[1]) == 1
    assert parse_marks("It is not on this screen.") == ("It is not on this screen.", [])
    many = {"say": "x", "marks": [{"kind": "text", "x": 1, "y": 1, "text": "a"}] * 40}
    assert len(parse_marks(json.dumps(many))[1]) == 14


def overlay_with(answer: str):
    sent: list[tuple[str, str]] = []
    asked: list[tuple] = []

    def ask(system, question, image, env, tokens):
        asked.append((system, question, image))
        return answer

    return Overlay({}, lambda a, d: sent.append((a, d)), picture, ask=ask), sent, asked


def picture() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (100, 50)).save(buffer, "JPEG")
    return base64.b64encode(buffer.getvalue()).decode()


def test_show_me_where_marks_the_screen():
    answer = '{"say": "Click here.", "marks": [{"kind":"ring","x":10,"y":10,"w":50,"h":50}]}'
    overlay, sent, asked = overlay_with(answer)
    result = asyncio.run(overlay.show_where("Where is Wi-Fi?", hinglish=True))
    assert result == {"say": "Click here.", "marks": 1}
    assert [action for action, _ in sent] == ["overlay_clear", "overlay"]
    assert json.loads(sent[1][1])["mode"] == "where"
    assert asked[0][2] and "Hinglish" in asked[0][0]


def test_show_me_where_says_so_when_it_is_not_there():
    overlay, sent, _ = overlay_with('{"say": "Open Settings first.", "marks": []}')
    assert asyncio.run(overlay.show_where("Where?"))["say"] == "Open Settings first."
    assert [action for action, _ in sent] == ["overlay_clear"]


def test_draw_needs_no_screenshot_and_fails_plainly():
    overlay, sent, asked = overlay_with(
        '{"say": "Done.", "marks": [{"kind":"box","x":1,"y":1,"w":9,"h":9,"text":"A"}]}'
    )
    assert asyncio.run(overlay.draw("the water cycle"))["marks"] == 1
    assert asked[0][2] is None and json.loads(sent[1][1])["mode"] == "draw"
    empty, _, _ = overlay_with("no idea")
    with pytest.raises(ScreenError):
        asyncio.run(empty.draw("the water cycle"))


def test_point_and_ask_answers_about_the_chosen_area():
    overlay, sent, asked = overlay_with("That is a chart.")

    async def run():
        task = asyncio.create_task(overlay.point_and_ask("What is this?"))
        await asyncio.sleep(0)
        assert sent == [("overlay_pick", "")]
        assert overlay.picked({"x": 0.5, "y": 0, "w": 0.5, "h": 0.5})
        return await task

    assert asyncio.run(run()) == {"say": "That is a chart.", "picked": True}
    cropped = Image.open(io.BytesIO(base64.b64decode(asked[0][2])))
    assert cropped.size == (50, 25)


def test_pressing_escape_asks_nothing_and_a_stray_answer_is_ignored():
    overlay, _, asked = overlay_with("x")
    assert not overlay.picked({"x": 0, "y": 0, "w": 1, "h": 1})  # nothing is waiting

    async def run():
        task = asyncio.create_task(overlay.point_and_ask("What?"))
        await asyncio.sleep(0)
        overlay.picked(None)
        return await task

    assert asyncio.run(run())["picked"] is False
    assert asked == []


def test_a_tiny_or_broken_area_does_not_count():
    assert valid_rect({"x": 0, "y": 0, "w": 0.001, "h": 0.5}) is None
    assert valid_rect({"x": 2, "y": 0, "w": 0.5, "h": 0.5}) is None
    assert valid_rect({"x": 0}) is None
    assert crop_image(picture(), {"x": 0, "y": 0, "w": 1, "h": 1})
