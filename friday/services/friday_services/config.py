"""Settings for Friday's services, read from the repo's .env."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVICES_ROOT = Path(__file__).resolve().parents[1]

CALL_SETTINGS = (
    "GNANI_API_KEY",
    "EVON_BASE_URL",
    "EVON_MODEL",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "PUBLIC_URL",
)


@dataclass(frozen=True)
class Settings:
    values: Mapping[str, str]
    data_dir: Path

    @classmethod
    def from_env(
        cls, env: Mapping[str, str] | None = None, data_dir: Path | None = None
    ) -> Settings:
        source = os.environ if env is None else env
        values = {name: value.strip() for name, value in source.items() if value}
        return cls(
            values=values,
            data_dir=data_dir or Path(values.get("FRIDAY_DATA_DIR") or SERVICES_ROOT / "data"),
        )

    def get(self, name: str, default: str = "") -> str:
        return self.values.get(name, "").strip() or default

    def missing(self, names: tuple[str, ...]) -> list[str]:
        return [name for name in names if not self.get(name)]

    @property
    def services_token(self) -> str:
        return self.get("FRIDAY_SERVICES_TOKEN")

    @property
    def owner_name(self) -> str:
        return self.get("FRIDAY_OWNER_NAME", "my owner")

    @property
    def timezone(self) -> str:
        return self.get("TIMEZONE", "Asia/Kolkata")

    @property
    def host(self) -> str:
        return self.get("FRIDAY_SERVICES_HOST", "127.0.0.1")

    @property
    def port(self) -> int:
        return int(self.get("FRIDAY_SERVICES_PORT", "8765"))

    @property
    def public_url(self) -> str:
        return self.get("PUBLIC_URL").rstrip("/")

    @property
    def calendar_url(self) -> str:
        # The Dot computer runs in Docker, where the host is host.docker.internal.
        return self.get(
            "FRIDAY_CALENDAR_URL", f"http://host.docker.internal:{self.port}/calendar"
        ).rstrip("/")

    @property
    def evon_disable_thinking(self) -> bool:
        # Evon reasons before answering by default, which is too slow on a phone
        # line. Set EVON_DISABLE_THINKING=false if the endpoint rejects
        # chat_template_kwargs (friday/scripts/test-evon-tools.mjs shows this).
        return self.get("EVON_DISABLE_THINKING", "true").lower() != "false"
