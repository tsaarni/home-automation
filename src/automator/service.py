"""Service: the one object that owns the store, state, gateway, evaluator and scheduler.

Every state change - MQTT read, manual set, action write - goes through apply_state,
and that is the only place rules are re-evaluated.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta
from typing import Any, Iterator

from . import __version__
from .config import Settings
from .evaluator import Evaluator, Write
from .mqtt_gateway import MqttGateway, NullGateway
from .scheduler import Scheduler
from .state import StateStore, values_equal
from .store import Store
from .util import now_utc, to_iso

LOGGER = logging.getLogger(__name__)


def _metric_line(name: str, labels: tuple[tuple[str, str], ...], value: float) -> str:
    if labels:
        rendered = ",".join(f'{key}="{item}"' for key, item in labels)
        return f"{name}{{{rendered}}} {value:g}"
    return f"{name} {value:g}"


class Metrics:
    """Small counter/gauge registry, rendered as Prometheus text."""

    def __init__(self) -> None:
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
        self._gauges: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}

    @staticmethod
    def _labels(labels: dict[str, str] | None) -> tuple[tuple[str, str], ...]:
        return tuple(sorted((labels or {}).items()))

    def inc(self, name: str, labels: dict[str, str] | None = None, amount: float = 1) -> None:
        key = (name, self._labels(labels))
        self._counters[key] = self._counters.get(key, 0) + amount

    def set(self, name: str, value: float, labels: dict[str, str] | None = None) -> None:
        self._gauges[(name, self._labels(labels))] = value

    def render(self) -> str:
        lines: list[str] = []
        for kind, registry in (("counter", self._counters), ("gauge", self._gauges)):
            names = sorted({name for name, _labels in registry})
            for name in names:
                lines.append(f"# TYPE {name} {kind}")
                for (metric, labels), value in sorted(registry.items()):
                    if metric == name:
                        lines.append(_metric_line(name, labels, value))
        return "\n".join(lines) + "\n"


class Service:
    """Owns everything; safe to construct without a running broker."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        clock: Any = None,
        store: Store | None = None,
        gateway: Any = None,
    ) -> None:
        self.settings = settings or Settings.from_env()
        self.clock = clock or now_utc
        self.metrics = Metrics()
        self.store = store or Store(
            self.settings.data_dir,
            clock=self.clock,
            events_max_bytes=self.settings.events_max_bytes,
            events_memory=self.settings.events_memory,
        )
        self.state = StateStore()
        self.evaluator = Evaluator(self)
        self.scheduler = Scheduler(self)
        if gateway is None:
            gateway = MqttGateway(self) if self.settings.mqtt.enabled else NullGateway()
        self.gateway = gateway
        self.dry_run: bool = self.settings.dry_run
        self.started_at: datetime | None = None

        self._lock = asyncio.Lock()
        self._lock_owner: asyncio.Task[Any] | None = None
        self._depth = 0
        self._tasks: list[asyncio.Task[Any]] = []
        self._started = False
        self._describe_metrics()

    # ------------------------------------------------------------- lifecycle

    @property
    def depth(self) -> int:
        """How deep the current write -> state change -> rule chain is."""
        return self._depth

    COUNTERS = (
        "state_updates_total",
        "writes_total",
        "writes_skipped_total",
        "rule_fires_total",
        "rule_errors_total",
        "rule_conflicts_total",
        "rule_rate_limited_total",
        "rule_condition_false_total",
        "rule_once_total",
        "mqtt_connects_total",
        "publishes_total",
    )
    GAUGES = (
        "state_values",
        "pending_timers",
        "mqtt_connected",
        "uptime_seconds",
        "config_version",
    )

    def _describe_metrics(self) -> None:
        """Register the series so they show up before the first event."""
        for name in self.COUNTERS:
            self.metrics.inc(name, amount=0)
        for name in self.GAUGES:
            self.metrics.set(name, 0)

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.started_at = self.clock()
        self.store.load()
        self.evaluator.rebuild_index()
        warnings = self.settings.warnings()
        for warning in warnings:
            self.log_warning(warning)
        self.store.append_event(
            {
                "type": "boot",
                "version": __version__,
                "dry_run": self.dry_run,
                "devices": len(self.store.devices),
                "groups": len(self.store.groups),
                "rules": len(self.store.rules),
                "pending_timers": len(self.store.timers),
                "warnings": warnings,
            }
        )
        self.scheduler.boot(self.clock())
        await self.gateway.start()
        self._tasks.append(asyncio.create_task(self.scheduler.run_forever(), name="scheduler"))
        if isinstance(self.gateway, NullGateway):
            await self.evaluator.resync(self.clock())

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        await self.gateway.stop()
        self._started = False

    async def run(self) -> None:
        await self.start()
        try:
            await asyncio.Event().wait()
        finally:
            await self.stop()

    def log_warning(self, message: str) -> None:
        LOGGER.warning(message)

    # ------------------------------------------------------------------- locking

    @contextlib.asynccontextmanager
    async def critical(self) -> Iterator[None]:
        """Serialise state changes; re-entrant for the task that already holds it."""
        task = asyncio.current_task()
        if self._lock_owner is task:  # a rule write re-enters through the evaluator
            yield
            return
        async with self._lock:
            self._lock_owner = task
            try:
                yield
            finally:
                self._lock_owner = None

    # --------------------------------------------------------------- state path

    async def ingest(self, device: str, attr: str, value: Any, ts: datetime | None = None, source: str = "mqtt") -> bool:
        """Entry point for the MQTT gateway."""
        return await self.apply_state(device, attr, value, source=source, ts=ts)

    async def apply_state(
        self,
        device: str,
        attr: str,
        value: Any,
        source: str = "mqtt",
        ts: datetime | None = None,
    ) -> bool:
        """The single place a value changes; returns True when it actually changed."""
        async with self.critical():
            return await self._apply_state(device, attr, value, source, ts)

    async def _apply_state(self, device: str, attr: str, value: Any, source: str, ts: datetime | None = None) -> bool:
        stamp = ts or self.clock()
        changed, previous = self.state.set(device, attr, value, stamp, source)
        if not changed:
            return False
        self.metrics.inc("state_updates_total")
        self.store.append_event(
            {
                "type": "state",
                "device": device,
                "attr": attr,
                "value": value,
                "previous": previous.value if previous is not None else None,
                "source": source,
            }
        )
        self._depth += 1
        try:
            await self.evaluator.on_state_change(device, attr, value, previous.value if previous is not None else None, stamp, True, source)
        finally:
            self._depth -= 1
        return True

    # -------------------------------------------------------------------- writes

    def resolve_write(self, write: Write) -> dict[str, Any]:
        """Validate a write and describe what would happen, without doing it."""
        result: dict[str, Any] = {
            "type": "write",
            "ts": to_iso(self.clock()),
            "device": write.device,
            "attr": write.attr,
            "value": write.value,
            "previous": None,
            "rule": write.rule_id,
            "source": write.source,
            "status": "applied",
        }
        device = self.store.devices.get(write.device)
        if device is None:
            return {**result, "status": "error", "reason": "unknown_device"}
        attribute = device.attributes.get(write.attr)
        if attribute is None:
            return {**result, "status": "error", "reason": "unknown_attribute"}
        if device.locked:
            return {**result, "status": "skipped", "reason": "device_locked"}
        try:
            value = attribute.coerce(write.value, for_write=True)
        except ValueError as exc:
            return {**result, "status": "error", "reason": str(exc)}
        current = self.state.get(write.device, write.attr)
        previous = current.value if current is not None else None
        result = {**result, "value": value, "previous": previous}
        if current is not None and values_equal(previous, value):
            return {**result, "status": "unchanged"}
        topic = None
        payload = None
        retain = False
        if attribute.write is not None:
            topic = attribute.write.topic
            retain = attribute.write.retain
            payload = attribute.write_payload(value)
        return {**result, "topic": topic, "payload": payload, "retain": retain}

    async def apply_write(self, write: Write, *, dry_run: bool | None = None) -> dict[str, Any]:
        """Apply one write (publish + state + revert bookkeeping)."""
        async with self.critical():
            return await self._apply_write(write, dry_run=dry_run)

    async def _apply_write(self, write: Write, *, dry_run: bool | None = None) -> dict[str, Any]:
        dry = self.dry_run if dry_run is None else dry_run
        result = self.resolve_write(write)
        status = result["status"]
        if status in ("error", "skipped", "unchanged"):
            self.metrics.inc("writes_skipped_total", {"reason": str(result.get("reason") or status)})
            return self._record_write(result)
        if dry:
            result["status"] = "dry-run"
            self.metrics.inc("writes_total")
            return self._record_write(result)

        if result.get("topic") is not None:
            try:
                await self.gateway.publish(result["topic"], result["payload"], retain=bool(result["retain"]))
                self.metrics.inc("publishes_total")
            except Exception as exc:  # noqa: BLE001 - a broker hiccup must not corrupt state
                LOGGER.warning("publish to %s failed: %s", result["topic"], exc)
                return self._record_write({**result, "status": "error", "reason": f"publish_failed: {exc}"})

        if not write.is_revert:
            self.store.delete_timers(
                lambda timer: timer.get("kind") == "revert" and timer.get("device") == write.device and timer.get("attr") == write.attr
            )
            if write.revert_after is not None:
                self._arm_revert(write, result)

        await self._apply_state(write.device, write.attr, result["value"], write.source)
        self.metrics.inc("writes_total")
        result["status"] = "applied"
        return self._record_write(result)

    def _record_write(self, result: dict[str, Any]) -> dict[str, Any]:
        """Every write outcome ends up in the audit log exactly once."""
        self.store.append_event(result)
        return result

    def _arm_revert(self, write: Write, result: dict[str, Any]) -> None:
        attribute = self.store.devices[write.device].attributes[write.attr]
        previous = result.get("previous")
        has_value = previous is not None
        value = previous if has_value else attribute.default
        if value is None:
            self.store.append_event(
                {
                    "type": "timer",
                    "status": "refused",
                    "kind": "revert",
                    "device": write.device,
                    "attr": write.attr,
                    "rule": write.rule_id,
                    "reason": "no_value_to_restore",
                }
            )
            return
        due = self.clock() + (write.revert_after or timedelta(0))
        self.store.put_timer(
            {
                "id": f"revert:{write.device}:{write.attr}",
                "kind": "revert",
                "device": write.device,
                "attr": write.attr,
                "value": value,
                "has_value": has_value,
                "overridden_value": result.get("value"),
                "rule": write.rule_id,
                "created_at": self.clock(),
                "due_at": due,
            }
        )
        self.store.append_event(
            {
                "type": "timer",
                "status": "armed",
                "kind": "revert",
                "device": write.device,
                "attr": write.attr,
                "value": value,
                "rule": write.rule_id,
                "due_at": due.isoformat(),
            }
        )

    async def manual_set(
        self,
        device_id: str,
        values: dict[str, Any],
        *,
        revert_after: timedelta | None = None,
        source: str = "manual",
    ) -> list[dict[str, Any]]:
        """POST /devices/{id}/set: one write per attribute, all under one lock."""
        results = []
        async with self.critical():
            for attr, value in values.items():
                write = Write(device=device_id, attr=attr, value=value, rule_id=None, revert_after=revert_after, source=source)
                results.append(await self._apply_write(write))
        return results

    async def group_set(
        self,
        group_id: str,
        values: dict[str, Any],
        *,
        revert_after: timedelta | None = None,
        source: str = "manual",
    ) -> list[dict[str, Any]]:
        """Fan a manual set out over every member of a group."""
        group = self.store.groups.get(group_id)
        if group is None:
            raise KeyError(group_id)
        results = []
        async with self.critical():
            for member in group.members:
                for attr, value in values.items():
                    write = Write(device=member, attr=attr, value=value, rule_id=None, revert_after=revert_after, source=source)
                    results.append(await self._apply_write(write))
        return results

    # ------------------------------------------------------------------ gateway

    async def publish(self, topic: str, payload: Any, *, retain: bool = False, rule_id: str | None = None) -> dict[str, Any]:
        outcome = await self.gateway.publish(topic, payload, retain=retain)
        self.metrics.inc("publishes_total")
        self.store.append_event({"type": "publish", "topic": topic, "payload": payload, "rule": rule_id, "retain": retain})
        return outcome

    async def on_mqtt_connected(self) -> None:
        self.metrics.inc("mqtt_connects_total")
        self.store.append_event({"type": "mqtt", "status": "connected"})
        try:
            await self.evaluator.resync(self.clock())
        except Exception:  # noqa: BLE001
            LOGGER.exception("resync after reconnect failed")

    def reload_config_if_changed(self) -> bool:
        if not self.store.reload_if_changed():
            return False
        self.evaluator.rebuild_index()
        self.scheduler.rearm()
        return True

    # ------------------------------------------------------------------- status

    def status(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "version": __version__,
            "dry_run": self.dry_run,
            "mqtt_enabled": bool(self.settings.mqtt.enabled),
            "mqtt_connected": bool(self.gateway.connected),
            "data_dir": str(self.settings.data_dir),
            "timezone": self.settings.tz,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "uptime_seconds": round((self.clock() - self.started_at).total_seconds(), 1) if self.started_at else 0,
            "devices": len(self.store.devices),
            "groups": len(self.store.groups),
            "rules": len(self.store.rules),
            "pending_timers": len(self.store.timers),
            "state_values": len(self.state),
            "config_version": self.store.version,
            "warnings": self.settings.warnings(),
        }

    def refresh_metrics(self) -> None:
        self.metrics.set("state_values", len(self.state))
        self.metrics.set("pending_timers", len(self.store.timers))
        self.metrics.set("mqtt_connected", 1 if self.gateway.connected else 0)
        self.metrics.set("config_version", self.store.version)
        self.metrics.set("uptime_seconds", round((self.clock() - self.started_at).total_seconds(), 1) if self.started_at else 0)
