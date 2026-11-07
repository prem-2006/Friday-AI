"""The same action asked for twice within seconds runs once."""

from __future__ import annotations

import asyncio

import pytest

from friday_services.once import Once, guard_repeats


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


class Server:
    def __init__(self):
        self.ran: list[tuple[str, dict]] = []

    async def call_tool(self, name, arguments, context=None):
        self.ran.append((name, arguments))
        await asyncio.sleep(0.01)
        return f"{name} done"


def test_an_action_asked_twice_runs_once_and_both_get_its_result():
    clock = Clock()
    server = guard_repeats(Server(), Once(clock=clock))

    async def go():
        # A replaced turn asks again while the first is still running.
        both = await asyncio.gather(
            server.call_tool("open_app", {"name": "Notepad"}),
            server.call_tool("open_app", {"name": "Notepad"}),
        )
        assert both == ["open_app done", "open_app done"]
        assert await server.call_tool("open_app", {"name": "Paint"}) == "open_app done"
        clock.now = 13  # later on, the same ask is a new request
        await server.call_tool("open_app", {"name": "Notepad"})

    asyncio.run(go())
    assert server.ran == [
        ("open_app", {"name": "Notepad"}),
        ("open_app", {"name": "Paint"}),
        ("open_app", {"name": "Notepad"}),
    ]


def test_steps_said_again_on_purpose_and_reads_always_run():
    server = guard_repeats(Server(), Once(clock=Clock()))

    async def go():
        for _ in range(2):
            await server.call_tool("set_volume", {"change": 10})
            await server.call_tool("media_control", {"action": "pause"})
            await server.call_tool("look_at_screen", {"question": "what is this"})
            await server.call_tool("set_volume", {"level": 40})

    asyncio.run(go())
    assert [name for name, _ in server.ran].count("set_volume") == 3  # 2 steps + 1 level
    assert len(server.ran) == 7


def test_a_failed_call_may_be_tried_again_at_once():
    attempts: list[int] = []

    class Flaky(Server):
        async def call_tool(self, name, arguments, context=None):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("window not found")
            return "ok"

    server = guard_repeats(Flaky(), Once(clock=Clock()))

    async def go():
        with pytest.raises(RuntimeError):
            await server.call_tool("open_app", {"name": "Notepad"})
        assert await server.call_tool("open_app", {"name": "Notepad"}) == "ok"

    asyncio.run(go())
    assert len(attempts) == 2


def test_friday_opening_an_app_twice_in_a_row_opens_it_once(server):
    from .conftest import TOKEN
    from .mcp_client import McpClient

    quick = McpClient(f"{server.url}/quick/mcp", TOKEN)
    quick.initialize()
    first = quick.call("open_app", {"name": "Notepad"})
    again = quick.call("open_app", {"name": "Notepad"})
    assert not first["isError"] and again["data"] == first["data"]
    assert server.launched == ["notepad"]
