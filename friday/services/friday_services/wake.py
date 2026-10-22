"""Ways to reach Friday without touching the screen.

Push-to-talk: hold Caps Lock, speak, let go. A quick tap still toggles Caps
Lock as usual; only a hold counts. Works in any app, through a low-level
keyboard hook that acts on Caps Lock alone.

Double clap: two sharp claps within about half a second wake Friday: the voice
screen starts listening, or opens if it is not open yet. The idea comes from
Julian Ivanov's jarvis-voice-assistant (MIT); here it is a small detector on
16 kHz mic blocks. Only loudness peaks are examined; no audio is kept or sent.

Both send signals to the voice screen over the activity stream.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

log = logging.getLogger("friday.wake")

HOLD_SECONDS = 0.3  # shorter presses are ordinary Caps Lock taps


class PushToTalkKey:
    def __init__(
        self,
        signal: Callable[[str], None],
        hook_key: Callable[..., Any] | None = None,
        send: Callable[[str], None] | None = None,
        hold_seconds: float = HOLD_SECONDS,
    ):
        self._signal = signal
        self._hook_key = hook_key
        self._send = send
        self._hold = hold_seconds
        self._down_at: float | None = None
        self._talking = False
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._remove: Callable[[], None] | None = None

    def start(self) -> None:
        if self._hook_key is None or self._send is None:
            import keyboard

            self._hook_key = self._hook_key or keyboard.hook_key
            self._send = self._send or keyboard.send
        self._remove = self._hook_key("caps lock", self.on_event, suppress=True)

    def stop(self) -> None:
        if self._remove:
            self._remove()
            self._remove = None

    def _held(self) -> None:
        with self._lock:
            if self._down_at is None or self._talking:
                return
            self._talking = True
        self._signal("ptt_down")

    def on_event(self, event: Any) -> bool:
        """Returns False so Windows never sees the real Caps Lock press."""
        if event.event_type == "down":
            with self._lock:
                if self._down_at is not None:
                    return False  # key repeat while held
                self._down_at = time.monotonic()
                self._timer = threading.Timer(self._hold, self._held)
                self._timer.daemon = True
                self._timer.start()
            return False
        with self._lock:
            if self._timer:
                self._timer.cancel()
            talking, self._talking, self._down_at = self._talking, False, None
        if talking:
            self._signal("ptt_up")
        elif self._send:
            # A tap: give Windows its Caps Lock back. Sent from another thread,
            # because injecting keys from inside the hook can stall it.
            threading.Thread(target=self._send, args=("caps lock",), daemon=True).start()
        return False


class ClapCounter:
    """Finds two claps close together in a stream of mic blocks.

    A clap is a block whose peak is loud, many times the room's usual level,
    and which follows a quiet block: a short, sharp sound, unlike speech or music.
    """

    def __init__(
        self,
        min_peak: float = 0.3,
        over_floor: float = 9.0,
        gap: tuple[float, float] = (0.12, 0.7),
        cooldown: float = 2.0,
    ):
        self.min_peak = min_peak
        self.over_floor = over_floor
        self.gap = gap
        self.cooldown = cooldown
        self.floor = 0.01
        self._was_loud = False
        self._last_clap: float | None = None
        self._fired_at = -1e9

    def feed(self, peak: float, rms: float, now: float) -> bool:
        clap = peak >= self.min_peak and peak >= self.floor * self.over_floor and not self._was_loud
        self._was_loud = rms >= self.floor * 4
        if not self._was_loud:
            self.floor = self.floor * 0.98 + max(rms, 1e-4) * 0.02
        if not clap or now - self._fired_at < self.cooldown:
            return False
        last, self._last_clap = self._last_clap, now
        if last is not None and self.gap[0] <= now - last <= self.gap[1]:
            self._fired_at = now
            self._last_clap = None
            return True
        return False


class ClapListener:
    def __init__(self, on_double_clap: Callable[[], None], counter: ClapCounter | None = None):
        self._on_double_clap = on_double_clap
        self._counter = counter or ClapCounter()
        self._stream: Any = None

    def start(self) -> None:
        import numpy as np
        import sounddevice as sd

        def block(data, _frames, _time, _status) -> None:
            samples = data[:, 0]
            peak = float(np.max(np.abs(samples)))
            rms = float(np.sqrt(np.mean(samples * samples)))
            if self._counter.feed(peak, rms, time.monotonic()):
                try:
                    self._on_double_clap()
                except Exception:
                    log.exception("double clap handler failed")

        self._stream = sd.InputStream(
            samplerate=16_000, channels=1, blocksize=512, dtype="float32", callback=block
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
