"""Rule evaluation: when / if / for / then.

The only entry points are a value change (MQTT read, manual set, action write, all of
which funnel through Service.apply_state), a scheduler wakeup for time/interval
triggers, and a pending timer firing. Writes collected during one evaluation are
applied together, after all rules of that tick were evaluated, in priority order.
"""

from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterator

from .models import (
    Condition,
    CurveAction,
    PublishAction,
    Rule,
    SetAction,
    Term,
    ValueRef,
    condition_refs,
    interpolate,
    render_payload,
)
from .state import UNSET, values_equal

LOGGER = logging.getLogger(__name__)


def compare(left: Any, op: str, right: Any) -> bool:
    """Apply one condition operator."""
    if op == "eq":
        return values_equal(left, right)
    if op == "ne":
        return not values_equal(left, right)
    left_number = float(left)
    right_number = float(right)
    if op == "gt":
        return left_number > right_number
    if op == "ge":
        return left_number >= right_number
    if op == "lt":
        return left_number < right_number
    if op == "le":
        return left_number <= right_number
    raise ValueError(f"unknown operator {op!r}")


@dataclass
class Trigger:
    """Why a rule is being evaluated."""

    kind: str
    device: str | None = None
    attr: str | None = None
    value: Any = None
    ts: datetime | None = None
    changed: bool = False

    def as_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"kind": self.kind}
        if self.device is not None:
            data["device"] = self.device
        if self.attr is not None:
            data["attr"] = self.attr
        if self.value is not None and self.value is not UNSET:
            data["value"] = self.value
        if self.kind in ("state", "resync"):
            data["changed"] = self.changed
        return data


@dataclass
class Write:
    """One value to write, produced by a rule (or a manual set)."""

    device: str
    attr: str
    value: Any
    rule_id: str | None = None
    revert_after: timedelta | None = None
    source: str = "rule"
    is_revert: bool = False

    @property
    def key(self) -> tuple[str, str]:
        return (self.device, self.attr)


