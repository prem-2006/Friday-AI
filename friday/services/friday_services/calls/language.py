"""The language a call is in, turn by turn: Prisma's indic-auto says which
language the caller spoke, and Friday answers in it.

The voice (Timbre v3.0) speaks every one of these languages; what it needs
is the right language for each reply, so the words are said with the right
sounds. That comes from the reply's own script (Tamil letters are Tamil),
and for replies in Latin letters from what the caller spoke: Hinglish after
Hindi, English otherwise.
"""

from __future__ import annotations

import re

# Prisma's code for "find the language yourself".
AUTO = "indic-auto"

# Unicode blocks of the Indian scripts, and the language each is read as.
SCRIPTS: tuple[tuple[str, str], ...] = (
    ("ঀ-৿", "bn-IN"),  # Bengali (also Assamese)
    ("਀-੿", "pa-IN"),  # Gurmukhi
    ("઀-૿", "gu-IN"),  # Gujarati
    ("଀-୿", "or-IN"),  # Odia
    ("஀-௿", "ta-IN"),  # Tamil
    ("ఀ-౿", "te-IN"),  # Telugu
    ("ಀ-೿", "kn-IN"),  # Kannada
    ("ഀ-ൿ", "ml-IN"),  # Malayalam
    ("ऀ-ॿ", "hi-IN"),  # Devanagari: Hindi, or Marathi (see reply_language)
)
NAMES = {
    "en-IN": "English",
    "hi-IN": "Hindi",
    "bn-IN": "Bengali",
    "pa-IN": "Punjabi",
    "gu-IN": "Gujarati",
    "or-IN": "Odia",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "mr-IN": "Marathi",
    "as-IN": "Assamese",
}
# Said while a request is being worked on, in the caller's language.
WORKING = {
    "en-IN": "One second, I'm on it.",
    "hi-IN": "Ek second, dekh rahi hoon.",
    "mr-IN": "एक सेकंद, बघते.",
    "bn-IN": "এক সেকেন্ড, দেখছি।",
    "gu-IN": "એક સેકન્ડ, જોઉં છું.",
    "pa-IN": "ਇੱਕ ਸਕਿੰਟ, ਦੇਖਦੀ ਹਾਂ।",
    "ta-IN": "ஒரு நிமிடம், பார்க்கிறேன்.",
    "te-IN": "ఒక్క క్షణం, చూస్తున్నాను.",
    "kn-IN": "ಒಂದು ಕ್ಷಣ, ನೋಡುತ್ತೇನೆ.",
    "ml-IN": "ഒരു നിമിഷം, നോക്കട്ടെ.",
    "or-IN": "ଗୋଟିଏ ସେକେଣ୍ଡ, ଦେଖୁଛି।",
}


def script_language(text: str) -> str | None:
    """The language of the Indian script most of the text is written in, or
    None for text in Latin letters (English or Hinglish)."""
    counts = {code: len(re.findall(f"[{block}]", text)) for block, code in SCRIPTS}
    code, count = max(counts.items(), key=lambda item: item[1])
    letters = len(re.findall(r"[A-Za-z]", text))
    return code if count and count >= letters else None


def reply_language(text: str, heard: str | None) -> str:
    """The language to voice a reply in."""
    written = script_language(text)
    if written == "hi-IN" and heard == "mr-IN":
        return "mr-IN"  # Marathi is written in Devanagari too
    if written == "bn-IN" and heard == "as-IN":
        return "bn-IN"  # Timbre has no Assamese voice; Bengali reads its script
    if written:
        return written
    return "hi-IN" if heard == "hi-IN" else "en-IN"


def working_line(heard: str | None) -> str:
    return WORKING.get(heard or "", WORKING["en-IN"])


LANGUAGE_RULE = (
    "Language: the person may speak English, Hindi, Hinglish or any Indian language "
    "(Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Odia), and "
    "may switch. Always answer in the language of their last turn, written in its own "
    "script: Hindi and Marathi in Devanagari, Tamil in Tamil letters, and so on; Hinglish "
    "in Roman letters; English in English. Keep names, numbers and times easy to say."
)
