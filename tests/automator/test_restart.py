"""Reconnect and restart behaviour - plan task 9."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from automator.config import MqttSettings
from automator.mqtt_gateway import MqttGateway
from support import (
    FakeClock,
    FakeMqttClient,
    add_documents,
    make_gateway_service,
    make_service,
    plug_doc,
    run,
)

TZ = ZoneInfo("Europe/Helsinki")


def test_reconnect_resubscribes_and_re_evaluates_if_rules(tmp_path):
    clock = FakeClock()
    service, first = make_gateway_service(
        tmp_path,
        clock,
        mqtt=MqttSettings(url="localhost", host="localhost", reconnect_min=0.01, reconnect_max=0.05),
    )
    second = FakeMqttClient()
    clients = [first, second]
    service.gateway = MqttGateway(service, client_factory=lambda: clients.pop(0) if clients else FakeMqttClient())

    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "keep-off",
                "rate_limit": 0,
                "when": {"device": "powerplug-terrace", "attr": "power", "changed": True},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 100}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            }
        ],
    )

    async def wait_for(predicate, timeout=2.0):
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.01)
        return False

    async def scenario():
        await service.start()
        assert await wait_for(lambda: bool(first.subscriptions))
        await first.feed("zigbee2mqtt/powerplug-terrace", '{"power":500}')
        assert await wait_for(lambda: service.state.value("powerplug-terrace", "state") == "OFF")

        # somebody turns the plug back on by hand while the broker is unreachable
        await service.manual_set("powerplug-terrace", {"state": "ON"})
        assert service.state.value("powerplug-terrace", "state") == "ON"

        await first.close()  # broker drop: the gateway loop reconnects
        assert await wait_for(lambda: bool(second.subscriptions))

        # the reconnect re-evaluates if-rules, so the plug goes back off
        assert await wait_for(lambda: service.state.value("powerplug-terrace", "state") == "OFF")
        resyncs = [event for event in service.store.read_events(kind="rule_fire") if event["trigger"]["kind"] == "resync"]
        assert resyncs, "the reconnect re-evaluated the rule"

        # and the new subscription is live
        await second.feed("zigbee2mqtt/powerplug-terrace", '{"power":1}')
        assert await wait_for(lambda: service.state.value("powerplug-terrace", "power") == 1)

        connections = [event["status"] for event in service.store.read_events(kind="mqtt")]
        assert connections == ["connected", "disconnected", "connected"]
        await service.stop()

    run(scenario())


def test_resync_does_not_restart_pending_debounce_timers(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "power-debounce",
                "when": {"device": "powerplug-terrace", "attr": "power", "changed": True},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 100}]},
                "for": "3h",
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            }
        ],
    )

    async def scenario():
        await service.apply_state("powerplug-terrace", "power", 500)
        armed = service.store.get_timer("for:power-debounce")
        assert armed is not None

        clock.advance(3600)
        await service.on_mqtt_connected()  # reconnect - must not restart the 3h window
        assert service.store.get_timer("for:power-debounce")["due_at"] == armed["due_at"]

        clock.advance(2 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

    run(scenario())


def test_restart_reloads_timers_and_schedules(tmp_path):
    clock = FakeClock(datetime(2026, 1, 15, 20, 0, tzinfo=ZoneInfo("UTC")))
    service = make_service(tmp_path, clock)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[{"id": "terrace-off", "when": {"at": "22:00"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}]}],
    )

    async def scenario():
        await service.start()
        clock.set(datetime(2026, 1, 15, 20, 0, 2, tzinfo=ZoneInfo("UTC")))
        await service.apply_state("powerplug-terrace", "state", "OFF", ts=clock())
        await service.manual_set("powerplug-terrace", {"state": "ON"}, revert_after=timedelta(hours=4))
        pending_before = service.store.get_timer("revert:powerplug-terrace:state")
        assert pending_before["value"] == "OFF"
        await service.stop()

        clock.advance(60)
        revived = make_service(tmp_path, clock)
        await revived.start()
        try:
            boot = revived.store.read_events(kind="boot")[-1]
            assert boot["devices"] == 1 and boot["rules"] == 1
            assert boot["pending_timers"] == 1
            assert revived.store.get_timer("revert:powerplug-terrace:state")["due_at"] == pending_before["due_at"]
            assert revived.state.known("powerplug-terrace", "state") is False  # state is in-memory only
            assert revived.scheduler.next_due_map()["terrace-off"] is not None

            clock.set(datetime(2026, 1, 15, 23, 59, tzinfo=ZoneInfo("UTC")))
            await revived.scheduler.tick(clock())
            assert revived.state.known("powerplug-terrace", "state") is False  # not due yet

            clock.set(datetime(2026, 1, 16, 0, 0, 2, tzinfo=ZoneInfo("UTC")))
            await revived.scheduler.tick(clock())
            # the timer carried the value to restore, so the override is undone even across a restart
            assert revived.state.value("powerplug-terrace", "state") == "OFF"
            assert revived.store.get_timer("revert:powerplug-terrace:state") is None
            fired = [event for event in revived.store.read_events(kind="timer") if event.get("status") == "fired"]
            assert len(fired) == 1 and fired[0]["kind"] == "revert"
        finally:
            await revived.stop()

    run(scenario())


def test_boot_reports_missing_configuration(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock, latitude=None, longitude=None)

    async def scenario():
        await service.start()
        try:
            boot = service.store.read_events(kind="boot")[-1]
            assert any("LAT/LON" in warning for warning in boot["warnings"])
            assert service.status()["warnings"]
        finally:
            await service.stop()

    run(scenario())


def test_stop_is_idempotent_and_cleans_up_tasks(tmp_path):
    clock = FakeClock()
    service = make_service(tmp_path, clock)

    async def scenario():
        await service.start()
        await service.stop()
        await service.stop()
        assert service._tasks == []

    run(scenario())
