"""One background thread per UI driver.

Playwright's sync API and Windows UI Automation (COM) must always be used from
the thread that created them, so every call for a driver goes through its own
single-thread executor.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

T = TypeVar("T")


class Worker:
    def __init__(self, name: str, initializer: Callable[[], None] | None = None):
        self._pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=name, initializer=initializer
        )

    async def run(self, fn: Callable[..., T], *args) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._pool, fn, *args)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def com_thread() -> None:
    """Windows UI Automation needs COM initialised on its thread."""
    import comtypes

    comtypes.CoInitialize()
