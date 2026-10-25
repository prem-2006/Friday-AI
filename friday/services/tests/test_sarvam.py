"""Calls through Sarvam's agent open by saying it is Friday. Nothing here
reaches Sarvam; its API is faked."""

from __future__ import annotations

import json

import httpx

from friday_services.calls.sarvam import SarvamDialer, opening
from friday_services.config import Settings
from tests.conftest import FAKE_ENV

SARVAM = {
    "SARVAM_API_KEY": "k",
    "SARVAM_ORG_ID": "org",
    "SARVAM_WORKSPACE_ID": "ws",
    "SARVAM_APP_ID": "Friday12-app",
    "SARVAM_APP_VERSION": "2",
    "SARVAM_CONNECTION_ID": "conn",
    "SARVAM_AGENT_NUMBER": "+918000000000",
}


def test_an_opening_always_says_it_is_friday():
    said = "Hi Didi, this is Friday, Asha's assistant. Time for lunch!"
    assert opening(said, "Asha") == said
    assert (
        opening("Time for lunch!", "Asha") == "Hi, I'm Friday, Asha's AI assistant. Time for lunch!"
    )
    assert opening("", "Asha") == "Hi, I'm Friday, Asha's AI assistant."


async def test_the_call_sends_the_opening_as_the_agents_first_words(tmp_path):
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"attempt_id": "a1"})

    settings = Settings.from_env({**FAKE_ENV, **SARVAM}, data_dir=tmp_path)
    dialer = SarvamDialer(
        settings, client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    await dialer.call(
        phone="+919876543210",
        greeting="Dinner time!",
        prompt="",
        reference="r",
        note="Dinner",
        updates="",
    )
    config = sent[0]["app_config"]
    first = "Hi, I'm Friday, Asha's AI assistant. Dinner time!"
    assert config["agent_variables"]["opening_line"] == first
    assert config["app_overrides"]["initial_bot_message"] == first
    assert config["app_version"] == 2
