"""Scripted replies for a demo shoot: the exact line from the script for each
question in it, said at once with no model, so every take sounds the same.

The script is friday/scripted-replies.json; it is used only while
FRIDAY_SCRIPTED_REPLIES=true, so Friday never gives a scripted answer
("on your study table") in everyday use.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).resolve().parents[2] / "scripted-replies.json"
# Words that say nothing about which question it is.
LITTLE = set(
    "a an the to of i me my you your is are was do did does please friday hey hi ok okay "
    "na yaar zara".split()
)
# Share of a question's words that must be heard (speech-to-text drops or
# changes a word now and then).
ENOUGH = 0.75


def words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9']+", text.lower()) if w not in LITTLE]


def stem(word: str) -> str:
    """ "headphones" and "headphone" match; so do "remember" and "remembers"."""
    return word[:5]


def matches(heard: str, question: str) -> bool:
    asked = words(question)
    if not asked:
        return False
    said = {stem(w) for w in words(heard)}
    found = sum(stem(w) in said for w in asked)
    # Not when the owner said much more than the question: then it is
    # another request that happens to share the words.
    return found / len(asked) >= ENOUGH and len(said) <= len(asked) + 3


def load(path: Path = SCRIPT) -> list[dict[str, Any]]:
    try:
        lines = json.loads(path.read_text(encoding="utf-8")).get("lines", [])
    except (OSError, ValueError, AttributeError):
        return []
    return [
        line
        for line in lines
        if isinstance(line, dict)
        and isinstance(line.get("say"), str)
        and isinstance(line.get("when"), list)
    ]


def reply(heard: str, path: Path = SCRIPT) -> str | None:
    """The script's line for what was heard, if it is one of its questions."""
    for line in load(path):
        if any(isinstance(q, str) and matches(heard, q) for q in line["when"]):
            return line["say"]
    return None
