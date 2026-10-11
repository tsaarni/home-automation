"""MQTT gateway: subscribe wildcards, map topics onto (device, attr), publish writes.

The gateway is deliberately dumb: it turns messages into typed values and hands them
to the service, which owns the single apply_state path. Own write echoes are ignored
so a write never re-triggers the rule that produced it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

import aiomqtt

from .util import get_path, topic_matches

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class Route:
    """A read binding: messages matching pattern, at path, land in device.attr."""

    pattern: str
    path: str | None
    device: str
    attr: str


def payload_to_text(payload: Any) -> str:
    """MQTT payload -> text, keeping the raw bytes readable."""
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload).decode("utf-8", errors="replace")
    return str(payload)


def parse_payload(text: str) -> Any:
    """JSON when it looks like JSON, the raw string otherwise."""
    stripped = text.strip()
    if stripped[:1] in ("{", "["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return stripped
    if stripped in ("true", "false", "null") or _is_number(stripped):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return stripped
    return stripped


def _is_number(text: str) -> bool:
    try:
        float(text)
        return True
    except ValueError:
        return False


def encode_payload(payload: Any) -> str:
    """Value -> MQTT payload text (JSON for containers and booleans)."""
    if payload is None:
        return ""
    if isinstance(payload, bool):
        return "true" if payload else "false"
    if isinstance(payload, (dict, list)):
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return str(payload)


class NullGateway:
    """Stand-in when MQTT is disabled; records publishes instead of sending them."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    @property
    def connected(self) -> bool:
        return False

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    def rebuild_routes(self) -> None:
        return None

    async def publish(self, topic: str, payload: Any, *, retain: bool = False) -> dict[str, Any]:
        record = {"topic": topic, "payload": payload, "retain": retain}
        self.sent.append(record)
        return record


class MqttGateway:
    """Reconnecting MQTT client plus the topic -> attribute routing table."""

    def __init__(self, service: Any, *, client_factory: Callable[[], Any] | None = None) -> None:
        self.service = service
        self.log = LOGGER
        self._client_factory = client_factory or self._default_client
        self._client: Any = None
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self._connected = False
        self._routes: list[Route] = []
        self._exact: dict[str, list[Route]] = {}
        self._wildcards: list[Route] = []
        self._routes_version = -1
        self._recent: dict[tuple[str, str], float] = {}

    # ------------------------------------------------------------------ transport

    def _default_client(self) -> Any:
        settings = self.service.settings.mqtt
        return aiomqtt.Client(
            hostname=settings.host,
            port=settings.port,
            username=settings.username,
            password=settings.password,
            identifier=settings.client_id,
            keepalive=settings.keepalive,
        )

    @property
    def connected(self) -> bool:
        return self._connected

    async def start(self) -> None:
        if not self.service.settings.mqtt.enabled:
            return
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="mqtt-gateway")

    async def stop(self) -> None:
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self._connected = False

    async def _run(self) -> None:
        settings = self.service.settings.mqtt
        delay = settings.reconnect_min
        while not self._stopping:
            try:
                async with self._client_factory() as client:
                    self._client = client
                    for topic in self.service.settings.mqtt.topics:
                        await client.subscribe(topic)
                    self._connected = True
                    delay = settings.reconnect_min
                    self.log.info("mqtt connected to %s:%s, subscribed %s", settings.host, settings.port, list(settings.topics))
                    await self.service.on_mqtt_connected()
                    async for message in client.messages:
                        await self._on_message(str(message.topic), message.payload)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.log.warning("mqtt connection problem: %s", exc)
                self._note("error", str(exc))
            finally:
                if self._connected:
                    self._note("disconnected", None)
                self._connected = False
                self._client = None
            if self._stopping:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, settings.reconnect_max)

    def _note(self, status: str, detail: str | None) -> None:
        event = {"type": "mqtt", "status": status}
        if detail:
            event["error"] = detail
        self.service.store.append_event(event)

    async def publish(self, topic: str, payload: Any, *, retain: bool = False) -> dict[str, Any]:
        text = encode_payload(payload)
        self._remember(topic, text)
        client = self._client
        if client is None:
            raise RuntimeError("mqtt is not connected")
        await client.publish(topic, text, retain=retain)
        return {"topic": topic, "payload": text, "retain": retain}

    # ------------------------------------------------------------------- routing

    def _remember(self, topic: str, text: str) -> None:
        now = time.monotonic()
        self._recent[(topic, text)] = now
        if len(self._recent) > 256:
            ttl = self.service.settings.recent_write_ttl
            for key in [key for key, stamp in self._recent.items() if now - stamp > ttl]:
                del self._recent[key]

    def _is_echo(self, topic: str, text: str) -> bool:
        stamp = self._recent.get((topic, text))
        if stamp is None:
            return False
        return time.monotonic() - stamp <= self.service.settings.recent_write_ttl

    def rebuild_routes(self) -> None:
        """Rebuild the topic routing table from the current devices."""
        routes: list[Route] = []
        for device in self.service.store.devices.values():
            for attr, attribute in device.attributes.items():
                if attribute.read is not None:
                    routes.append(Route(pattern=attribute.read.topic, path=attribute.read.path, device=device.id, attr=attr))
        self._routes = routes
        self._exact = {}
        self._wildcards = []
        for route in routes:
            if "+" in route.pattern or "#" in route.pattern:
                self._wildcards.append(route)
            else:
                self._exact.setdefault(route.pattern, []).append(route)
        self._routes_version = self.service.store.version
        self.log.debug("mqtt routes: %d (%d wildcards)", len(routes), len(self._wildcards))

    def _ensure_routes(self) -> None:
        if self._routes_version != self.service.store.version:
            self.rebuild_routes()

    def matching_routes(self, topic: str) -> list[Route]:
        self._ensure_routes()
        routes = list(self._exact.get(topic, ()))
        if self._wildcards:
            routes.extend(route for route in self._wildcards if topic_matches(route.pattern, topic))
        return routes

    async def _on_message(self, topic: str, payload: Any) -> None:
        text = payload_to_text(payload)
        if self._is_echo(topic, text):
            self.log.debug("ignoring own write echo on %s", topic)
            return
        await self.handle_message(topic, text)

    async def handle_message(self, topic: str, payload: Any) -> list[tuple[str, str, Any]]:
        """Route one message into state; returns the (device, attr, value) triples that changed."""
        routes = self.matching_routes(topic)
        if not routes:
            return []
        parsed = parse_payload(payload_to_text(payload))
        changes: list[tuple[str, str, Any]] = []
        for route in routes:
            found, raw = get_path(parsed, route.path)
            if not found:
                self.log.debug("topic %s has no %r for %s.%s", topic, route.path, route.device, route.attr)
                continue
            device = self.service.store.devices.get(route.device)
            attribute = device.attributes.get(route.attr) if device else None
            if attribute is None:
                continue
            try:
                value = attribute.decode(raw)
            except ValueError as exc:
                self.service.store.append_event(
                    {"type": "mqtt_value_error", "device": route.device, "attr": route.attr, "topic": topic, "payload": raw, "error": str(exc)}
                )
                continue
            if await self.service.ingest(route.device, route.attr, value, ts=self.service.clock()):
                changes.append((route.device, route.attr, value))
        return changes
