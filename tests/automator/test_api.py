"""REST surface - plan task 6.

Uses a dependency-free ASGI micro client, so the tests exercise the real app
(same code path as uvicorn) without needing httpx.
"""

from __future__ import annotations

import json

from automator.api import create_app
from support import ApiClient, FakeClock, add_documents, group_doc, make_service, plug_doc, plug_group_members, run, thermostat_doc


async def with_app(tmp_path, clock=None, **overrides):
    service = make_service(tmp_path, clock or FakeClock(), **overrides)
    app = create_app(service.settings, service)
    await service.start()
    return service, ApiClient(app)


def test_ops_routes(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            assert (await client.get("/healthz")).json["status"] == "ok"
            ready = (await client.get("/readyz")).json
            assert ready["devices"] == 0 and ready["mqtt_enabled"] is False
            metrics = await client.get("/metrics")
            assert "automator" not in metrics.text and "state_values" in metrics.text
            assert "# TYPE rule_fires_total counter" in metrics.text
            assert "home-automator" in (await client.get("/")).text
            assert (await client.get("/openapi.json")).status == 200
        finally:
            await service.stop()

    run(scenario())


def test_unstarted_service_is_not_ready(tmp_path):
    async def scenario():
        service = make_service(tmp_path)
        client = ApiClient(create_app(service.settings, service))
        response = await client.get("/readyz")
        assert response.status == 503
        assert (await client.get("/healthz")).status == 200

    run(scenario())


def test_device_crud_and_state(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            created = await client.put("/api/v1/devices/powerplug-terrace", plug_doc())
            assert created.status == 200
            assert created.json["id"] == "powerplug-terrace"

            listing = (await client.get("/api/v1/devices")).json
            assert [device["id"] for device in listing] == ["powerplug-terrace"]
            assert listing[0]["state"] == {}
            assert listing[0]["attributes"]["state"]["enum"] == ["ON", "OFF"]

            await service.apply_state("powerplug-terrace", "state", "ON")
            detail = (await client.get("/api/v1/devices/powerplug-terrace")).json
            assert detail["state"]["state"]["value"] == "ON"
            assert (await client.get("/api/v1/state/powerplug-terrace")).json["state"]["value"] == "ON"
            assert "powerplug-terrace" in (await client.get("/api/v1/state")).json

            assert (await client.get("/api/v1/devices/ghost")).status == 404
            assert (await client.get("/api/v1/state/ghost")).status == 404
            assert (await client.delete("/api/v1/devices/powerplug-terrace")).status == 200
            assert (await client.delete("/api/v1/devices/powerplug-terrace")).status == 404
            assert service.state.snapshot() == {}
        finally:
            await service.stop()

    run(scenario())


def test_device_validation_returns_field_errors(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            broken = plug_doc()
            broken["attributes"]["state"]["limits"] = [1, 2]  # limits on a string attribute
            response = await client.put("/api/v1/devices/powerplug-terrace", broken)
            assert response.status == 422
            assert any("limits" in problem for problem in response.json["detail"])

            response = await client.put("/api/v1/devices/powerplug-terrace", {**plug_doc(), "id": "other"})
            assert response.status == 422
            assert "does not match" in response.json["detail"][0]

            response = await client.request("PUT", "/api/v1/devices/powerplug-terrace", body=[1, 2, 3])
            assert response.status == 422
        finally:
            await service.stop()

    run(scenario())


def test_delete_and_attribute_changes_respect_references(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/powerplug-terrace", plug_doc())
            await client.put("/api/v1/devices/thermostat-bathroom", thermostat_doc())
            rule = {
                "id": "keep-off",
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            }
            assert (await client.put("/api/v1/rules/keep-off", rule)).status == 200

            response = await client.delete("/api/v1/devices/powerplug-terrace")
            assert response.status == 422
            assert "keep-off" in response.json["detail"][0]

            stripped = plug_doc()
            del stripped["attributes"]["state"]
            response = await client.put("/api/v1/devices/powerplug-terrace", stripped)
            assert response.status == 422
            assert "used by rules" in response.json["detail"][0]

            # removing an unreferenced device is fine
            assert (await client.delete("/api/v1/devices/thermostat-bathroom")).status == 200
        finally:
            await service.stop()

    run(scenario())


def test_group_crud_and_set(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            for document in plug_group_members("floor-heating", 2):
                assert (await client.put(f"/api/v1/devices/{document['id']}", document)).status == 200
            group = group_doc("floor-heating", ["floor-heating-a", "floor-heating-b"])
            assert (await client.put("/api/v1/groups/floor-heating", group)).status == 200

            broken = await client.put("/api/v1/groups/floor-heating", group_doc("floor-heating", ["floor-heating-a", "ghost"]))
            assert broken.status == 422 and "ghost" in broken.json["detail"][0]

            for member in ("floor-heating-a", "floor-heating-b"):
                await service.apply_state(member, "state", "OFF")
            response = await client.post("/api/v1/groups/floor-heating/set", {"state": "ON", "revert_after": "4h"})
            assert response.status == 200
            assert [result["status"] for result in response.json["results"]] == ["applied", "applied"]
            assert service.state.value("floor-heating-a", "state") == "ON"
            assert len(service.store.list_timers("revert")) == 2

            assert (await client.post("/api/v1/groups/floor-heating/set", {"nope": "ON"})).status == 422
            assert (await client.post("/api/v1/groups/ghost/set", {"state": "ON"})).status == 404
            assert (await client.post("/api/v1/groups/floor-heating/set", {})).status == 422

            # a rule that targets the group keeps it from being deleted
            rule = {"id": "saturday", "when": {"at": "14:00"}, "then": [{"set": {"group": "floor-heating", "attr": "state", "value": "ON"}}]}
            assert (await client.put("/api/v1/rules/saturday", rule)).status == 200
            assert (await client.delete("/api/v1/groups/floor-heating")).status == 422

            # ... and the group's members must have the attribute
            bad_rule = {"id": "bad", "when": {"at": "14:00"}, "then": [{"set": {"group": "floor-heating", "attr": "temperature", "value": 1}}]}
            response = await client.put("/api/v1/rules/bad", bad_rule)
            assert response.status == 422
            assert any("temperature" in problem for problem in response.json["detail"])
        finally:
            await service.stop()

    run(scenario())


def test_device_set_endpoint(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/thermostat-bathroom", thermostat_doc())
            response = await client.post("/api/v1/devices/thermostat-bathroom/set", {"setpoint": 22, "revert_after": "4h"})
            assert response.status == 200
            assert response.json["results"][0]["status"] == "applied"
            assert service.state.value("thermostat-bathroom", "setpoint") == 22

            assert (await client.post("/api/v1/devices/thermostat-bathroom/set", {"nope": 1})).status == 422
            assert (await client.post("/api/v1/devices/thermostat-bathroom/set", {})).status == 422
            assert (await client.post("/api/v1/devices/thermostat-bathroom/set", {"setpoint": 1})).status == 200  # limits refuse, API reports
            assert (await client.post("/api/v1/devices/thermostat-bathroom/set", {"setpoint": 22, "revert_after": "soon"})).status == 422
            assert (await client.post("/api/v1/devices/ghost/set", {"setpoint": 22})).status == 404
        finally:
            await service.stop()

    run(scenario())


def test_rule_crud_enable_test_and_delete(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/thermostat-bathroom", thermostat_doc())
            rule = {
                "id": "bathroom-setback",
                "priority": 100,
                "when": {"device": "thermostat-bathroom", "attr": "setpoint", "changed": True},
                "if": {"all": [{"attr": ["thermostat-bathroom", "setpoint"], "op": "ne", "value": 17}]},
                "for": "3h",
                "then": [{"set": {"device": "thermostat-bathroom", "attr": "setpoint", "value": 17}}],
            }
            created = await client.put("/api/v1/rules/bathroom-setback", rule)
            assert created.status == 200
            assert created.json["for"] == "3h"

            assert [item["id"] for item in (await client.get("/api/v1/rules")).json] == ["bathroom-setback"]
            assert (await client.get("/api/v1/rules/bathroom-setback")).json["enabled"] is True

            # bad references are rejected with a list of problems
            broken = {**rule, "when": {"device": "ghost", "attr": "setpoint"}}
            response = await client.put("/api/v1/rules/bathroom-setback", broken)
            assert response.status == 422 and "ghost" in response.json["detail"][0]

            bad_topic = {**rule, "then": [{"publish": {"topic": "home/#/bad", "payload": 1}}]}
            response = await client.put("/api/v1/rules/bathroom-setback", bad_topic)
            assert response.status == 422 and "invalid MQTT topic filter" in response.json["detail"][0]

            assert (await client.post("/api/v1/rules/bathroom-setback/disable")).json["enabled"] is False
            assert (await client.post("/api/v1/rules/bathroom-setback/enable")).json["enabled"] is True

            await service.apply_state("thermostat-bathroom", "setpoint", 22)
            report = (await client.post("/api/v1/rules/bathroom-setback/test")).json
            assert report["condition"]["satisfied"] is True
            assert report["writes"][0]["value"] == 17
            assert report["deferred_seconds"] == 10800
            assert service.state.value("thermostat-bathroom", "setpoint") == 22  # nothing was written

            missing_state = (await client.post("/api/v1/rules/ghost/test")).status
            assert missing_state == 404

            assert (await client.delete("/api/v1/rules/bathroom-setback")).status == 200
            assert (await client.delete("/api/v1/rules/bathroom-setback")).status == 404
            assert service.store.rules == {}
        finally:
            await service.stop()

    run(scenario())


def test_rule_test_with_unknown_trigger_value(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/powerplug-terrace", plug_doc())
            rule = {"id": "power-rule", "when": {"device": "powerplug-terrace", "attr": "power"}, "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}]}
            await client.put("/api/v1/rules/power-rule", rule)
            report = (await client.post("/api/v1/rules/power-rule/test")).json
            assert report["trigger"]["unknown_value"] is True
            assert report["writes"][0]["previous"] is None
        finally:
            await service.stop()

    run(scenario())


def test_events_endpoint(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/powerplug-terrace", plug_doc())
            await client.post("/api/v1/devices/powerplug-terrace/set", {"state": "ON"})
            events = (await client.get("/api/v1/events?limit=5")).json
            assert [event["type"] for event in events][-1] == "write"

            writes = (await client.get("/api/v1/events?kind=write")).json
            assert writes and all(event["type"] == "write" for event in writes)

            assert (await client.get("/api/v1/events?since=not-a-date")).status == 422
            assert (await client.get("/api/v1/events?limit=0")).status == 422
        finally:
            await service.stop()

    run(scenario())


def test_timers_reload_and_dry_run_endpoints(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/powerplug-terrace", plug_doc())
            await client.post("/api/v1/devices/powerplug-terrace/set", {"state": "OFF"})
            await client.post("/api/v1/devices/powerplug-terrace/set", {"state": "ON", "revert_after": "4h"})
            timers = (await client.get("/api/v1/timers")).json
            assert [timer["id"] for timer in timers["timers"]] == ["revert:powerplug-terrace:state"]
            assert "revert:powerplug-terrace:state" in timers["timers"][0]["id"]
            assert timers["next_due"] == {}

            assert (await client.post("/api/v1/dry-run", {"enabled": True})).json == {"dry_run": True}
            response = await client.post("/api/v1/devices/powerplug-terrace/set", {"state": "OFF"})
            assert response.json["results"][0]["status"] == "dry-run"
            assert service.state.value("powerplug-terrace", "state") == "ON"
            assert (await client.post("/api/v1/dry-run", {"enabled": False})).json == {"dry_run": False}

            status = (await client.post("/api/v1/reload")).json
            assert status["devices"] == 1
        finally:
            await service.stop()

    run(scenario())


def test_hand_edited_config_is_picked_up_without_restart(tmp_path):
    async def scenario():
        service, client = await with_app(tmp_path)
        try:
            await client.put("/api/v1/devices/powerplug-terrace", plug_doc())
            config_path = tmp_path / "data" / "config.json"
            document = json.loads(config_path.read_text())
            document["rules"]["hand-written"] = {
                "id": "hand-written",
                "when": {"at": "22:00"},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            }
            config_path.write_text(json.dumps(document))
            import os
            import time

            os.utime(config_path, (time.time() + 5, time.time() + 5))

            await service.scheduler.tick(service.clock())
            rules = (await client.get("/api/v1/rules")).json
            assert [rule["id"] for rule in rules] == ["hand-written"]
        finally:
            await service.stop()

    run(scenario())
