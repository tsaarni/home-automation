"""JSON file store: config.json, pending.json and events.jsonl.

Cleartext and human readable, single writer (one replica). Writes are atomic
(temp file + os.replace) and rare: config.json only when a document changes,
pending.json only when a timer is armed/cancelled/fired, events.jsonl is append-only.
"""

from __future__ import annotations

import json
import logging
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable

from pydantic import ValidationError

from .models import Device, Group, Rule
from .util import (
    atomic_write_json,
    atomic_write_text,
    file_mtime_ns,
    from_iso,
    now_utc,
    to_iso,
)

LOGGER = logging.getLogger(__name__)

CONFIG_VERSION = 1
PENDING_VERSION = 1
CONFIG_SECTIONS: tuple[tuple[str, type], ...] = (("devices", Device), ("groups", Group), ("rules", Rule))


class ConfigError(ValueError):
    """config.json could not be read, parsed or validated."""


def _entries(section: Any, name: str, problems: list[str]) -> dict[str, Any]:
    if section is None:
        return {}
    if isinstance(section, dict):
        return section
    if isinstance(section, list):
        result: dict[str, Any] = {}
        for item in section:
            if not isinstance(item, dict) or "id" not in item:
                problems.append(f"{name}: list items must be objects with an id")
                continue
            result[str(item["id"])] = item
        return result
    problems.append(f"{name}: must be an object or a list")
    return {}


