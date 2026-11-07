"""Small talk answered at once, without the model."""

from __future__ import annotations

from datetime import datetime

from friday_services.smalltalk import SmallTalk


def talk(hour: int = 15, gender: str = "male") -> SmallTalk:
    return SmallTalk(
        owner=lambda: "Prem",
        gender=lambda: gender,
        choose=lambda answers: answers[0],
        now=lambda: datetime(2026, 11, 8, hour),
    )


def test_greetings_and_how_are_you_need_no_thinking():
    friday = talk()
    assert friday.reply("Hi Friday") == "Haan Prem, bolo."
    assert friday.reply("hello") == "Haan Prem, bolo."
    assert friday.reply("Hey Friday, how are you?") == (
        "Main badhiya hoon Prem! Tum batao, kaisa chal raha hai?"
    )
    assert friday.reply("kaise ho friday") is not None
    assert friday.reply("kya haal hai") is not None
    assert friday.reply("what's my name?") == "Tumhara naam Prem hai."
    assert friday.reply("tum kaun ho") == "Main Friday hoon, Prem ki assistant."
    assert friday.reply("Good morning") == "Good morning Prem! Aaj ka plan kya hai?"


def test_marathi_small_talk_knows_the_owner_is_a_man():
    assert talk().reply("कसा आहेस?") == "मी मस्त आहे! तू कसा आहेस Prem?"
    assert talk(gender="female").reply("कशी आहेस") == "मी मस्त आहे! तू कशी आहेस Prem?"


def test_requests_and_longer_talk_go_to_friday():
    friday = talk()
    for heard in (
        "hi, open notepad",
        "how are you going to fix this bug",
        "play music",
        "kaise ho aur aaj ka weather kya hai bolo zara",
        "",
    ):
        assert friday.reply(heard) is None, heard


def test_late_at_night_friday_looks_out_for_him():
    friday = SmallTalk(
        owner=lambda: "Prem",
        gender=lambda: "male",
        choose=lambda answers: answers[-1],
        now=lambda: datetime(2026, 11, 8, 1),
    )
    assert "jag rahe ho" in friday.reply("how are you")


def test_kannada_tamil_and_telugu_greetings_are_answered_in_kind():
    friday = talk()
    assert friday.reply("ನಮಸ್ಕಾರ").startswith("ನಮಸ್ಕಾರ Prem")
    assert friday.reply("ಹೇಗಿದ್ದೀರಾ?").startswith("ನಾನು ಚೆನ್ನಾಗಿದ್ದೀನಿ")
    assert friday.reply("எப்படி இருக்கீங்க").startswith("நான் நல்லா")
    assert friday.reply("ఎలా ఉన్నావు?").startswith("నేను బాగున్నాను")
