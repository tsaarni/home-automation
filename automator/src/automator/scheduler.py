"""Time, solar and interval wakeups, plus firing of pending timers.

All wall-clock reads go through service.clock(), so tests can drive the whole
schedule with a fake clock by calling Scheduler.tick() directly.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, time, timedelta
from typing import Any

from astral import Observer
from astral.sun import sun

from .models import DAYS, SOLAR_EVENTS, Rule, When
from .util import DurationError, parse_duration

LOGGER = logging.getLogger(__name__)
SEARCH_DAYS = 9


class Scheduler:
    """Decides when time/interval rules are due and fires pending timers."""

    def __init__(self, service: Any) -> None:
        self.service = service
        self.log = LOGGER
        self._next: dict[str, datetime | None] = {}
        self._solar_cache: dict[tuple[str, date], datetime | None] = {}
        self._observer: Observer | None = None
        settings = service.settings
        if settings.solar_available:
            try:
                self._observer = Observer(
                    latitude=float(settings.latitude),
                    longitude=float(settings.longitude),
                    elevation=float(settings.elevation),
                )
            except Exception as exc:  # noqa: BLE001
                self.log.warning("solar triggers disabled: %s", exc)
                self._observer = None

    # ------------------------------------------------------------------ lifecycle

    def boot(self, now: datetime) -> None:
        """Arm every schedule; catch up on firings missed while the service was down."""
        self._next.clear()
        for rule in self.service.store.rules.values():
            self._arm(rule, now, boot=True)

    def rearm(self) -> None:
        """After a config change: keep existing schedules, arm new ones, forget deleted ones."""
        self._sync(self.service.clock())

    async def tick(self, now: datetime) -> None:
        """One scheduler round: reload config, fire timers, fire due schedules."""
        if self.service.reload_config_if_changed():
            self.log.info("config.json reloaded from disk")
        async with self.service.critical():
            self.service.commands.expire()
        self._sync(now)
        for timer in self.service.store.due_timers(now):
            try:
                await self.service.evaluator.on_timer(timer, now)
            except Exception:  # noqa: BLE001
                self.log.exception("timer %s failed", timer.get("id"))
        for rule in list(self.service.store.rules.values()):
            if rule.when.kind not in ("at", "every") or not rule.enabled:
                continue
            due = self._next.get(rule.id)
            if due is None:
                self._next[rule.id] = self.next_due(rule, now)
                continue
            if now >= due:
                self._next[rule.id] = self.next_due(rule, now)
                self.service.store.set_last_fired(rule.id, now)
                self.log.debug("rule %s scheduled trigger at %s", rule.id, now.isoformat())
                try:
                    await self.service.evaluator.on_time_trigger(rule, now)
                except Exception:  # noqa: BLE001
                    self.log.exception("rule %s failed on schedule", rule.id)

    async def run_forever(self) -> None:
        while True:
            try:
                await asyncio.sleep(self.service.settings.scheduler_tick)
                await self.tick(self.service.clock())
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                self.log.exception("scheduler tick failed")

    # ------------------------------------------------------------------- schedules

    def _sync(self, now: datetime) -> None:
        """Drop stale entries and arm schedules that are new or were just enabled."""
        for rule_id in list(self._next):
            rule = self.service.store.rules.get(rule_id)
            if rule is None or rule.when.kind not in ("at", "every") or not rule.enabled:
                del self._next[rule_id]
        for rule in self.service.store.rules.values():
            if rule.when.kind in ("at", "every") and rule.enabled and rule.id not in self._next:
                self._arm(rule, now, boot=False)

    def _arm(self, rule: Rule, now: datetime, *, boot: bool) -> None:
        when = rule.when
        if when.kind == "every":
            self._next[rule.id] = now + parse_duration(when.every)
            return
        if boot:
            last = self.service.store.get_last_fired(rule.id)
            previous = self.previous_occurrence(when, now)
            if last is not None and previous is not None and previous > last:
                late = (now - previous).total_seconds()
                if late <= self.service.settings.catch_up_max_seconds:
                    self.log.info("rule %s missed its %s trigger, catching up (%.0fs late)", rule.id, previous.isoformat(), late)
                    self.service.store.append_event(
                        {"type": "schedule", "action": "catch_up", "rule": rule.id, "missed_at": previous.isoformat(), "late_seconds": late}
                    )
                    self._next[rule.id] = now
                    return
        self._next[rule.id] = self.next_occurrence(when, now)

    def next_due(self, rule: Rule, now: datetime) -> datetime | None:
        when = rule.when
        if when.kind == "every":
            return now + parse_duration(when.every)
        return self.next_occurrence(when, now)

    def next_occurrence(self, when: When, after: datetime) -> datetime | None:
        """First occurrence strictly after *after*, or None (polar night, empty window)."""
        for offset in range(SEARCH_DAYS):
            local = after.astimezone(self.service.settings.tzinfo) + timedelta(days=offset)
            if not self._day_matches(when, local.date()):
                continue
            candidate = self.occurrence(when, local.date())
            if candidate is not None and candidate > after:
                return candidate
        return None

    def previous_occurrence(self, when: When, before: datetime) -> datetime | None:
        """Latest occurrence at or before *before*."""
        for offset in range(SEARCH_DAYS):
            local = before.astimezone(self.service.settings.tzinfo) - timedelta(days=offset)
            if not self._day_matches(when, local.date()):
                continue
            candidate = self.occurrence(when, local.date())
            if candidate is not None and candidate <= before:
                return candidate
        return None

    def occurrence(self, when: When, day: date) -> datetime | None:
        """The trigger instant of *when* on a local calendar day."""
        if when.at is None:
            return None
        if when.at in SOLAR_EVENTS:
            base = self._solar(when.at, day)
            if base is None:
                return None
        else:
            hour, minute = (int(part) for part in when.at.split(":"))
            base = datetime.combine(day, time(hour=hour, minute=minute), tzinfo=self.service.settings.tzinfo)
        if when.offset:
            try:
                base = base + parse_duration(when.offset, allow_negative=True)
            except DurationError:
                return None
        return base

    @staticmethod
    def _day_matches(when: When, day: date) -> bool:
        if when.days is None:
            return True
        return DAYS[day.weekday()] in when.days

    def _solar(self, event: str, day: date) -> datetime | None:
        if self._observer is None:
            return None
        key = (event, day)
        if key in self._solar_cache:
            return self._solar_cache[key]
        value: datetime | None
        if event == "midnight":
            value = datetime.combine(day, time(0, 0), tzinfo=self.service.settings.tzinfo)
        else:
            try:
                value = sun(self._observer, date=day, tzinfo=self.service.settings.tzinfo, dawn_dusk_depression=6.0).get(event)
            except Exception as exc:  # noqa: BLE001 - astral raises for polar days
                self.log.debug("solar %s on %s unavailable: %s", event, day, exc)
                value = None
        if len(self._solar_cache) > 512:
            self._solar_cache.clear()
        self._solar_cache[key] = value
        return value

    def next_due_map(self) -> dict[str, str | None]:
        return {rule_id: (due.isoformat() if due else None) for rule_id, due in self._next.items()}
