"""Adapter construction and ownership of per-device/shared resources."""
import asyncio
from typing import Callable, TypeVar, cast

from .adapters import ADAPTERS
from .adapters.base import Adapter, Closable
from .config import Config, Device

T = TypeVar("T", bound=Closable)


class AdapterFactory:
    def __init__(self, config: Config):
        self.config = config
        self._shared: dict[tuple[str, str], Closable] = {}
        self._adapters: list[Adapter] = []

    def shared(self, key: tuple[str, str], create: Callable[[], T]) -> T:
        if key not in self._shared:
            self._shared[key] = create()
        return cast(T, self._shared[key])

    def create(self, device: Device) -> Adapter:
        adapter = ADAPTERS[device.adapter](device, self)
        self._adapters.append(adapter)
        return adapter

    def create_all(self) -> dict[str, Adapter]:
        return {name: self.create(device) for name, device in self.config.devices.items()}

    async def close(self) -> None:
        try:
            await asyncio.gather(*(adapter.close() for adapter in self._adapters))
        finally:
            await asyncio.gather(*(resource.close() for resource in self._shared.values()))
            self._adapters.clear()
            self._shared.clear()
