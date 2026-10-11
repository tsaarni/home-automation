"""Test helpers: fake clock, broker stand-in, ASGI micro client, document builders."""

from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from automator.config import MqttSettings, Settings
from automator.models import Device, Group, Rule
from automator.mqtt_gateway import NullGateway
from automator.service import Service

UTC = timezone.utc
# the real house location (same as deploy/app.yaml), so solar times match production
HELSINKI_LAT = 60.4518
HELSINKI_LON = 22.2666


class FakeClock:
    """Deterministic clock; advance it to drive schedules and timers."""

    def __init__(self, start: datetime | None = None) -> None:
        self.now = start or datetime(2026, 3, 2, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> datetime:
        self.now = self.now + timedelta(seconds=seconds)
        return self.now

    def set(self, value: datetime) -> datetime:
        self.now = value
        return self.now


def run(coro: Any) -> Any:
    """Run a coroutine to completion (keeps the suite free of pytest-asyncio)."""
    return asyncio.run(coro)


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "data_dir": Path(tmp_path) / "data",
        "tz": "Europe/Helsinki",
        "latitude": HELSINKI_LAT,
        "longitude": HELSINKI_LON,
        "mqtt": MqttSettings(url="none"),
    }
    values.update(overrides)
    return Settings(**values)


def make_service(tmp_path: Path, clock: FakeClock | None = None, **overrides: Any) -> Service:
    settings = make_settings(tmp_path, **overrides)
    return Service(settings, clock=clock or FakeClock(), gateway=NullGateway())


def make_gateway_service(tmp_path: Path, clock: FakeClock | None = None, **overrides: Any) -> tuple[Service, "FakeMqttClient"]:
    """A service whose MQTT gateway talks to a fake, in-process client."""
    from automator.mqtt_gateway import MqttGateway

    overrides.setdefault("mqtt", MqttSettings(url="localhost", host="localhost"))
    settings = make_settings(tmp_path, **overrides)
    service = Service(settings, clock=clock or FakeClock())
    client = FakeMqttClient()
    service.gateway = MqttGateway(service, client_factory=lambda: client)
    return service, client


@contextlib.asynccontextmanager
async def running_service(service: Service, client: "FakeMqttClient | None" = None) -> Any:
    """Start the service (and its gateway) for the duration of the block."""
    await service.start()
    if client is not None:
        for _ in range(200):
            await asyncio.sleep(0.005)
            if client.subscriptions:
                break
    try:
        yield service
    finally:
        await service.stop()


def add_documents(service: Service, *, devices: list[dict[str, Any]] = (), groups: list[dict[str, Any]] = (), rules: list[dict[str, Any]] = ()) -> None:
    """Seed documents straight into the store (writes config.json, like the API would)."""
    for document in devices:
        service.store.put_device(Device.model_validate(document))
    for document in groups:
        service.store.put_group(Group.model_validate(document))
    for document in rules:
        service.store.put_rule(Rule.model_validate(document))


def thermostat_doc(device_id: str = "thermostat-bathroom", **attribute_overrides: Any) -> dict[str, Any]:
    """A zwave-style thermostat with a setpoint and a temperature."""
    setpoint = {
        "read": {"topic": f"zwave/{device_id}/67/0/setpoint/1", "path": "value"},
        "write": {"topic": f"zwave/{device_id}/67/0/setpoint/1/set", "payload": {"value": "$v"}},
        "type": "number",
        "unit": "C",
        "limits": [5, 30],
    }
    setpoint.update(attribute_overrides)
    return {
        "id": device_id,
        "attributes": {
            "setpoint": setpoint,
            "temperature": {"read": {"topic": f"zwave/{device_id}/49/0/Air_temperature", "path": "value"}, "type": "number"},
        },
    }


def plug_doc(device_id: str = "powerplug-terrace") -> dict[str, Any]:
    """A zigbee2mqtt-style plug: one topic, value inside the JSON payload."""
    return {
        "id": device_id,
        "attributes": {
            "state": {
                "read": {"topic": f"zigbee2mqtt/{device_id}", "path": "state"},
                "write": {"topic": f"zigbee2mqtt/{device_id}/set", "payload": {"state": "$v"}},
                "type": "string",
                "enum": ["ON", "OFF"],
            },
            "power": {"read": {"topic": f"zigbee2mqtt/{device_id}", "path": "power"}, "type": "number", "unit": "W"},
        },
    }


def group_doc(group_id: str = "floor-heating", members: list[str] | None = None) -> dict[str, Any]:
    if members is None:
        members = ["floor-heating-a", "floor-heating-b"]
    return {"id": group_id, "name": group_id, "members": members}


def plug_group_members(group_id: str = "floor-heating", count: int = 2) -> list[dict[str, Any]]:
    return [plug_doc(f"{group_id}-{chr(ord('a') + index)}") for index in range(count)]


class FakeMessage:
    """Just enough of aiomqtt.Message for the gateway."""

    def __init__(self, topic: str, payload: Any) -> None:
        self.topic = topic
        self.payload = payload


class FakeMqttClient:
    """aiomqtt.Client stand-in: messages come from a queue, publishes are recorded."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue[Any] = asyncio.Queue()
        self.subscriptions: list[str] = []
        self.published: list[dict[str, Any]] = []

    async def __aenter__(self) -> "FakeMqttClient":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def subscribe(self, topic: Any, **kwargs: Any) -> None:
        self.subscriptions.append(str(topic))

    async def publish(self, topic: Any, payload: Any, retain: bool = False, **kwargs: Any) -> None:
        self.published.append({"topic": str(topic), "payload": payload, "retain": retain})

    @property
    def messages(self) -> Any:
        return self._stream()

    async def _stream(self) -> Any:
        while True:
            message = await self.queue.get()
            if message is None:
                return
            yield message

    async def feed(self, topic: str, payload: Any) -> None:
        await self.queue.put(FakeMessage(topic, payload))

    async def close(self) -> None:
        await self.queue.put(None)


class Response:
    """Result of an ASGI request through the micro client."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class ApiClient:
    """Dependency-free ASGI client (no httpx needed)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def request(self, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None) -> Response:
        raw = b"" if body is None else json.dumps(body).encode("utf-8")
        target, _, query = path.partition("?")
        request_headers = [(b"host", b"test")]
        if body is not None:
            request_headers.append((b"content-type", b"application/json"))
        for key, value in (headers or {}).items():
            request_headers.append((key.lower().encode(), str(value).encode()))
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": target,
            "raw_path": target.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": request_headers,
            "client": ("test", 1),
            "server": ("test", 80),
        }
        sent = {"status": 500, "headers": [], "body": b""}

        async def receive() -> dict[str, Any]:
            return {"type": "http.request", "body": raw, "more_body": False}

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                sent["status"] = message["status"]
                sent["headers"] = message.get("headers", [])
            elif message["type"] == "http.response.body":
                sent["body"] += message.get("body", b"")

        await self.app(scope, receive, send)
        header_map = {key.decode(): value.decode() for key, value in sent["headers"]}
        return Response(sent["status"], header_map, sent["body"])

    async def get(self, path: str) -> Response:
        return await self.request("GET", path)

    async def post(self, path: str, body: Any = None) -> Response:
        return await self.request("POST", path, {} if body is None else body)

    async def put(self, path: str, body: Any) -> Response:
        return await self.request("PUT", path, body)

    async def delete(self, path: str) -> Response:
        return await self.request("DELETE", path)
