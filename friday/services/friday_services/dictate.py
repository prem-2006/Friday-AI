"""Dictate anywhere: hold Shift + Caps Lock, talk, let go, and the words land in
whatever text field has the cursor. The idea comes from Atticus
(SaarthurR/atticus-mac, MIT); here it rides on Friday's Caps Lock and Gnani.

Light cleanup only, with no model: fillers go, spoken punctuation becomes
punctuation, and the first letter is capitalised. "New line" is not obeyed,
because Enter sends the message in most chat boxes.
"""

from __future__ import annotations

import re
from collections.abc import Callable

FILLERS = re.compile(r"(?<![\w-])(?:um+|uh+|umm+|hmm+|erm+)(?![\w-])[,.]?\s*", re.I)
PUNCTUATION = (
    (re.compile(r"\s*\b(?:full stop|period)\b", re.I), "."),
    (re.compile(r"\s*\bcomma\b", re.I), ","),
    (re.compile(r"\s*\bquestion mark\b", re.I), "?"),
    (re.compile(r"\s*\bexclamation mark\b", re.I), "!"),
)


def clean_dictation(text: str) -> str:
    text = FILLERS.sub("", text)
    for pattern, mark in PUNCTUATION:
        text = pattern.sub(mark, text)
    text = re.sub(r"\s+", " ", text).strip()
    # Capitalise after a sentence ends; other scripts have no capitals to change.
    return re.sub(
        r"(^|[.?!]\s+)([a-z])", lambda match: match.group(1) + match.group(2).upper(), text
    )


def type_text(text: str) -> None:
    """Types into the focused field as characters, so Hindi works too."""
    import keyboard

    keyboard.write(text, exact=True)


def dictate(text: str, write: Callable[[str], None] = type_text) -> str:
    """Types the cleaned words, with a space after so dictation can go on."""
    cleaned = clean_dictation(text)
    if cleaned:
        write(f"{cleaned} ")
    return cleaned
