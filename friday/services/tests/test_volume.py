"""Speaker volume, with pretend speakers: nothing here changes the PC's sound."""

from __future__ import annotations

from friday_services.volume import Volume, volume_sentence


class Speakers:
    def __init__(self, level=0.5, muted=0):
        self.level, self.muted = level, muted

    def GetMasterVolumeLevelScalar(self):
        return self.level

    def SetMasterVolumeLevelScalar(self, value, _context):
        self.level = value

    def GetMute(self):
        return self.muted

    def SetMute(self, value, _context):
        self.muted = value


def volume(speakers):
    return Volume(lambda: speakers)


def test_an_exact_level():
    speakers = Speakers()
    assert volume(speakers).set(level=97) == {"level": 97, "muted": False}


def test_changed_by_an_amount_and_kept_between_0_and_100():
    speakers = Speakers(level=0.5)
    assert volume(speakers).set(change=20)["level"] == 70
    assert volume(speakers).set(change=-10)["level"] == 60
    assert volume(speakers).set(change=90)["level"] == 100
    assert volume(speakers).set(change=-200)["level"] == 0


def test_mute_and_a_new_level_unmutes():
    speakers = Speakers()
    assert volume(speakers).set(mute=True)["muted"] is True
    assert volume_sentence(volume(speakers).get()) == "Muted."
    assert volume(speakers).set(level=40) == {"level": 40, "muted": False}
    assert volume_sentence(volume(speakers).get()) == "Volume 40."
