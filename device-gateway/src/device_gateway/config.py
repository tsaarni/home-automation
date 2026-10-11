"""Strict, restart-only configuration. Secrets never appear in exported documents."""
import os
import re
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, BeforeValidator, model_validator


def duration(value):
    if isinstance(value, str):
        match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m|h)", value)
        if not match:
            raise ValueError("expected a positive duration, e.g. 15s or 5m")
        value = float(match[1]) * {"ms": .001, "s": 1, "m": 60, "h": 3600}[match[2]]
    if isinstance(value, bool) or float(value) <= 0:
        raise ValueError("duration must be positive")
    return float(value)


Seconds = Annotated[float, BeforeValidator(duration), Field(gt=0, allow_inf_nan=False)]
Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(Strict):
    username_env: str
    password_env: str

    def credentials(self):
        return secret(self.username_env), secret(self.password_env)


def secret(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"missing secret environment variable {name}")
    return value


class MQTT(Strict):
    host: str = "mosquitto"
    port: int = Field(default=1883, ge=1, le=65535)
    topic_prefix: str = "home/device-gateway"
    username_env: str | None = None
    password_env: str | None = None

    @model_validator(mode="after")
    def validate_prefix(self):
        if not self.topic_prefix.strip("/") or any(c in self.topic_prefix for c in "+#"):
            raise ValueError("topic_prefix must be a concrete topic")
        self.topic_prefix = self.topic_prefix.strip("/")
        return self


class Defaults(Strict):
    shelly_poll_interval: Seconds = 15
    http_timeout: Seconds = 5
    command_ttl: Seconds = 30


class Bounds(Strict):
    min: float = Field(allow_inf_nan=False)
    max: float = Field(allow_inf_nan=False)
    step: float = Field(default=.5, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def valid_range(self):
        if self.min >= self.max:
            raise ValueError("min must be less than max")
        return self


class DeviceSettings(Strict):
    """Settings shared by all device workers."""
    name: str
    poll_interval: Seconds | None = None
    followup_interval: Seconds = 60
    result_timeout: Seconds = 300

    def check_secrets(self):
        pass

    def validate_references(self, accounts):
        pass


class ShellyConfig(DeviceSettings):
    adapter: Literal["shelly-rpc"] = "shelly-rpc"
    url: str
    expected_device_id: str = Field(min_length=1)
    switch_id: int = Field(default=0, ge=0)
    username_env: str | None = None
    password_env: str | None = None

    @model_validator(mode="after")
    def shape(self):
        from urllib.parse import urlparse
        parsed = urlparse(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("Shelly requires an HTTP URL without credentials/query/fragment")
        if bool(self.username_env) != bool(self.password_env):
            raise ValueError("both credential references are required")
        return self

    def check_secrets(self):
        for name in (self.username_env, self.password_env):
            if name:
                secret(name)


class MelCloudConfig(DeviceSettings):
    adapter: Literal["melcloud-ata"] = "melcloud-ata"
    account: Identifier
    device_id: int = Field(gt=0)
    setpoint_bounds: dict[Literal["heat", "cool"], Bounds] = Field(default_factory=dict)

    def validate_references(self, accounts):
        if self.account not in accounts:
            raise ValueError(f"unknown account {self.account}")


Device = Annotated[ShellyConfig | MelCloudConfig, Field(discriminator="adapter")]


class Config(Strict):
    mqtt: MQTT = Field(default_factory=MQTT)
    defaults: Defaults = Field(default_factory=Defaults)
    accounts: dict[Identifier, Credentials] = Field(default_factory=dict)
    devices: dict[Identifier, Device] = Field(min_length=1)
    health_port: int = Field(default=8080, ge=1, le=65535)

    @model_validator(mode="after")
    def references(self):
        for device in self.devices.values():
            device.validate_references(self.accounts)
        return self

    def check_secrets(self):
        for account in self.accounts.values():
            account.credentials()
        for name in (self.mqtt.username_env, self.mqtt.password_env):
            if name:
                secret(name)
        for device in self.devices.values():
            device.check_secrets()


def load(path, *, secrets=True):
    config = Config.model_validate(yaml.safe_load(Path(path).read_text()))
    if secrets:
        config.check_secrets()
    return config
