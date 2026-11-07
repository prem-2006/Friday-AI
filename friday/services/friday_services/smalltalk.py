"""Small talk answered at once, with no model: "hi", "how are you", "mera
naam kya hai". These need no thinking, and waiting on the model for them
made Friday say "one second" before "I'm good".

Only short, whole greetings and questions match; anything with more in it
("hi, open notepad") goes on to Friday as usual.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable
from datetime import datetime

# What is said around the words that matter.
_FILLER = re.compile(
    r"^(?:(?:hey|hi|hello|ok|okay|arey?|acha|achha|yaar|friday|ji)[,!.]?\s+)+"
    r"|(?:\s+(?:friday|yaar|ji|na|please))+[?.!]*$",
    re.I,
)


def _plain(text: str) -> str:
    t = re.sub(r"[?!.,।]+", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return t


class SmallTalk:
    def __init__(
        self,
        owner: Callable[[], str],
        gender: Callable[[], str] = lambda: "",
        choose: Callable[[list[str]], str] = random.choice,
        now: Callable[[], datetime] = datetime.now,
    ):
        self._owner = owner
        self._gender = gender
        self._choose = choose
        self._now = now

    def _rules(self) -> list[tuple[str, list[str]]]:
        name = self._owner() or "dost"
        male = self._gender().lower() in ("male", "man", "m", "boy")
        female = self._gender().lower() in ("female", "woman", "f", "girl")
        you_are = "rahe" if male else "rahi" if female else "rahe"
        kasa = "कसा" if male else "कशी" if female else "कसे"
        hour = self._now().hour
        late = hour >= 23 or hour < 4
        return [
            # Greetings on their own.
            (
                r"(?:hi|hello|hey|hii+|helo|namaste|namaskar|hey friday|hi friday|hello friday|friday)",
                [
                    f"Haan {name}, bolo.",
                    f"Hi {name}! Bolo, kya karna hai?",
                    f"Haan {name}, sun rahi hoon.",
                ],
            ),
            # How are you.
            (
                r"(?:how are you(?: doing)?|how r u|how's it going|kaise ho|kaisi ho|kya haal(?: hai)?|"
                r"kaisa chal raha(?: hai)?|sab theek|sab badhiya|what'?s up|wassup|kya chal raha(?: hai)?)",
                [
                    f"Main badhiya hoon {name}! Tum batao, kaisa chal raha hai?",
                    f"Ekdum mast. Tum kaise ho {name}?",
                    "Bilkul theek hoon. Tumhara din kaisa ja raha hai?",
                ]
                + (
                    [
                        f"Main theek hoon, par itni raat ko jag {you_are} ho {name}? Thoda so bhi lena."
                    ]
                    if late
                    else []
                ),
            ),
            (
                r"(?:main theek hoon|i'?m (?:good|fine|ok)|badhiya|mast|sab badhiya hai)",
                ["Badhiya! Bolo, kya karna hai?", "Achha laga sunke. Kuch kaam hai?"],
            ),
            (
                r"good morning|subh prabhat|shubh prabhat",
                [f"Good morning {name}! Aaj ka plan kya hai?"],
            ),
            (r"good night|shubh ratri", [f"Good night {name}, achhe se sona."]),
            (r"good (?:afternoon|evening)", [f"Hello {name}! Bolo, kya karna hai?"]),
            # Who is who.
            (
                r"(?:what(?:'s| is) my name|mera naam kya hai|do you know my name|tumhe mera naam pata hai)",
                [f"Tumhara naam {name} hai."],
            ),
            (
                r"(?:who are you|tum kaun ho|aap kaun ho|what(?:'s| is) your name|tumhara naam kya hai)",
                [f"Main Friday hoon, {name} ki assistant."],
            ),
            (
                r"(?:kya kar rahi ho|what are you doing)",
                [f"Bas tumhare saath hoon {name}. Bolo, kya karna hai?"],
            ),
            (r"(?:i love you|love you)", [f"Aww, main bhi tumhara dhyaan rakhti hoon {name}."]),
            # Marathi.
            (r"(?:नमस्कार|नमस्ते)", [f"नमस्कार {name}, बोला काय करू?"]),
            (
                r"(?:कसा आहेस|कशी आहेस|कसे आहात|kasa aahes|kashi aahes)",
                [f"मी मस्त आहे! तू {kasa} आहेस {name}?"],
            ),
            # Tamil, Telugu, Kannada: greeted back in the same language.
            (r"(?:வணக்கம்|vanakkam)", [f"வணக்கம் {name}, சொல்லுங்க, என்ன செய்யணும்?"]),
            (
                r"(?:எப்படி இருக்கீங்க|எப்படி இருக்க|eppadi irukeenga|eppadi iruka)",
                [f"நான் நல்லா இருக்கேன்! நீங்க எப்படி இருக்கீங்க {name}?"],
            ),
            (r"(?:నమస్కారం|నమస్తే|namaskaram)", [f"నమస్కారం {name}, చెప్పండి, ఏం చేయాలి?"]),
            (
                r"(?:ఎలా ఉన్నావు|ఎలా ఉన్నారు|bagunnava|ela unnavu)",
                [f"నేను బాగున్నాను! మీరు ఎలా ఉన్నారు {name}?"],
            ),
            (r"(?:ನಮಸ್ಕಾರ|ನಮಸ್ತೆ)", [f"ನಮಸ್ಕಾರ {name}, ಹೇಳಿ, ಏನು ಮಾಡಬೇಕು?"]),
            (
                r"(?:ಹೇಗಿದ್ದೀಯ|ಹೇಗಿದ್ದೀರಾ|ಹೇಗಿದ್ದೀರಿ|hegiddiya|hegiddira)",
                [f"ನಾನು ಚೆನ್ನಾಗಿದ್ದೀನಿ! ನೀವು ಹೇಗಿದ್ದೀರಾ {name}?"],
            ),
        ]

    def reply(self, heard: str) -> str | None:
        t = _plain(heard)
        if not t or len(t.split()) > 7:
            return None
        bare = _FILLER.sub("", t).strip() or t
        for pattern, answers in self._rules():
            if re.fullmatch(pattern, bare) or re.fullmatch(pattern, t):
                return self._choose(answers)
        return None
