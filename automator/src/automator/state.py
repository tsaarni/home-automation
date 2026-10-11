"""Current attribute values, in memory only.

State is rebuilt from MQTT on boot; nothing here is persisted. Every value change
goes through StateStore.set, which reports whether the value actually changed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


class _Unset:
    """Sentinel for "no value yet"; falsy so it behaves like a missing value."""

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET = _Unset()


def values_equal(left: Any, right: Any) -> bool:
    """Compare state values; numbers compare numerically with a small tolerance."""
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right or left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return abs(float(left) - float(right)) <= 1e-9
    return left == right


@dataclass(frozen=True)
class Value:
    """One attribute reading."""

    value: Any
    ts: datetime
    source: str
    seq: int

    def as_dict(self) -> dict[str, Any]:
        return {"value": self.value, "ts": self.ts.isoformat(timespec="milliseconds"), "source": self.source}


class StateStore:
    """(device, attr) -> Value, plus a small sequence counter for audit ordering."""

    def __init__(self) -> None:
        self._values: dict[tuple[str, str], Value] = {}
        self._seq = 0

    def get(self, device: str, attr: str) -> Value | None:
        return self._values.get((device, attr))

    def value(self, device: str, attr: str, default: Any = None) -> Any:
        found = self._values.get((device, attr))
        return default if found is None else found.value

    def known(self, device: str, attr: str) -> bool:
        return (device, attr) in self._values

    def set(self, device: str, attr: str, value: Any, ts: datetime, source: str) -> tuple[bool, Value | None]:
        """Store a value, returning (changed, previous)."""
        key = (device, attr)
        previous = self._values.get(key)
        changed = previous is None or not values_equal(previous.value, value)
        if not changed:
            return False, previous
        self._seq += 1
        self._values[key] = Value(value=value, ts=ts, source=source, seq=self._seq)
        return True, previous

    def refresh(self, device: str, attr: str, value: Any, ts: datetime, source: str) -> None:
        """Refresh an unchanged gateway observation without incrementing its change sequence."""
        previous = self.get(device, attr)
        if previous is not None:
            self._values[(device, attr)] = Value(value, ts, source, previous.seq)

    def snapshot(self) -> dict[str, dict[str, dict[str, Any]]]:
        result: dict[str, dict[str, dict[str, Any]]] = {}
        for (device, attr), value in self._values.items():
            result.setdefault(device, {})[attr] = value.as_dict()
        return result

    def device_snapshot(self, device: str) -> dict[str, dict[str, Any]]:
        return {attr: value.as_dict() for (dev, attr), value in self._values.items() if dev == device}

    def forget_device(self, device: str) -> None:
        for key in [key for key in self._values if key[0] == device]:
            del self._values[key]

    def forget_attribute(self, device: str, attr: str) -> None:
        self._values.pop((device, attr), None)

    def __len__(self) -> int:
        return len(self._values)
