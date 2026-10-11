"""Shelly Gen2+ switch API, identity validation and normalized attributes."""
from datetime import datetime, timezone

import httpx

from ..config import ShellyConfig, secret
from .base import AttributeSpecs, Rejected, Values
from .http import checked, finite_number


class ShellyRpc:
    source = "device"
    writable = {"state"}
    confirmation_status = "confirmed"
    readback_interval = 0

    def __init__(self, config: ShellyConfig, timeout: float, client: httpx.AsyncClient | None = None, *, poll_interval: float = 15):
        self.config = config
        self.poll_interval = config.poll_interval or poll_interval
        auth = httpx.DigestAuth(secret(config.username_env), secret(config.password_env)) if config.username_env else None
        self.client = client or httpx.AsyncClient(base_url=config.url.rstrip("/"), timeout=timeout, auth=auth)

    async def rpc(self, method, params=None):
        data = checked(await self.client.post("/rpc", json={"id": 1, "method": method, "params": params or {}}))
        if not isinstance(data, dict) or "result" not in data:
            raise Rejected("invalid_rpc_response")
        return data["result"]

    async def initialize(self) -> Values:
        info = await self.rpc("Shelly.GetDeviceInfo")
        if info.get("id") != self.config.expected_device_id:
            raise Rejected("identity_mismatch")
        return info

    async def read(self) -> tuple[Values, Values]:
        data = await self.rpc("Switch.GetStatus", {"id": self.config.switch_id})
        if not isinstance(data.get("output"), bool):
            raise Rejected("missing_switch_output")
        values = {"state": data["output"]}
        for raw, normalized in (("apower", "power"), ("voltage", "voltage"), ("current", "current")):
            if finite_number(data.get(raw)):
                values[normalized] = data[raw]
        if finite_number((data.get("aenergy") or {}).get("total")):
            values["energy"] = data["aenergy"]["total"] / 1000
        if finite_number((data.get("temperature") or {}).get("tC")):
            values["device_temperature"] = data["temperature"]["tC"]
        return values, {"protection_errors": data.get("errors", [])}

    def validate(self, patch: Values) -> None:
        if set(patch) != {"state"} or not isinstance(patch["state"], bool):
            raise Rejected("only a boolean state patch is writable")

    async def apply(self, patch: Values, expires_at: datetime | None = None) -> None:
        self.validate(patch)
        await self.initialize()  # identity must still match immediately before every write
        if expires_at and datetime.now(timezone.utc) >= expires_at:
            raise Rejected("expired")
        await self.rpc("Switch.Set", {"id": self.config.switch_id, "on": patch["state"]})

    async def close(self) -> None:
        await self.client.aclose()

    async def export_attributes(self) -> AttributeSpecs:
        return {
            "state": {"type": "boolean", "default": False},
            "power": {"type": "number", "unit": "W"},
            "energy": {"type": "number", "unit": "kWh"},
            "voltage": {"type": "number", "unit": "V"},
            "current": {"type": "number", "unit": "A"},
            "device_temperature": {"type": "number", "unit": "C"},
        }

    async def inspect(self) -> Values:
        info = await self.initialize()
        values, metadata = await self.read()
        return {"identity": info["id"], "device_type": None, "values": values, "metadata": metadata}


def create(config, resources):
    defaults = resources.config.defaults
    return ShellyRpc(config, defaults.http_timeout, poll_interval=defaults.shelly_poll_interval)