class Store:
    """Owns the three data files and the in-memory copy of them."""

    def __init__(
        self,
        data_dir: Path | str,
        *,
        clock: Callable[[], datetime] = now_utc,
        events_max_bytes: int = 2_000_000,
        events_memory: int = 1000,
        logger: logging.Logger | None = None,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.config_path = self.data_dir / "config.json"
        self.pending_path = self.data_dir / "pending.json"
        self.events_path = self.data_dir / "events.jsonl"
        self.clock = clock
        self.events_max_bytes = events_max_bytes
        self.events_memory = events_memory
        self.log = logger or LOGGER

        self.devices: dict[str, Device] = {}
        self.groups: dict[str, Group] = {}
        self.rules: dict[str, Rule] = {}
        self.timers: dict[str, dict[str, Any]] = {}
        self.last_fired: dict[str, str] = {}

        self.version = 0
        self._config_mtime_ns = 0
        self._events: deque[dict[str, Any]] = deque(maxlen=events_memory)
        self._events_bytes = 0

    # ------------------------------------------------------------------ loading

    def load(self) -> None:
        """Initial read of all three files (missing files are fine)."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._read_config()
        self._read_pending()
        self._load_events_tail()

    def reload_if_changed(self) -> bool:
        """Re-read config.json when its mtime changed, so hand edits and REST converge."""
        mtime = file_mtime_ns(self.config_path)
        if mtime == self._config_mtime_ns:
            return False
        try:
            self._read_config()
        except ConfigError as exc:
            self._config_mtime_ns = mtime
            self.log.error("config.json not reloaded: %s", exc)
            self.append_event({"type": "config", "action": "reload_error", "error": str(exc)})
            return False
        self.append_event({"type": "config", "action": "reload"})
        return True

    def _read_config(self) -> None:
        problems: list[str] = []
        raw: Any = {}
        if self.config_path.exists():
            try:
                raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ConfigError(f"cannot read {self.config_path.name}: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigError("config.json must contain an object")

        loaded: dict[str, dict[str, Any]] = {}
        for name, model in CONFIG_SECTIONS:
            documents: dict[str, Any] = {}
            for key, value in _entries(raw.get(name), name, problems).items():
                if not isinstance(value, dict):
                    problems.append(f"{name}.{key}: must be an object")
                    continue
                payload = dict(value)
                payload.setdefault("id", key)
                try:
                    document = model.model_validate(payload)
                except ValidationError as exc:
                    detail = exc.errors()[0]
                    where = ".".join(str(part) for part in detail.get("loc", ()))
                    problems.append(f"{name}.{key}: {detail.get('msg')} ({where})")
                    continue
                if document.id != key:
                    problems.append(f"{name}.{key}: id field is '{document.id}'")
                    continue
                documents[document.id] = document
            loaded[name] = documents

        if problems:
            raise ConfigError("; ".join(problems[:10]))

        self.devices = loaded["devices"]
        self.groups = loaded["groups"]
        self.rules = loaded["rules"]
        self._config_mtime_ns = file_mtime_ns(self.config_path)
        self.version += 1

    def _read_pending(self) -> None:
        raw: Any = {}
        if self.pending_path.exists():
            try:
                raw = json.loads(self.pending_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                self.log.error("pending.json ignored: %s", exc)
                return
        if not isinstance(raw, dict):
            self.log.error("pending.json ignored: not an object")
            return
        timers = raw.get("timers") or {}
        last_fired = raw.get("last_fired") or {}
        self.timers = {str(key): dict(value) for key, value in timers.items() if isinstance(value, dict)}
        self.last_fired = {str(key): str(value) for key, value in last_fired.items()}

    def _save_pending(self) -> None:
        payload = {"version": PENDING_VERSION, "timers": self.timers, "last_fired": self.last_fired}
        atomic_write_json(self.pending_path, payload)

    def config_document(self) -> dict[str, Any]:
        """The whole model, in the same shape as config.json."""
        return {
            "version": CONFIG_VERSION,
            "devices": {key: value.doc() for key, value in sorted(self.devices.items())},
            "groups": {key: value.doc() for key, value in sorted(self.groups.items())},
            "rules": {key: value.doc() for key, value in sorted(self.rules.items())},
        }

    def _save_config(self, event: dict[str, Any] | None = None) -> None:
        atomic_write_json(self.config_path, self.config_document())
        self._config_mtime_ns = file_mtime_ns(self.config_path)
        self.version += 1
        if event is not None:
            self.append_event(event)

    # ---------------------------------------------------------------- documents

    def put_device(self, device: Device) -> Device:
        self.devices[device.id] = device
        self._save_config({"type": "config", "action": "put", "kind": "device", "id": device.id})
        return device

    def delete_device(self, device_id: str) -> Device | None:
        removed = self.devices.pop(device_id, None)
        if removed is not None:
            self._save_config({"type": "config", "action": "delete", "kind": "device", "id": device_id})
        return removed

    def put_group(self, group: Group) -> Group:
        self.groups[group.id] = group
        self._save_config({"type": "config", "action": "put", "kind": "group", "id": group.id})
        return group

    def delete_group(self, group_id: str) -> Group | None:
        removed = self.groups.pop(group_id, None)
        if removed is not None:
            self._save_config({"type": "config", "action": "delete", "kind": "group", "id": group_id})
        return removed

    def put_rule(self, rule: Rule) -> Rule:
        self.rules[rule.id] = rule
        self._save_config({"type": "config", "action": "put", "kind": "rule", "id": rule.id})
        return rule

    def delete_rule(self, rule_id: str) -> Rule | None:
        removed = self.rules.pop(rule_id, None)
        if removed is not None:
            self._save_config({"type": "config", "action": "delete", "kind": "rule", "id": rule_id})
        return removed

    def set_rule_enabled(self, rule_id: str, enabled: bool) -> Rule | None:
        rule = self.rules.get(rule_id)
        if rule is None:
            return None
        if rule.enabled != enabled:
            updated = rule.model_copy(update={"enabled": enabled})
            self.put_rule(updated)
        return self.rules.get(rule_id)

    # ------------------------------------------------------------------- timers

    def put_timer(self, record: dict[str, Any]) -> dict[str, Any]:
        """Upsert a timer; due_at may be a datetime or an ISO string."""
        stored = dict(record)
        due = stored.get("due_at")
        if isinstance(due, datetime):
            stored["due_at"] = to_iso(due)
        self.timers[str(stored["id"])] = stored
        self._save_pending()
        return stored

    def get_timer(self, timer_id: str) -> dict[str, Any] | None:
        return self.timers.get(timer_id)

    def delete_timer(self, timer_id: str) -> dict[str, Any] | None:
        removed = self.timers.pop(timer_id, None)
        if removed is not None:
            self._save_pending()
        return removed

    def delete_timers(self, predicate: Callable[[dict[str, Any]], bool]) -> list[dict[str, Any]]:
        removed = [timer for timer in self.timers.values() if predicate(timer)]
        if removed:
            for timer in removed:
                self.timers.pop(str(timer["id"]), None)
            self._save_pending()
        return removed

    def list_timers(self, kind: str | None = None) -> list[dict[str, Any]]:
        timers = [timer for timer in self.timers.values() if kind is None or timer.get("kind") == kind]
        return sorted(timers, key=lambda timer: str(timer.get("due_at", "")))

    def due_timers(self, now: datetime, kind: str | None = None) -> list[dict[str, Any]]:
        due = []
        for timer in self.list_timers(kind):
            try:
                when = from_iso(str(timer.get("due_at")))
            except (TypeError, ValueError):
                self.log.error("timer %s has no usable due_at, dropping", timer.get("id"))
                self.timers.pop(str(timer.get("id")), None)
                continue
            if when <= now:
                due.append(timer)
        return due

    def set_last_fired(self, rule_id: str, when: datetime) -> None:
        self.last_fired[rule_id] = to_iso(when)
        self._save_pending()

    def get_last_fired(self, rule_id: str) -> datetime | None:
        raw = self.last_fired.get(rule_id)
        if raw is None:
            return None
        try:
            return from_iso(raw)
        except ValueError:
            return None

    # ------------------------------------------------------------------- events

    def append_event(self, event: dict[str, Any]) -> dict[str, Any]:
        record: dict[str, Any] = {"ts": to_iso(self.clock())}
        record.update(event)
        self._events.append(record)
        line = json.dumps(record, default=str) + "\n"
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            with self.events_path.open("a", encoding="utf-8") as handle:
                handle.write(line)
            self._events_bytes += len(line.encode("utf-8"))
            if self._events_bytes > self.events_max_bytes:
                self._trim_events()
        except OSError as exc:
            self.log.error("cannot append event: %s", exc)
        return record

    def _trim_events(self) -> None:
        """Keep the newest half of an oversized events.jsonl."""
        try:
            lines = self.events_path.read_text(encoding="utf-8", errors="replace").splitlines()
            keep = lines[len(lines) // 2 :]
            atomic_write_text(self.events_path, "".join(line + "\n" for line in keep))
            self._events_bytes = sum(len(line.encode("utf-8")) + 1 for line in keep)
            self.log.info("trimmed events.jsonl to %d lines (%d bytes)", len(keep), self._events_bytes)
        except OSError as exc:
            self.log.error("cannot trim events.jsonl: %s", exc)

    def _load_events_tail(self) -> None:
        self._events_bytes = 0
        if not self.events_path.exists():
            return
        try:
            self._events_bytes = self.events_path.stat().st_size
            lines = self.events_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines[-self.events_memory :]:
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                self._events.append(parsed)

    def read_events(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        rule: str | None = None,
        kind: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Newest-last slice of the audit log (falls back to the in-memory tail)."""
        records: list[dict[str, Any]] = []
        if self.events_path.exists():
            try:
                lines = self.events_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                lines = []
            for line in lines:
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    records.append(parsed)
        else:
            records = list(self._events)

        result = []
        for record in records:
            if kind is not None and record.get("type") != kind:
                continue
            if rule is not None and rule not in _event_rules(record):
                continue
            if since is not None or until is not None:
                try:
                    ts = from_iso(str(record.get("ts")))
                except (TypeError, ValueError):
                    continue
                if since is not None and ts < since:
                    continue
                if until is not None and ts > until:
                    continue
            result.append(record)
        if limit > 0:
            result = result[-limit:]
        return result

    @property
    def events_count(self) -> int:
        return len(self._events)


def _event_rules(record: dict[str, Any]) -> Iterable[str]:
    names: list[str] = []
    if isinstance(record.get("rule"), str):
        names.append(record["rule"])
    rules = record.get("rules")
    if isinstance(rules, list):
        names.extend(str(item) for item in rules)
    return names