class Evaluator:
    """when / if / for / then, plus the (device, attr) -> rules index."""

    def __init__(self, service: Any) -> None:
        self.service = service
        self.log = LOGGER
        self._trigger_index: dict[tuple[str, str], set[str]] = {}
        self._condition_index: dict[tuple[str, str], set[str]] = {}
        self._index_version = -1
        self._last_write: dict[str, datetime] = {}
        self._tick_writes: dict[tuple[str, str], Write] | None = None
        self._tick_publishes: list[tuple[Rule, PublishAction, Any]] | None = None
        self._tick_fired: list[Rule] | None = None
        self._quiet = False

    # ------------------------------------------------------------- small helpers

    @property
    def store(self) -> Any:
        return self.service.store

    @property
    def state(self) -> Any:
        return self.service.state

    @property
    def settings(self) -> Any:
        return self.service.settings

    @property
    def clock(self) -> Any:
        return self.service.clock

    def _event(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._quiet:
            return payload
        return self.store.append_event(payload)

    def _count(self, name: str, rule: Rule | None = None, amount: int = 1) -> None:
        if self._quiet:
            return
        self.service.metrics.inc(name, {"rule": rule.id} if rule is not None else None, amount)

    # ------------------------------------------------------------------ the index

    def rebuild_index(self) -> None:
        """Recompute the (device, attr) -> rules index from the current rules."""
        triggers: dict[tuple[str, str], set[str]] = {}
        conditions: dict[tuple[str, str], set[str]] = {}
        for rule in self.store.rules.values():
            for target in rule.trigger_targets():
                triggers.setdefault(target, set()).add(rule.id)
            for ref in condition_refs(rule.if_):
                conditions.setdefault(ref, set()).add(rule.id)
        self._trigger_index = triggers
        self._condition_index = conditions
        self._index_version = self.store.version

    def _ensure_index(self) -> None:
        if self._index_version != self.store.version:
            self.rebuild_index()

    @staticmethod
    def _sorted_rules(index: dict[tuple[str, str], set[str]], rules: dict[str, Rule], device: str, attr: str) -> list[Rule]:
        found = [rules[rule_id] for rule_id in index.get((device, attr), ()) if rule_id in rules]
        found.sort(key=lambda rule: (-rule.priority, rule.id))
        return found

    def rules_for(self, device: str, attr: str) -> list[Rule]:
        """Rules whose trigger is this attribute, highest priority first."""
        self._ensure_index()
        return self._sorted_rules(self._trigger_index, self.store.rules, device, attr)

    def condition_rules(self, device: str, attr: str) -> list[Rule]:
        """Rules whose if-condition reads this attribute."""
        self._ensure_index()
        return self._sorted_rules(self._condition_index, self.store.rules, device, attr)

    # ------------------------------------------------------------- conditions

    def evaluate_term(self, term: Term) -> tuple[bool, list[str]]:
        """(result, unknown refs); an unknown value on either side makes the term false."""
        device, attr = term.attr
        missing: list[str] = []
        left = self.state.value(device, attr, UNSET)
        if left is UNSET:
            missing.append(f"{device}.{attr}")
        if isinstance(term.value, ValueRef):
            right = self.state.value(term.value.device, term.value.attr, UNSET)
            if right is UNSET:
                missing.append(f"{term.value.device}.{term.value.attr}")
        else:
            right = term.value
        if missing:
            return False, missing
        try:
            return compare(left, term.op, right), []
        except (TypeError, ValueError):
            return False, []

    def evaluate_condition(self, condition: Condition | None) -> tuple[bool, list[str]]:
        """(satisfied, unknown refs); an unknown value makes its term false."""
        if condition is None:
            return True, []
        results: list[bool] = []
        unknown: list[str] = []
        for term in condition.terms():
            ok, missing = self.evaluate_term(term)
            unknown.extend(missing)
            results.append(ok)
        if condition.all is not None:
            return all(results), unknown
        return any(results), unknown

    def condition_details(self, condition: Condition | None) -> list[dict[str, Any]]:
        if condition is None:
            return []
        details = []
        for term in condition.terms():
            device, attr = term.attr
            left = self.state.value(device, attr, UNSET)
            if isinstance(term.value, ValueRef):
                right: Any = self.state.value(term.value.device, term.value.attr, UNSET)
                right_desc: Any = {"device": term.value.device, "attr": term.value.attr, "value": None if right is UNSET else right}
            else:
                right = term.value
                right_desc = term.value
            ok, missing = self.evaluate_term(term)
            details.append(
                {
                    "attr": [device, attr],
                    "op": term.op,
                    "left": None if left is UNSET else left,
                    "right": right_desc,
                    "result": ok,
                    "unknown": missing or None,
                }
            )
        return details

    # --------------------------------------------------------------- triggers

    async def on_state_change(
        self,
        device: str,
        attr: str,
        value: Any,
        previous: Any,
        ts: datetime,
        changed: bool,
        source: str = "mqtt",
    ) -> None:
        if self.service.depth > self.settings.max_rule_depth:
            self._event({"type": "rule_depth_limit", "device": device, "attr": attr, "depth": self.service.depth})
            return
        rules = self.rules_for(device, attr)
        ctx = Trigger("state", device, attr, value, ts, changed)
        async with self._tick():
            for rule in rules:
                if not rule.enabled:
                    continue
                if rule.when.changed and not changed:
                    continue
                await self._handle(rule, ctx)
            await self._recheck_for_timers(device, attr)

    async def on_time_trigger(self, rule: Rule, ts: datetime) -> None:
        if self.service.depth > self.settings.max_rule_depth:
            self._event({"type": "rule_depth_limit", "rule": rule.id, "depth": self.service.depth})
            return
        kind = "at" if rule.when.at is not None else "every"
        async with self._tick():
            await self._handle(rule, Trigger(kind, ts=ts))

    async def resync(self, ts: datetime | None = None) -> None:
        """Re-evaluate state triggers after boot or a reconnect so if-rules catch up."""
        ts = ts or self.clock()
        if self.service.depth > self.settings.max_rule_depth:
            return
        async with self._tick():
            for rule in sorted(self.store.rules.values(), key=lambda item: (-item.priority, item.id)):
                if not rule.enabled or rule.when.kind != "state":
                    continue
                if rule.when.device is None or rule.when.attr is None:
                    continue
                value = self.state.value(rule.when.device, rule.when.attr, UNSET)
                if value is UNSET:
                    continue
                await self._handle(rule, Trigger("resync", rule.when.device, rule.when.attr, value, ts, changed=True))

    async def on_timer(self, timer: dict[str, Any], ts: datetime) -> None:
        kind = timer.get("kind")
        if kind == "for":
            await self._fire_for_timer(timer, ts)
        elif kind == "revert":
            await self._fire_revert(timer, ts)
        else:
            self.store.delete_timer(str(timer.get("id")))
            self._event({"type": "timer", "status": "dropped", "timer": timer.get("id"), "reason": "unknown_kind"})

    # ------------------------------------------------------------------ ticks

    @contextlib.asynccontextmanager
    async def _tick(self) -> Iterator[None]:
        """Collect writes of one evaluation round and apply them together."""
        if self._tick_writes is not None:
            yield
            return
        self._tick_writes = {}
        self._tick_publishes = []
        self._tick_fired = []
        try:
            yield
        finally:
            writes = self._tick_writes
            publishes = self._tick_publishes
            fired = self._tick_fired
            self._tick_writes = None
            self._tick_publishes = None
            self._tick_fired = None
            await self._flush(writes or {}, publishes or [], fired or [])

    async def _flush(
        self,
        writes: dict[tuple[str, str], Write],
        publishes: list[tuple[Rule, PublishAction, Any]],
        fired: list[Rule],
    ) -> None:
        for rule, action, value in publishes:
            try:
                payload = render_payload(action.payload, value)
                await self.service.publish(action.topic, payload, retain=action.retain, rule_id=rule.id)
            except Exception as exc:  # noqa: BLE001 - a broken action must not stop the tick
                self._rule_error(rule, "publish", exc, None)
        applied: set[tuple[str, str]] = set()
        while True:
            pending = [(key, write) for key, write in writes.items() if key not in applied]
            if not pending:
                break
            key, write = pending[0]
            device = self.service.store.devices.get(write.device)
            batch = [(key, write)]
            if device and device.command:
                # Only combine winners from this evaluation with compatible timer semantics.
                batch = [(k, w) for k, w in pending if w.device == write.device and w.revert_after == write.revert_after]
            applied.update(k for k, _ in batch)
            try:
                if device and device.command:
                    async with self.service.critical():
                        await self.service.commands.apply([w for _, w in batch])
                else:
                    await self.service.apply_write(write)  # the service records the outcome event
            except Exception as exc:  # noqa: BLE001
                self.log.warning("write to %s.%s failed: %s", write.device, write.attr, exc)
                self._event({"type": "write", "device": write.device, "attr": write.attr, "value": write.value, "rule": write.rule_id, "status": "error", "reason": str(exc)})
        for rule in fired:
            self._consume_once(rule)

    def _note_fired(self, rule: Rule) -> None:
        """Remember that a trigger of this rule was resolved (for one-shot rules)."""
        if rule.once and self._tick_fired is not None:
            self._tick_fired.append(rule)

    def _consume_once(self, rule: Rule) -> None:
        if not rule.once:
            return
        if self.store.delete_rule(rule.id) is not None:
            self._event({"type": "rule_once", "action": "consumed", "rule": rule.id})
            self.service.metrics.inc("rule_once_total", {"rule": rule.id})

    def _rate_limited(self, rule: Rule, ts: datetime) -> bool:
        if rule.rate_limit <= 0:
            return False
        last = self._last_write.get(rule.id)
        if last is None:
            return False
        return (ts - last).total_seconds() < rule.rate_limit

    # -------------------------------------------------------------- rule handling

    async def _handle(self, rule: Rule, ctx: Trigger, *, deferrable: bool = True) -> None:
        try:
            if deferrable and rule.for_ is not None:
                self._arm_for_timer(rule, ctx)
                return
            satisfied, unknown = self.evaluate_condition(rule.if_)
            self._note_fired(rule)
            if not satisfied:
                self._event(
                    {
                        "type": "rule_skip",
                        "rule": rule.id,
                        "trigger": ctx.as_dict(),
                        "reason": "condition_false",
                        "unknown": unknown,
                    }
                )
                self._count("rule_condition_false_total", rule)
                return
            await self._plan_and_record(rule, ctx)
        except Exception as exc:  # noqa: BLE001 - one broken rule must not stop a tick
            self._rule_error(rule, None, exc, ctx)

    def _arm_for_timer(self, rule: Rule, ctx: Trigger) -> None:
        timer_id = f"for:{rule.id}"
        existing = self.store.get_timer(timer_id)
        if existing is not None and ctx.kind == "resync":
            return
        satisfied, _unknown = self.evaluate_condition(rule.if_)
        if not satisfied:
            if existing is not None:
                self.store.delete_timer(timer_id)
                self._event({"type": "timer", "status": "cancelled", "kind": "for", "rule": rule.id, "reason": "condition_false"})
                self._note_fired(rule)
            return
        due = (ctx.ts or self.clock()) + (rule.for_ or timedelta(0))
        self.store.put_timer(
            {
                "id": timer_id,
                "kind": "for",
                "rule": rule.id,
                "device": ctx.device,
                "attr": ctx.attr,
                "value": ctx.value,
                "trigger": ctx.as_dict(),
                "created_at": self.clock(),
                "due_at": due,
            }
        )
        self._event({"type": "timer", "status": "armed", "kind": "for", "rule": rule.id, "due_at": due.isoformat(), "trigger": ctx.as_dict()})

    async def _recheck_for_timers(self, device: str, attr: str) -> None:
        pending = self.store.list_timers("for")
        if not pending:
            return
        self._ensure_index()
        related = self._condition_index.get((device, attr))
        if not related:
            return
        for timer in pending:
            rule_id = str(timer.get("rule"))
            if rule_id not in related:
                continue
            rule = self.store.rules.get(rule_id)
            if rule is None:
                self.store.delete_timer(str(timer["id"]))
                continue
            satisfied, _unknown = self.evaluate_condition(rule.if_)
            if satisfied:
                continue
            self.store.delete_timer(str(timer["id"]))
            self._event({"type": "timer", "status": "cancelled", "kind": "for", "rule": rule_id, "reason": "condition_false"})
            self._note_fired(rule)

    async def _fire_for_timer(self, timer: dict[str, Any], ts: datetime) -> None:
        timer_id = str(timer.get("id"))
        rule_id = str(timer.get("rule"))
        rule = self.store.rules.get(rule_id)
        self.store.delete_timer(timer_id)
        if rule is None:
            self._event({"type": "timer", "status": "dropped", "kind": "for", "rule": rule_id, "reason": "rule_gone"})
            return
        if not rule.enabled:
            self._event({"type": "timer", "status": "dropped", "kind": "for", "rule": rule_id, "reason": "rule_disabled"})
            return
        ctx = Trigger("timer", timer.get("device"), timer.get("attr"), timer.get("value"), ts, changed=True)
        async with self._tick():
            satisfied, unknown = self.evaluate_condition(rule.if_)
            self._note_fired(rule)
            if not satisfied:
                self._event({"type": "rule_skip", "rule": rule.id, "trigger": ctx.as_dict(), "reason": "condition_false", "unknown": unknown})
                return
            self._event({"type": "timer", "status": "fired", "kind": "for", "rule": rule.id, "due_at": timer.get("due_at")})
            await self._plan_and_record(rule, ctx)

    async def _fire_revert(self, timer: dict[str, Any], ts: datetime) -> None:
        timer_id = str(timer.get("id"))
        device_id = str(timer.get("device"))
        attr = str(timer.get("attr"))
        rule_id = timer.get("rule")
        self.store.delete_timer(timer_id)
        device = self.store.devices.get(device_id)
        attribute = device.attributes.get(attr) if device else None
        if attribute is None:
            self._event({"type": "timer", "status": "dropped", "kind": "revert", "rule": rule_id, "reason": "target_gone"})
            return
        if timer.get("has_value"):
            value = timer.get("value")
        else:
            value = attribute.default
        if value is None:
            self._event({"type": "timer", "status": "dropped", "kind": "revert", "rule": rule_id, "reason": "no_value_to_restore"})
            return
        self._event({"type": "timer", "status": "fired", "kind": "revert", "rule": rule_id, "device": device_id, "attr": attr})
        write = Write(device_id, attr, value, rule_id=rule_id, source=f"revert:{rule_id}", is_revert=True)
        try:
            await self.service.apply_write(write)
        except Exception as exc:  # noqa: BLE001
            self._rule_error(rule_id, "revert", exc, None)

    # ------------------------------------------------------------------ planning

    def _targets(self, device_id: str | None, group_id: str | None, rule: Rule) -> list[str]:
        if device_id is not None:
            return [device_id]
        if group_id is None:
            return []
        group = self.store.groups.get(group_id)
        if group is None:
            self._event({"type": "rule_error", "rule": rule.id, "error": f"unknown group {group_id!r}"})
            return []
        return list(group.members)

    def _plan_set(self, rule: Rule, action: SetAction, writes: dict[tuple[str, str], Write]) -> None:
        for device_id in self._targets(action.device, action.group, rule):
            device = self.store.devices.get(device_id)
            attribute = device.attributes.get(action.attr) if device else None
            if attribute is None:
                self._event({"type": "rule_error", "rule": rule.id, "error": f"device {device_id!r} has no attribute {action.attr!r}"})
                continue
            value = action.value
            if isinstance(value, ValueRef):
                ref = f"{value.device}.{value.attr}"
                value = self.state.value(value.device, value.attr, UNSET)
                if value is UNSET:
                    self._event({"type": "rule_skip", "rule": rule.id, "reason": "unknown_value", "value_from": ref})
                    continue
            try:
                value = attribute.coerce(value, for_write=True)
            except ValueError as exc:
                self._event({"type": "rule_error", "rule": rule.id, "error": f"{device_id}.{action.attr}: {exc}"})
                continue
            writes[(device_id, action.attr)] = Write(
                device=device_id,
                attr=action.attr,
                value=value,
                rule_id=rule.id,
                revert_after=action.revert_after,
                source=f"rule:{rule.id}",
            )

    def _plan_curve(self, rule: Rule, action: CurveAction, writes: dict[tuple[str, str], Write]) -> None:
        x = self.state.value(action.x.device, action.x.attr, UNSET)
        if x is UNSET or isinstance(x, bool) or not isinstance(x, (int, float)):
            self._event(
                {
                    "type": "rule_skip",
                    "rule": rule.id,
                    "reason": "no_curve_input",
                    "value_from": f"{action.x.device}.{action.x.attr}",
                }
            )
            return
        interpolated = interpolate([(float(point[0]), float(point[1])) for point in action.points], float(x))
        for device_id in self._targets(action.device, action.group, rule):
            device = self.store.devices.get(device_id)
            attribute = device.attributes.get(action.attr) if device else None
            if attribute is None:
                self._event({"type": "rule_error", "rule": rule.id, "error": f"device {device_id!r} has no attribute {action.attr!r}"})
                continue
            try:
                value = attribute.coerce(interpolated, for_write=True)
            except ValueError as exc:
                self._event({"type": "rule_error", "rule": rule.id, "error": f"{device_id}.{action.attr}: {exc}"})
                continue
            writes[(device_id, action.attr)] = Write(
                device=device_id,
                attr=action.attr,
                value=value,
                rule_id=rule.id,
                source=f"rule:{rule.id}",
            )

    def plan(self, rule: Rule, ctx: Trigger) -> tuple[dict[tuple[str, str], Write], list[tuple[Rule, PublishAction, Any]]]:
        """Turn a rule's actions into writes and publishes (no side effects)."""
        writes: dict[tuple[str, str], Write] = {}
        publishes: list[tuple[Rule, PublishAction, Any]] = []
        for index, action in enumerate(rule.then):
            try:
                if action.set is not None:
                    self._plan_set(rule, action.set, writes)
                elif action.set_curve is not None:
                    self._plan_curve(rule, action.set_curve, writes)
                elif action.publish is not None:
                    publishes.append((rule, action.publish, ctx.value))
            except Exception as exc:  # noqa: BLE001
                self._rule_error(rule, f"then[{index}]", exc, ctx)
        return writes, publishes

    async def _plan_and_record(self, rule: Rule, ctx: Trigger) -> None:
        writes, publishes = self.plan(rule, ctx)
        if not writes and not publishes:
            self._count("rule_fires_total", rule)
            self._event({"type": "rule_fire", "rule": rule.id, "trigger": ctx.as_dict(), "writes": 0, "publishes": 0})
            return
        now = ctx.ts or self.clock()
        if writes and self._rate_limited(rule, now):
            self._count("rule_rate_limited_total", rule)
            self._event({"type": "rule_skip", "rule": rule.id, "trigger": ctx.as_dict(), "reason": "rate_limited", "rate_limit": rule.rate_limit})
            return
        conflicts: list[dict[str, Any]] = []
        if self._tick_writes is None:
            raise RuntimeError("rule evaluation outside of a tick")
        for key, write in writes.items():
            existing = self._tick_writes.get(key)
            if existing is not None:
                conflicts.append({"device": key[0], "attr": key[1], "rules": sorted({existing.rule_id, write.rule_id}, key=lambda item: item or "")})
                self._count("rule_conflicts_total", rule)
                continue
            self._tick_writes[key] = write
        if self._tick_publishes is not None:
            self._tick_publishes.extend(publishes)
        self._last_write[rule.id] = now
        self._count("rule_fires_total", rule)
        if conflicts:
            for conflict in conflicts:
                self._event({"type": "conflict", **conflict})
        self._event(
            {
                "type": "rule_fire",
                "rule": rule.id,
                "trigger": ctx.as_dict(),
                "writes": len(writes),
                "publishes": len(publishes),
            }
        )

    # ------------------------------------------------------------------ dry run

    def dry_run_report(self, rule: Rule, ctx: Trigger) -> dict[str, Any]:
        """What this rule would do right now, without touching anything."""
        self._quiet = True
        try:
            satisfied, unknown = self.evaluate_condition(rule.if_)
            writes, publishes = self.plan(rule, ctx)
            now = ctx.ts or self.clock()
            report = {
                "rule": rule.id,
                "trigger": ctx.as_dict(),
                "condition": {"satisfied": satisfied, "unknown": unknown, "terms": self.condition_details(rule.if_)},
                "deferred_seconds": rule.for_.total_seconds() if rule.for_ is not None else 0,
                "rate_limited": self._rate_limited(rule, now),
                "writes": [self.service.resolve_write(write) for write in writes.values()],
                "publishes": [
                    {"topic": action.topic, "payload": render_payload(action.payload, value), "retain": action.retain}
                    for _rule, action, value in publishes
                ],
            }
        finally:
            self._quiet = False
        return report

    def _rule_error(self, rule: Rule | str | None, where: str | None, exc: Exception, ctx: Trigger | None) -> None:
        if isinstance(rule, Rule):
            rule_id: str | None = rule.id
        else:
            rule_id = rule
        message = f"{where}: {exc}" if where else str(exc)
        self.log.warning("rule %s error: %s", rule_id, message)
        self._event({"type": "rule_error", "rule": rule_id, "error": message, "trigger": ctx.as_dict() if ctx is not None else None})
        if isinstance(rule, Rule):
            self._count("rule_errors_total", rule)
