from datetime import timedelta

from automator.mqtt_gateway import MqttGateway
from .support import FakeClock, make_service, run, add_documents


def gateway_document():
    base = "home/device-gateway/pump"
    return {"id": "pump", "name": "Heat pump", "command": {
        "topic": base + "/set", "state_topic": base + "/state", "result_topic": base + "/result",
        "availability_topic": base + "/availability", "stale_after": "30s", "result_timeout": "60s",
    }, "attributes": {
        "state": {"type": "boolean", "default": False, "write": {"topic": base + "/set"}},
        "mode": {"type": "string", "enum": ["heat", "cool"], "write": {"topic": base + "/set"}},
        "setpoint": {"type": "number", "limits": [10, 31], "write": {"topic": base + "/set"}},
        "temperature": {"type": "number"},
    }}


async def snapshot(svc, values, offset=0):
    stamp = svc.clock() + timedelta(seconds=offset)
    return await svc.commands.handle("home/device-gateway/pump/state", {"observed_at": stamp.isoformat(), "values": values, "source": "melcloud"})


def test_pending_separate_state_off_during_on_and_result_ordering(tmp_path):
    async def scenario():
        svc = make_service(tmp_path)
        await svc.start()
        add_documents(svc, devices=[gateway_document()])
        await snapshot(svc, {"state": False, "mode": "heat", "setpoint": 21})
        first = (await svc.manual_set("pump", {"state": True}))[0]
        assert first["status"] == "pending"
        assert svc.state.value("pump", "state") is False
        second = (await svc.manual_set("pump", {"state": False}))[0]
        assert second["status"] == "pending" and second["request_id"] != first["request_id"]
        assert len(svc.gateway.sent) == 2
        await svc.commands.handle("home/device-gateway/pump/result", {"request_id": first["request_id"], "status": "reported"})
        assert svc.commands.intent("pump", "state")["request_id"] == second["request_id"]
        await svc.commands.handle("home/device-gateway/pump/result", {"request_id": second["request_id"], "status": "confirmed"})
        assert svc.commands.intent("pump", "state") is None
        assert svc.state.value("pump", "state") is False
        await svc.stop()
    run(scenario())


def test_combined_patch_validation_dry_run_and_duplicate_intent(tmp_path):
    async def scenario():
        svc = make_service(tmp_path)
        await svc.start()
        add_documents(svc, devices=[gateway_document()])
        await snapshot(svc, {"mode": "heat", "setpoint": 21})
        results = await svc.manual_set("pump", {"mode": "cool", "setpoint": 21})
        assert len({r["request_id"] for r in results}) == 1
        assert svc.gateway.sent[-1]["payload"]["values"] == {"mode": "cool", "setpoint": 21}
        await svc.manual_set("pump", {"mode": "cool", "setpoint": 21})
        assert len(svc.gateway.sent) == 1
        await svc.manual_set("pump", {"mode": "heat", "temperature": 99})
        assert len(svc.gateway.sent) == 1
        svc.dry_run = True
        results = await svc.manual_set("pump", {"mode": "heat", "setpoint": 20})
        assert all(r["status"] == "dry-run" for r in results)
        assert len(svc.gateway.sent) == 1
        await svc.stop()
    run(scenario())


def test_snapshots_refresh_missing_older_unavailable_and_expiry(tmp_path):
    async def scenario():
        clock = FakeClock()
        svc = make_service(tmp_path, clock)
        await svc.start()
        add_documents(svc, devices=[gateway_document()])
        await snapshot(svc, {"mode": "heat", "setpoint": 21})
        previous = svc.state.get("pump", "mode")
        clock.advance(10)
        handled, changes = await snapshot(svc, {"mode": "heat"})
        assert handled and not changes
        assert svc.state.get("pump", "mode").ts > previous.ts
        assert not svc.state.known("pump", "setpoint")
        await snapshot(svc, {"mode": "cool", "setpoint": 30}, offset=-5)
        assert svc.state.value("pump", "mode") == "heat"
        clock.advance(31)
        await svc.scheduler.tick(clock())
        assert not svc.state.known("pump", "mode")
        await svc.commands.handle("home/device-gateway/pump/availability", {"available": False})
        assert (await svc.manual_set("pump", {"mode": "cool"}))[0]["status"] == "pending"
        await svc.stop()
    run(scenario())


def test_late_failure_preserves_newer_override_and_uncertainty_keeps_restore(tmp_path):
    async def scenario():
        clock = FakeClock()
        svc = make_service(tmp_path, clock)
        await svc.start()
        add_documents(svc, devices=[gateway_document()])
        await snapshot(svc, {"state": False})
        first = (await svc.manual_set("pump", {"state": True}, revert_after=timedelta(minutes=10)))[0]
        second = (await svc.manual_set("pump", {"state": False}, revert_after=timedelta(minutes=20)))[0]
        await svc.commands.handle("home/device-gateway/pump/result", {"request_id": first["request_id"], "status": "failed"})
        assert svc.store.timers["revert:pump:state"]["request_id"] == second["request_id"]
        clock.advance(61)
        await svc.scheduler.tick(clock())
        assert svc.commands.intent("pump", "state") is None
        assert "revert:pump:state" in svc.store.timers
        await svc.stop()
    run(scenario())


def test_gateway_mqtt_snapshot_routing(tmp_path):
    async def scenario():
        svc = make_service(tmp_path)
        await svc.start()
        add_documents(svc, devices=[gateway_document()])
        gateway = MqttGateway(svc)
        import json
        await gateway.handle_message("home/device-gateway/pump/state", json.dumps({"values": {"mode": "cool"}, "observed_at": svc.clock().isoformat(), "source": "melcloud"}))
        assert svc.state.value("pump", "mode") == "cool"
        await svc.stop()
    run(scenario())


def test_tracked_command_and_timed_restore(tmp_path):
    """Automator command and override lifecycle using simulated gateway responses."""
    async def scenario():
        clock = FakeClock()
        svc = make_service(tmp_path, clock)
        await svc.start()
        add_documents(svc, devices=[gateway_document()])
        await snapshot(svc, {"state": False})
        command = (await svc.manual_set("pump", {"state": True}, revert_after=timedelta(seconds=5)))[0]
        assert svc.gateway.sent[-1]["payload"]["request_id"] == command["request_id"]
        await svc.commands.handle("home/device-gateway/pump/result", {"request_id": command["request_id"], "status": "accepted"})
        assert svc.state.value("pump", "state") is False
        clock.advance(1)
        await snapshot(svc, {"state": True})
        await svc.commands.handle("home/device-gateway/pump/result", {"request_id": command["request_id"], "status": "confirmed"})
        clock.advance(5)
        await svc.scheduler.tick(clock())
        restore = svc.gateway.sent[-1]["payload"]
        assert restore["values"] == {"state": False}
        assert restore["request_id"] != command["request_id"]
        assert svc.state.value("pump", "state") is True
        clock.advance(1)
        await snapshot(svc, {"state": False})
        await svc.commands.handle("home/device-gateway/pump/result", {"request_id": restore["request_id"], "status": "confirmed"})
        assert svc.state.value("pump", "state") is False
        assert svc.commands.intent("pump", "state") is None
        await svc.stop()
    run(scenario())
