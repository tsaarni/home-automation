"""MQTT connection, QoS, availability and routing of command envelopes."""
import asyncio
import json
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any

import aiomqtt

from .config import MQTT, secret

LOG = logging.getLogger(__name__)
OnConnect = Callable[[], Awaitable[None]]
OnCommand = Callable[[str, bytes | bytearray, bool], Awaitable[None]]


class MqttTransport:
    def __init__(self, config: MQTT):
        self.config = config
        self._client = None

    @property
    def connected(self) -> bool:
        return self._client is not None

    async def publish(self, suffix: str, data: Any, retain: bool = False) -> None:
        if self._client:
            try:
                await self._client.publish(
                    f"{self.config.topic_prefix}/{suffix}",
                    json.dumps(data, allow_nan=False), qos=1, retain=retain,
                )
            except aiomqtt.MqttError:
                LOG.warning("MQTT publication failed for %s", suffix)

    async def run(self, on_connect: OnConnect, on_command: OnCommand) -> None:
        config = self.config
        delay = 1
        while True:
            try:
                async with aiomqtt.Client(
                    hostname=config.host, port=config.port,
                    username=secret(config.username_env) if config.username_env else None,
                    password=secret(config.password_env) if config.password_env else None,
                    identifier="device-gateway", clean_session=True,
                    max_queued_incoming_messages=128,
                    will=aiomqtt.Will(
                        f"{config.topic_prefix}/availability",
                        json.dumps({"available": False}), qos=1, retain=True,
                    ),
                ) as client:
                    self._client = client
                    await client.subscribe(f"{config.topic_prefix}/+/set", qos=1)
                    await self.publish("availability", {"available": True}, retain=True)
                    await on_connect()
                    delay = 1
                    try:
                        async for message in client.messages:
                            device_id = str(message.topic).removeprefix(config.topic_prefix + "/").split("/")[0]
                            await on_command(device_id, message.payload, message.retain)
                    finally:
                        await self.publish("availability", {"available": False}, retain=True)
            except aiomqtt.MqttError:
                LOG.warning("MQTT disconnected")
            finally:
                self._client = None
            await asyncio.sleep(delay * random.uniform(.8, 1.2))
            delay = min(60, delay * 2)
