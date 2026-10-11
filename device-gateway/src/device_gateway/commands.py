"""MQTT command envelope and outcome constants."""
from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator


TERMINAL = {"confirmed", "reported", "failed", "unconfirmed"}


def now():
    return datetime.now(timezone.utc)


def stamp():
    return now().isoformat()


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)
    values: dict = Field(min_length=1, max_length=16)
    expires_at: datetime

    @field_validator("expires_at")
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None:
            raise ValueError("expires_at requires timezone")
        return value
