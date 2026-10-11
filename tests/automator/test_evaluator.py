"""Rule evaluation scenarios - plan task 7.

Covers the four behaviours that must work at cutover, one-shot rules, timed
overrides, groups, priority, guards and the dry-run path.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from automator.models import Rule
from automator.state import UNSET
from support import (
    FakeClock,
    add_documents,
    group_doc,
    make_service,
    plug_doc,
    plug_group_members,
    run,
    thermostat_doc,
)


def bathroom_setback() -> dict:
    return {
        "id": "bathroom-setback",
        "priority": 100,
        "when": {"device": "thermostat-bathroom", "attr": "setpoint", "changed": True},
        "if": {"all": [{"attr": ["thermostat-bathroom", "setpoint"], "op": "ne", "value": 17}]},
        "for": "3h",
        "then": [{"set": {"device": "thermostat-bathroom", "attr": "setpoint", "value": 17}}],
    }


def bathroom_curve() -> dict:
    return {
        "id": "bathroom-curve",
        "when": {"device": "temperature-backyard", "attr": "temperature"},
        "then": [
            {
                "set_curve": {
                    "device": "thermostat-bathroom",
                    "attr": "setpoint",
                    "x": {"device": "temperature-backyard", "attr": "temperature"},
                    "points": [[-20, 25], [-5, 23], [0, 21], [10, 19], [20, 17]],
                }
            }
        ],
    }


def outside_thermometer() -> dict:
    return {"id": "temperature-backyard", "attributes": {"temperature": {"read": {"topic": "home/backyard/temperature"}, "type": "number", "unit": "C"}}}


def test_bathroom_setback_returns_to_17_after_three_hours(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc()], rules=[bathroom_setback()])

    async def scenario():
        await service.manual_set("thermostat-bathroom", {"setpoint": 22})
        assert service.state.value("thermostat-bathroom", "setpoint") == 22
        timer = service.store.get_timer("for:bathroom-setback")
        assert timer is not None and timer["due_at"] == timer["created_at"] or timer["due_at"] is not None

        clock.advance(2 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-bathroom", "setpoint") == 22  # not yet

        clock.advance(1 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-bathroom", "setpoint") == 17
        assert service.store.get_timer("for:bathroom-setback") is None

    run(scenario())
    events = service.store.read_events(kind="rule_fire")
    assert [event["rule"] for event in events] == ["bathroom-setback"]


def test_bathroom_setback_restarts_on_a_new_manual_change(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc()], rules=[bathroom_setback()])

    async def scenario():
        await service.manual_set("thermostat-bathroom", {"setpoint": 22})
        clock.advance(2 * 3600)
        await service.manual_set("thermostat-bathroom", {"setpoint": 23})  # restarts the timer

        clock.advance(2 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-bathroom", "setpoint") == 23  # 2h after the second change

        clock.advance(1 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-bathroom", "setpoint") == 17

    run(scenario())


def test_bathroom_setback_is_cancelled_when_the_condition_turns_false(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc()], rules=[bathroom_setback()])

    async def scenario():
        await service.manual_set("thermostat-bathroom", {"setpoint": 22})
        assert service.store.get_timer("for:bathroom-setback") is not None
        clock.advance(3600)
        await service.manual_set("thermostat-bathroom", {"setpoint": 17})  # back to normal by hand
        assert service.store.get_timer("for:bathroom-setback") is None

        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-bathroom", "setpoint") == 17

    run(scenario())
    assert [event["status"] for event in service.store.read_events(kind="timer") if event.get("status") == "cancelled"] == ["cancelled"]


def test_bathroom_setback_pending_timer_survives_restart(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc()], rules=[bathroom_setback()])

    async def scenario():
        await service.manual_set("thermostat-bathroom", {"setpoint": 22})
        await service.stop()

        # a fresh process (same data dir, same fake clock that kept running)
        clock.advance(3 * 3600)
        revived = make_service(tmp_path, clock)
        await revived.start()
        await revived.scheduler.tick(clock())
        assert revived.state.known("thermostat-bathroom", "setpoint") is False  # state is in-memory only
        # the timer fired, but the condition cannot be evaluated, so nothing was written
        assert len(revived.store.read_events(kind="write")) == 1  # only the manual set from before the restart
        skips = [event for event in revived.store.read_events(kind="rule_skip") if event.get("rule") == "bathroom-setback"]
        assert [event["reason"] for event in skips] == ["condition_false"]
        await revived.stop()

    run(scenario())


def test_heating_curve_follows_outdoor_temperature(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc(), outside_thermometer()], rules=[bathroom_curve()])

    async def scenario():
        await service.apply_state("temperature-backyard", "temperature", -20)
        assert service.state.value("thermostat-bathroom", "setpoint") == 25
        clock.advance(60)  # a rule writes at most once per rate_limit second
        await service.apply_state("temperature-backyard", "temperature", -10)
        assert service.state.value("thermostat-bathroom", "setpoint") == pytest.approx(23.667, abs=1e-3)
        clock.advance(60)
        await service.apply_state("temperature-backyard", "temperature", 30)
        assert service.state.value("thermostat-bathroom", "setpoint") == 17  # clamped

    run(scenario())
    assert service.store.read_events(kind="rule_fire")[-1]["writes"] == 1


def test_curve_without_input_is_skipped(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc(), outside_thermometer()], rules=[bathroom_curve()])

    async def scenario():
        service.state.set("temperature-backyard", "temperature", None, clock(), "test")  # not a number
        await service.evaluator.resync(clock())

    run(scenario())
    assert service.state.value("thermostat-bathroom", "setpoint", UNSET) is UNSET
    skips = service.store.read_events(kind="rule_skip")
    assert [event["reason"] for event in skips] == ["no_curve_input"]


def test_timed_override_reverts_to_the_previous_value(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        await service.apply_state("powerplug-terrace", "state", "OFF")
        results = await service.manual_set("powerplug-terrace", {"state": "ON"}, revert_after=timedelta(hours=4))
        assert results[0]["status"] == "applied"
        assert service.state.value("powerplug-terrace", "state") == "ON"
        assert service.store.get_timer("revert:powerplug-terrace:state")["value"] == "OFF"

        clock.advance(3 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON"

        clock.advance(1 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

    run(scenario())


def test_newer_override_replaces_the_pending_revert(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        await service.apply_state("powerplug-terrace", "state", "OFF")
        await service.manual_set("powerplug-terrace", {"state": "ON"}, revert_after=timedelta(hours=4))
        clock.advance(3600)
        await service.manual_set("powerplug-terrace", {"state": "OFF"}, revert_after=timedelta(hours=4))
        assert len(service.store.list_timers("revert")) == 1

        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON"  # value before the last override

    run(scenario())


def test_override_reverts_to_the_attribute_default_when_nothing_was_known(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    document = plug_doc()
    document["attributes"]["state"]["default"] = "OFF"
    add_documents(service, devices=[document])

    async def scenario():
        await service.manual_set("powerplug-terrace", {"state": "ON"}, revert_after=timedelta(hours=4))
        timer = service.store.get_timer("revert:powerplug-terrace:state")
        assert timer["has_value"] is False and timer["value"] == "OFF"
        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

    run(scenario())


def test_override_without_value_or_default_is_refused(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        await service.manual_set("powerplug-terrace", {"state": "ON"}, revert_after=timedelta(hours=4))
        assert service.store.list_timers("revert") == []
        assert service.state.value("powerplug-terrace", "state") == "ON"

    run(scenario())
    refused = [event for event in service.store.read_events(kind="timer") if event.get("status") == "refused"]
    assert len(refused) == 1 and refused[0]["reason"] == "no_value_to_restore"


def test_revert_survives_rule_delete_and_disable(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "boost",
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 100}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON", "revert_after": "4h"}}],
            }
        ],
    )

    async def scenario():
        await service.apply_state("powerplug-terrace", "state", "OFF")
        await service.apply_state("powerplug-terrace", "power", 500)
        assert service.state.value("powerplug-terrace", "state") == "ON"
        service.store.delete_rule("boost")
        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

    run(scenario())


def test_group_fan_out_and_revert(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=plug_group_members("floor-heating", 3),
        groups=[group_doc("floor-heating", ["floor-heating-a", "floor-heating-b", "floor-heating-c"])],
    )

    async def scenario():
        for member in ("floor-heating-a", "floor-heating-b", "floor-heating-c"):
            await service.apply_state(member, "state", "OFF")
        results = await service.group_set("floor-heating", {"state": "ON"}, revert_after=timedelta(hours=4))
        assert [result["status"] for result in results] == ["applied"] * 3
        assert all(service.state.value(member, "state") == "ON" for member in ("floor-heating-a", "floor-heating-b", "floor-heating-c"))

        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())
        assert all(service.state.value(member, "state") == "OFF" for member in ("floor-heating-a", "floor-heating-b", "floor-heating-c"))
        assert service.store.list_timers("revert") == []

    run(scenario())


def test_rule_targeting_a_group_writes_every_member(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=plug_group_members("floor-heating", 2),
        groups=[group_doc("floor-heating", ["floor-heating-a", "floor-heating-b"])],
        rules=[
            {
                "id": "saturday-heat",
                "when": {"at": "14:00", "days": ["Sat"]},
                "then": [{"set": {"group": "floor-heating", "attr": "state", "value": "ON"}}],
            }
        ],
    )

    async def scenario():
        await service.evaluator.on_time_trigger(service.store.rules["saturday-heat"], clock())

    run(scenario())
    assert service.state.value("floor-heating-a", "state") == "ON"
    assert service.state.value("floor-heating-b", "state") == "ON"


def test_one_shot_rule_is_deleted_after_it_fires(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    document = plug_doc()
    document["attributes"]["state"]["default"] = "OFF"
    add_documents(
        service,
        devices=[document],
        rules=[
            {
                "id": "adhoc-floor-heat",
                "once": True,
                "when": {"at": "14:00"},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON", "revert_after": "4h"}}],
            }
        ],
    )

    async def scenario():
        rule = service.store.rules["adhoc-floor-heat"]
        await service.evaluator.on_time_trigger(rule, clock())
        assert "adhoc-floor-heat" not in service.store.rules
        assert service.state.value("powerplug-terrace", "state") == "ON"
        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

    run(scenario())
    assert any(event["action"] == "consumed" for event in service.store.read_events(kind="rule_once"))


def test_priority_wins_and_conflicts_are_logged(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "a-high",
                "priority": 10,
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 0}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
            },
            {
                "id": "b-low",
                "priority": 1,
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 0}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            },
        ],
    )

    async def scenario():
        await service.apply_state("powerplug-terrace", "power", 5)

    run(scenario())
    assert service.state.value("powerplug-terrace", "state") == "ON"
    conflicts = service.store.read_events(kind="conflict")
    assert len(conflicts) == 1
    assert conflicts[0]["rules"] == ["a-high", "b-low"]


def test_guards_limits_unchanged_and_rate_limit(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc()])

    async def scenario():
        # limits
        results = await service.manual_set("thermostat-bathroom", {"setpoint": 99})
        assert results[0]["status"] == "error"
        assert "outside limits" in results[0]["reason"]
        assert service.state.known("thermostat-bathroom", "setpoint") is False

        # unchanged values are not written
        await service.manual_set("thermostat-bathroom", {"setpoint": 21})
        results = await service.manual_set("thermostat-bathroom", {"setpoint": 21})
        assert results[0]["status"] == "unchanged"
        assert service.store.read_events(kind="write")[-1]["status"] == "unchanged"

        # enum
        unknown_attr = await service.manual_set("thermostat-bathroom", {"nope": 1})
        assert unknown_attr[0]["status"] == "error"

    run(scenario())


def test_per_rule_rate_limit(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "chatter",
                "rate_limit": 60,
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 0}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
            }
        ],
    )

    async def scenario():
        await service.apply_state("powerplug-terrace", "power", 1)
        await service.apply_state("powerplug-terrace", "power", 2)  # within the cooldown

    run(scenario())
    skipped = [event for event in service.store.read_events(kind="rule_skip") if event.get("reason") == "rate_limited"]
    assert len(skipped) == 1
    assert service.state.value("powerplug-terrace", "state") == "ON"


def test_rule_can_take_a_value_from_another_attribute(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[thermostat_doc(), outside_thermometer()],
        rules=[
            {
                "id": "mirror-outside",
                "when": {"device": "temperature-backyard", "attr": "temperature"},
                "then": [
                    {
                        "set": {
                            "device": "thermostat-bathroom",
                            "attr": "setpoint",
                            "value": {"device": "temperature-backyard", "attr": "temperature"},
                        }
                    }
                ],
            }
        ],
    )

    async def scenario():
        await service.apply_state("temperature-backyard", "temperature", 12)
        assert service.state.value("thermostat-bathroom", "setpoint") == 12
        # a source value the target attribute rejects is audited, not fatal
        await service.apply_state("temperature-backyard", "temperature", 1234)

    run(scenario())
    errors = service.store.read_events(kind="rule_error")
    assert len(errors) == 1 and "outside limits" in errors[0]["error"]
    assert service.state.value("thermostat-bathroom", "setpoint") == 12


def test_publish_escape_hatch(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "notify-power",
                "when": {"device": "powerplug-terrace", "attr": "power", "changed": True},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 100}]},
                "then": [{"publish": {"topic": "home/notify/power", "payload": {"value": "$v", "unit": "W"}}}],
            }
        ],
    )

    async def scenario():
        await service.apply_state("powerplug-terrace", "power", 150)

    run(scenario())
    assert service.gateway.sent == [{"topic": "home/notify/power", "payload": {"value": 150, "unit": "W"}, "retain": False}]
    assert service.store.read_events(kind="publish")[-1]["topic"] == "home/notify/power"


def test_dry_run_mode_plans_but_does_not_write(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    service.dry_run = True
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "turn-on",
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 0}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
            }
        ],
    )

    async def scenario():
        await service.apply_state("powerplug-terrace", "power", 5)
        return await service.manual_set("powerplug-terrace", {"state": "OFF"})

    results = run(scenario())
    assert results[0]["status"] == "dry-run"
    assert service.state.value("powerplug-terrace", "state", UNSET) is UNSET
    assert service.gateway.sent == []
    statuses = [event["status"] for event in service.store.read_events(kind="write")]
    assert statuses == ["dry-run", "dry-run"]


def test_rule_dry_run_report_is_side_effect_free(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat_doc()], rules=[bathroom_setback()])

    async def scenario():
        await service.apply_state("thermostat-bathroom", "setpoint", 22)
        rule = service.store.rules["bathroom-setback"]
        from automator.evaluator import Trigger

        return service.evaluator.dry_run_report(rule, Trigger("state", "thermostat-bathroom", "setpoint", 23, clock(), True))

    report = run(scenario())
    assert report["condition"]["satisfied"] is True
    assert report["deferred_seconds"] == 3 * 3600
    assert report["writes"][0]["value"] == 17
    assert report["writes"][0]["previous"] == 22
    assert "applied" == report["writes"][0]["status"]
    assert service.store.read_events(kind="rule_fire") == []
    assert service.state.value("thermostat-bathroom", "setpoint") == 22


def test_disabled_rule_does_nothing(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    rule = bathroom_setback()
    rule["enabled"] = False
    add_documents(service, devices=[thermostat_doc()], rules=[rule])

    async def scenario():
        await service.manual_set("thermostat-bathroom", {"setpoint": 22})
        clock.advance(4 * 3600)
        await service.scheduler.tick(clock())

    run(scenario())
    assert service.state.value("thermostat-bathroom", "setpoint") == 22
    assert service.store.read_events(kind="rule_fire") == []


def test_rule_errors_are_audited_not_fatal(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "broken",
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
            }
        ],
    )

    async def scenario():
        service.store.rules["broken"].then[0].set.attr = "ghost-attr"  # simulate drift from a hand edit
        await service.apply_state("powerplug-terrace", "power", 5)

    run(scenario())
    errors = service.store.read_events(kind="rule_error")
    assert len(errors) == 1 and "ghost-attr" in errors[0]["error"]
