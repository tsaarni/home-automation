"""Compose the adapters, workers, MQTT transport and health server.

This module owns startup/shutdown and wiring only. Device behavior lives in
adapters; command execution lives in workers; broker behavior lives in mqtt.
"""
import asyncio
from functools import partial

from . import health
from .config import Config
from .factory import AdapterFactory
from .mqtt import MqttTransport
from .worker import Worker


class Service:
    def __init__(self, config: Config):
        self.config = config
        self.factory = AdapterFactory(config)
        self.mqtt = MqttTransport(config.mqtt)
        self.workers = {
            name: Worker(name, config.devices[name], adapter, self.mqtt.publish)
            for name, adapter in self.factory.create_all().items()
        }

    async def _refresh(self) -> None:
        for worker in self.workers.values():
            worker.next_poll = 0
            if worker.snapshot:
                await self.mqtt.publish(f"{worker.id}/state", worker.snapshot, retain=True)

    async def _command(self, device_id, payload, retained) -> None:
        worker = self.workers.get(device_id)
        if worker is not None:
            await worker.receive(payload, retained)

    async def run(self) -> None:
        tasks = []
        server = None
        try:
            server = await asyncio.start_server(
                partial(health.respond, ready=lambda: self.mqtt.connected),
                "0.0.0.0", self.config.health_port,
            )
            tasks = [
                asyncio.create_task(worker.run_forever(), name=name)
                for name, worker in self.workers.items()
            ]
            await self.mqtt.run(self._refresh, self._command)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if server is not None:
                server.close()
                await server.wait_closed()
            await self.factory.close()
