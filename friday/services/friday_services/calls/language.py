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


def _has_script_of(text: str, code: str | None) -> bool:
    if code == "mr-IN":
        code = "hi-IN"  # Devanagari
    if code == "as-IN":
        code = "bn-IN"
    block = next((b for b, c in SCRIPTS if c == code), None)
    return bool(block and re.search(f"[{block}]", text))


def reply_language(text: str, heard: str | None) -> str:
    """The language to voice a reply in. A reply that mixes the owner's
    language with English ("நாளைக்கு உங்க meeting 4 PM") is said in that
    language, as they speak it, not by an English voice."""
    if heard not in (None, "en-IN", "hi-IN") and _has_script_of(text, heard):
        return heard  # type: ignore[return-value]
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
    "in Roman letters; English in English. If they mix their language with English "
    "(Tamil and English, Telugu and English, Kannada and English), answer in the same mix, "
    "the English words in English and the rest in its own script. Keep names, numbers "
    "and times easy to say."
)


# Devanagari in Roman letters the way people type Hinglish ("चलाओ" ->
# "chalao", "कर दो" -> "kar do"), so a Hindi request the notch heard in
# Devanagari still matches Friday's instant commands, which are in Roman.
_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh",
    "स": "s", "ह": "h", "ळ": "l",
    "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f",
}  # fmt: skip
_VOWELS = {
    "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e",
}  # fmt: skip
_SIGNS = {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
}  # fmt: skip
_MARKS = {"ं": "n", "ँ": "n", "ः": "h", "।": ".", "॥": "."}
_VIRAMA, _NUKTA = "्", "़"


def _roman_word(word: str) -> str:
    out: list[str] = []
    i, inherent = 0, False  # inherent: the last consonant still carries its "a"
    while i < len(word):
        ch = word[i]
        if i + 1 < len(word) and word[i + 1] == _NUKTA:
            ch, i = ch + _NUKTA, i + 1
        if ch in _CONSONANTS:
            if inherent:
                out.append("a")
            out.append(_CONSONANTS[ch])
            inherent = True
        elif ch in _SIGNS:
            out.append(_SIGNS[ch])
            inherent = False
        elif ch == _VIRAMA:
            inherent = False
        else:
            if inherent:
                out.append("a")
            inherent = False
            if "०" <= ch <= "९":
                out.append(str(ord(ch) - ord("०")))
            else:
                out.append(_VOWELS.get(ch) or _MARKS.get(ch) or ch)
        i += 1
    # The last consonant's "a" is not said ("kar", not "kara"), except in a
    # one-letter word ("na").
    if inherent and len(out) == 1:
        out.append("a")
    return "".join(out)


def romanize(text: str) -> str:
    """Devanagari words in Roman letters; everything else as it is."""
    return re.sub(r"[ऀ-ॿ]+", lambda m: _roman_word(m.group(0)), text)
