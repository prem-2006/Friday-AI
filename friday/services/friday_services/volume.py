"""The PC's speaker volume, set to an exact level ("volume 97") or changed by
an amount ("louder", "20 percent quieter"), through Windows' own audio API.
The media keys move it only 2% a press."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

STEP = 10  # "louder" / "quieter" with no number


class VolumeError(RuntimeError):
    pass


def _speakers():
    from pycaw.pycaw import AudioUtilities

    try:
        return AudioUtilities.GetSpeakers().EndpointVolume
    except Exception as error:
        raise VolumeError("No speakers found.") from error


class Volume:
    def __init__(self, speakers: Callable[[], Any] = _speakers):
        self._speakers = speakers

    def get(self) -> dict[str, Any]:
        endpoint = self._speakers()
        return {
            "level": round(endpoint.GetMasterVolumeLevelScalar() * 100),
            "muted": bool(endpoint.GetMute()),
        }

    def set(
        self, level: int | None = None, change: int | None = None, mute: bool | None = None
    ) -> dict[str, Any]:
        """level sets it exactly (0-100); change moves it up or down by that
        much; mute True/False mutes or unmutes. Setting a level unmutes."""
        endpoint = self._speakers()
        now = round(endpoint.GetMasterVolumeLevelScalar() * 100)
        target = level if level is not None else now + change if change is not None else None
        if target is not None:
            target = max(0, min(100, target))
            endpoint.SetMasterVolumeLevelScalar(target / 100, None)
            if target > 0 and mute is None:
                endpoint.SetMute(0, None)
        if mute is not None:
            endpoint.SetMute(1 if mute else 0, None)
        return self.get()


def volume_sentence(state: dict[str, Any]) -> str:
    return "Muted." if state["muted"] else f"Volume {state['level']}."
