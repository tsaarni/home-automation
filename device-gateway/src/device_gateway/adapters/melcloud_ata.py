"""MELCloud air-to-air device discovery, state normalization and patch writes."""
import copy
import math
from datetime import datetime, timezone

from ..config import Bounds, MelCloudConfig
from .base import AttributeSpecs, Rejected, Values
from .http import finite_number
from .melcloud_client import MelCloudClient

MODES = {1: "heat", 2: "dry", 3: "cool", 7: "fan", 8: "auto"}


def timestamp(value):
    """MELCloud's unqualified communication timestamps are UTC, offsets stay real."""
    if not value:
        return None
    if isinstance(value, str) and value.startswith("/Date("):
        import re
        match = re.match(r"/Date\((-?\d+)", value)
        if not match:
            raise ValueError("invalid MELCloud timestamp")
        return datetime.fromtimestamp(int(match[1]) / 1000, timezone.utc).isoformat()
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def enumerate_devices(data, building=None):
    """Walk buildings, floors, areas and devices without assuming one layout."""
    if isinstance(data, list):
        for item in data:
            yield from enumerate_devices(item, building)
    elif isinstance(data, dict):
        building = data.get("BuildingID", building)
        if "Structure" in data:
            building = data.get("ID", building)
        if "DeviceID" in data and "Device" in data:
            yield {**data, "BuildingID": building}
        else:
            for value in data.values():
                if isinstance(value, (dict, list)):
                    yield from enumerate_devices(value, building)


class MelCloudAta:
    source = "melcloud"
    writable = {"mode", "setpoint"}
    confirmation_status = "reported"

    def __init__(self, config: MelCloudConfig, account: MelCloudClient):
        self.config = config
        self.poll_interval = config.poll_interval or 300
        self.readback_interval = config.followup_interval
        self.account = account
        self.info = None
        self.raw = None

    async def initialize(self) -> Values:
        devices = list(enumerate_devices(await self.account.request("GET", "User/ListDevices")))
        matches = [d for d in devices if d["DeviceID"] == self.config.device_id]
        if len(matches) != 1:
            raise Rejected("identity_not_unique_or_missing")
        self.info = matches[0]
        if self.info["Device"].get("DeviceType") != 0:
            raise Rejected("only DeviceType=0 air-to-air is supported")
        if self.info.get("BuildingID") is None:
            raise Rejected("missing_building_id")
        if self.account.fahrenheit:
            raise Rejected("account must use Celsius before enabling this adapter")
        return self.info

    def bounds(self, mode):
        if mode in self.config.setpoint_bounds:
            return self.config.setpoint_bounds[mode]
        suffix = {"heat": "Heat", "cool": "CoolDry"}.get(mode)
        metadata = self.info["Device"] if self.info else {}
        if not suffix or metadata.get("MinTemp" + suffix) is None or metadata.get("MaxTemp" + suffix) is None:
            raise Rejected("missing mode-specific bounds; configure setpoint_bounds")
        return Bounds(min=metadata["MinTemp" + suffix], max=metadata["MaxTemp" + suffix], step=metadata.get("TemperatureIncrement", .5))

    async def read(self) -> tuple[Values, Values]:
        if self.info is None:
            await self.initialize()
        data = await self.account.request("GET", "Device/Get", params={"id": self.config.device_id, "buildingID": self.info["BuildingID"]})
        if data.get("DeviceID") != self.config.device_id or data.get("DeviceType", 0) != 0:
            raise Rejected("identity_mismatch")
        if not isinstance(data.get("OperationMode"), int) or not finite_number(data.get("SetTemperature")):
            raise Rejected("incomplete_device_state")
        self.raw = data
        values = {"mode": MODES.get(data["OperationMode"], "unknown"), "setpoint": data["SetTemperature"]}
        for raw, name in (("RoomTemperature", "temperature"), ("Power", "power"), ("SetFanSpeed", "fan_speed"), ("VaneHorizontal", "vane_horizontal"), ("VaneVertical", "vane_vertical")):
            if isinstance(data.get(raw), bool) if raw == "Power" else finite_number(data.get(raw)):
                values[name] = data[raw]
        metadata = {"pending_command": data.get("HasPendingCommand")}
        for raw, name in (("LastCommunication", "last_communication"), ("LastTimeStamp", "captured_at")):
            if data.get(raw):
                metadata[name] = timestamp(data[raw])
        return values, metadata

    def validate(self, patch: Values) -> None:
        if not patch or set(patch) - self.writable:
            raise Rejected("only mode and setpoint are writable")
        mode = patch.get("mode", MODES.get((self.raw or {}).get("OperationMode")))
        if mode not in ("heat", "cool"):
            raise Rejected("resulting mode must be heat or cool")
        bounds = self.bounds(mode)
        value = patch.get("setpoint", (self.raw or {}).get("SetTemperature"))
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise Rejected("setpoint must be a finite number")
        if not bounds.min <= value <= bounds.max or abs((value - bounds.min) / bounds.step - round((value - bounds.min) / bounds.step)) > 1e-7:
            raise Rejected(f"setpoint must be {bounds.min}..{bounds.max} in steps of {bounds.step}; send mode and setpoint together")

    async def apply(self, patch: Values, expires_at: datetime | None = None) -> None:
        try:
            await self.read()  # never merge from stale setter responses
        except Exception as exc:
            raise Rejected("preflight_read_failed") from exc
        self.validate(patch)
        payload = copy.deepcopy(self.raw)
        flags = payload.get("EffectiveFlags", 0)
        for name, value in patch.items():
            if name == "mode":
                payload["OperationMode"] = {"heat": 1, "cool": 3}[value]
                flags |= 2
            else:
                payload["SetTemperature"] = value
                flags |= 4
        payload.update(EffectiveFlags=flags, HasPendingCommand=True)
        if expires_at and datetime.now(timezone.utc) >= expires_at:
            raise Rejected("expired")
        result = await self.account.request("POST", "Device/SetAta", json=payload, expires_at=expires_at)
        if result is False or result is None:
            raise Rejected("setter_rejected")

    async def close(self) -> None:
        pass  # account owns the shared HTTP client

    async def export_attributes(self) -> AttributeSpecs:
        if len(self.config.setpoint_bounds) < 2 and self.info is None:
            await self.initialize()
        bounds = [self.bounds(mode) for mode in ("heat", "cool")]
        return {
            "setpoint": {"type": "number", "unit": "C", "limits": [min(b.min for b in bounds), max(b.max for b in bounds)]},
            "mode": {"type": "string", "enum": ["heat", "cool"]},
            "temperature": {"type": "number", "unit": "C"},
            "power": {"type": "boolean"},
            "fan_speed": {"type": "number"},
            "vane_horizontal": {"type": "number"},
            "vane_vertical": {"type": "number"},
        }

    async def inspect(self) -> Values:
        info = await self.initialize()
        values, metadata = await self.read()
        return {
            "identity": info["DeviceID"], "device_type": info["Device"]["DeviceType"],
            "values": values, "metadata": metadata,
            "setpoint_bounds": {mode: self.bounds(mode).model_dump() for mode in ("heat", "cool")},
        }


def create(config, resources):
    account = resources.shared(
        ("melcloud", config.account),
        lambda: MelCloudClient(resources.config.accounts[config.account], resources.config.defaults.http_timeout),
    )
    return MelCloudAta(config, account)
