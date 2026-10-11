"""Scheduler: time, solar and interval wakeups - plan task 8.

The whole schedule is driven through a fake clock: nothing here sleeps.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from astral import Observer
from astral.sun import sun

from automator.state import UNSET
from support import FakeClock, HELSINKI_LAT, HELSINKI_LON, add_documents, make_service, plug_doc, run

TZ = ZoneInfo("Europe/Helsinki")


def local(year: int, month: int, day: int, hour: int, minute: int = 0, tz: ZoneInfo = TZ) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=tz)


def terrace_lights() -> list[dict]:
    set_state = lambda value: {"set": {"device": "powerplug-terrace", "attr": "state", "value": value}}  # noqa: E731
    return [
        {"id": "terrace-dusk", "when": {"at": "dusk"}, "then": [set_state("ON")]},
        {"id": "terrace-nightoff", "when": {"at": "23:30"}, "then": [set_state("OFF")]},
        {"id": "terrace-morningon", "when": {"at": "06:00"}, "then": [set_state("ON")]},
        {"id": "terrace-sunrise", "when": {"at": "sunrise"}, "then": [set_state("OFF")]},
    ]


def toilet_tariff() -> list[dict]:
    return [
        {"id": "toilet-night", "when": {"at": "22:00"}, "then": [{"set": {"device": "thermostat-toilet", "attr": "setpoint", "value": 24}}]},
        {"id": "toilet-day", "when": {"at": "07:00"}, "then": [{"set": {"device": "thermostat-toilet", "attr": "setpoint", "value": 15}}]},
    ]


def thermostat(device_id: str = "thermostat-toilet") -> dict:
    return {
        "id": device_id,
        "attributes": {
            "setpoint": {
                "read": {"topic": f"zwave/{device_id}/67/0/setpoint/1", "path": "value"},
                "write": {"topic": f"zwave/{device_id}/67/0/setpoint/1/set", "payload": {"value": "$v"}},
                "type": "number",
                "limits": [5, 30],
            }
        },
    }


def dusk_on(day) -> datetime:
    return sun(Observer(latitude=HELSINKI_LAT, longitude=HELSINKI_LON), date=day, tzinfo=TZ, dawn_dusk_depression=6.0)["dusk"]


def sunrise_on(day) -> datetime:
    return sun(Observer(latitude=HELSINKI_LAT, longitude=HELSINKI_LON), date=day, tzinfo=TZ)["sunrise"]


def test_terrace_lights_full_day(tmp_path):
    day = local(2026, 1, 15, 12).date()
    clock = FakeClock(local(2026, 1, 15, 15).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[plug_doc()], rules=terrace_lights())

    async def scenario():
        await service.scheduler.tick(clock())

        clock.set(dusk_on(day).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON", "lights on at dusk"

        clock.set(local(2026, 1, 15, 23, 30).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF", "lights off at 23:30"

        clock.set(local(2026, 1, 16, 6, 0).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON", "lights on at 06:00"

        clock.set(sunrise_on(local(2026, 1, 16, 12).date()).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF", "lights off at sunrise"

    run(scenario())
    fired = [event["rule"] for event in service.store.read_events(kind="rule_fire")]
    assert fired == ["terrace-dusk", "terrace-nightoff", "terrace-morningon", "terrace-sunrise"]


def test_firing_twice_is_idempotent(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 21, 59).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    rule = {"id": "terrace-off", "rate_limit": 0, "when": {"at": "22:00"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}]}
    add_documents(service, devices=[plug_doc()], rules=[rule])

    async def scenario():
        await service.scheduler.tick(clock())  # arms the 22:00 schedule
        clock.set(local(2026, 1, 15, 22).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        await service.evaluator.on_time_trigger(service.store.rules["terrace-off"], clock())  # re-assert after a restart

    run(scenario())
    statuses = [event["status"] for event in service.store.read_events(kind="write")]
    assert statuses == ["applied", "unchanged"]
    assert service.state.value("powerplug-terrace", "state") == "OFF"


def test_toilet_night_tariff(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 20).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[thermostat()], rules=toilet_tariff())

    async def scenario():
        await service.scheduler.tick(clock())
        clock.set(local(2026, 1, 15, 22).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-toilet", "setpoint") == 24

        clock.set(local(2026, 1, 16, 7).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-toilet", "setpoint") == 15

    run(scenario())
    assert [event["payload"]["value"] for event in service.store.read_events(kind="write")] == [24, 15]


def test_weekly_schedule_only_fires_on_saturday(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 13).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[{"id": "saturday-heat", "when": {"at": "14:00", "days": ["Sat"]}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}]}],
    )
    # 2026-01-15 is a Thursday; Saturday is 2026-01-17

    async def scenario():
        await service.scheduler.tick(clock())
        clock.set(local(2026, 1, 16, 14).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))  # Friday
        await service.scheduler.tick(clock())
        assert service.state.known("powerplug-terrace", "state") is False

        clock.set(local(2026, 1, 17, 14).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))  # Saturday
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON"

    run(scenario())


def test_interval_rule_with_condition(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 12).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "keep-off",
                "when": {"every": "15m"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 1000}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            }
        ],
    )

    async def scenario():
        await service.scheduler.tick(clock())  # arms the interval
        await service.apply_state("powerplug-terrace", "power", 2000)
        assert service.state.known("powerplug-terrace", "state") is False  # nothing happens until the interval elapses

        clock.advance(15 * 60)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

        clock.advance(15 * 60)
        await service.scheduler.tick(clock())
        assert len(service.store.read_events(kind="rule_fire")) == 2

    run(scenario())


def test_solar_offset_is_applied(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 12).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[{"id": "early", "when": {"at": "dusk", "offset": "-30m"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}]}],
    )
    day = local(2026, 1, 15, 12).date()

    async def scenario():
        await service.scheduler.tick(clock())
        trigger = dusk_on(day) - timedelta(minutes=30)
        clock.set(trigger.astimezone(ZoneInfo("UTC")) - timedelta(minutes=1))
        await service.scheduler.tick(clock())
        assert service.state.known("powerplug-terrace", "state") is False
        clock.set(trigger.astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON"

    run(scenario())


def test_solar_rules_are_inert_without_coordinates(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 12).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock, latitude=None, longitude=None)
    add_documents(service, devices=[plug_doc()], rules=[{"id": "dusk", "when": {"at": "dusk"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}]}])

    async def scenario():
        await service.scheduler.tick(clock())
        clock.advance(3600)
        await service.scheduler.tick(clock())

    run(scenario())
    assert service.state.value("powerplug-terrace", "state", UNSET) is UNSET
    assert service.scheduler.next_due_map() == {"dusk": None}


def test_missed_firing_is_caught_up_once_after_restart(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 21, 0).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[plug_doc()], rules=[{"id": "terrace-off", "when": {"at": "22:00"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}]}])

    async def scenario():
        await service.start()
        clock.set(local(2026, 1, 15, 22).astimezone(ZoneInfo("UTC")) + timedelta(seconds=1))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"
        await service.stop()

        # restart five minutes later: the firing already happened, nothing is repeated
        clock.set(local(2026, 1, 15, 22, 5).astimezone(ZoneInfo("UTC")))
        revived = make_service(tmp_path, clock)
        await revived.start()
        await revived.scheduler.tick(clock())
        assert len(revived.store.read_events(kind="rule_fire")) == 1
        await revived.stop()

        # restart after downtime that swallowed the firing: catch up once
        clock.set(local(2026, 1, 16, 22, 5).astimezone(ZoneInfo("UTC")))
        late = make_service(tmp_path, clock)
        await late.start()
        await late.scheduler.tick(clock())
        fires = late.store.read_events(kind="rule_fire")
        assert len(fires) == 2, "the missed firing is caught up once"
        catches = late.store.read_events(kind="schedule")
        assert [event["action"] for event in catches] == ["catch_up"]
        assert late.store.get_timer("for:terrace-off") is None
        await late.stop()

        # ... but only within the catch-up window (13h of downtime is too much)
        clock.set(local(2026, 1, 22, 11, 0).astimezone(ZoneInfo("UTC")))
        stale = make_service(tmp_path, clock)
        await stale.start()
        await stale.scheduler.tick(clock())
        assert len(stale.store.read_events(kind="rule_fire")) == 2  # still just the two older ones
        await stale.stop()

    run(scenario())


def test_boot_arms_schedules_and_survives_deleted_rules(tmp_path):
    clock = FakeClock(local(2026, 1, 15, 21).astimezone(ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(service, devices=[plug_doc()], rules=[{"id": "terrace-off", "when": {"at": "22:00"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}]}])

    async def scenario():
        await service.start()
        assert service.scheduler.next_due_map()["terrace-off"] is not None
        service.store.delete_rule("terrace-off")
        clock.advance(3600)
        await service.scheduler.tick(clock())

    run(scenario())
    assert "terrace-off" not in service.scheduler.next_due_map()
    assert service.store.read_events(kind="rule_fire") == []
