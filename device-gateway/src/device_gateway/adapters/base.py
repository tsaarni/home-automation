"""Contract implemented by each device adapter.

The worker serializes calls. Adapters own API details, validation, normalized
attributes and readback timing; MQTT and command correlation belong to the worker.
"""
from datetime import datetime
from typing import Any, Callable, Protocol, TypeVar

from ..config import Config, Device

Values = dict[str, Any]
AttributeSpecs = dict[str, dict[str, Any]]


class Closable(Protocol):
    async def close(self) -> None: ...


T = TypeVar("T", bound=Closable)


class Rejected(ValueError):
    """Definite validation/API rejection (no uncertain transport delivery)."""


class Adapter(Protocol):
    source: str
    writable: set[str]
    confirmation_status: str
    poll_interval: float
    readback_interval: float

    async def initialize(self) -> Values: ...
    async def read(self) -> tuple[Values, Values]: ...
    def validate(self, patch: Values) -> None: ...
    async def apply(self, patch: Values, expires_at: datetime | None = None) -> None: ...
    async def export_attributes(self) -> AttributeSpecs: ...
    async def inspect(self) -> Values: ...
    async def close(self) -> None: ...


class Resources(Protocol):
    """Factory context for configuration and shared, lifecycle-owned clients."""
    config: Config

    def shared(self, key: tuple[str, str], create: Callable[[], T]) -> T: ...
