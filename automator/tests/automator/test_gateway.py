"""MQTT gateway: routing, type decoding, writes and echo suppression - plan task 4."""

from __future__ import annotations

import asyncio
import json

from support import add_documents, make_gateway_service, plug_doc, run, running_service, thermostat_doc


def test_zigbee_and_zwave_payloads_both_reach_state(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    add_documents(service, devices=[plug_doc(), thermostat_doc()])

    async def scenario():
        gateway = service.gateway
        await gateway.handle_message("zigbee2mqtt/powerplug-terrace", '{"state":"ON","power":42.5}')
        await gateway.handle_message("zigbee2mqtt/powerplug-terrace", json.dumps({"state": "OFF", "power": 0}))
        await gateway.handle_message("zwave/thermostat-bathroom/67/0/setpoint/1", json.dumps({"value": 21.5, "unit": "C"}))
        await gateway.handle_message("zwave/thermostat-bathroom/49/0/Air_temperature", json.dumps({"value": 20.1}))

    run(scenario())
    assert service.state.value("powerplug-terrace", "state") == "OFF"
    assert service.state.value("powerplug-terrace", "power") == 0
    assert service.state.value("thermostat-bathroom", "setpoint") == 21.5
    assert service.state.value("thermostat-bathroom", "temperature") == 20.1

    events = service.store.read_events(kind="state")
    assert len(events) == 6  # two zigbee messages x two attributes, plus two zwave values
    assert {event["source"] for event in events} == {"mqtt"}


def test_plain_payloads_and_wildcards(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    add_documents(
        service,
        devices=[{"id": "outside", "attributes": {"temperature": {"read": {"topic": "home/+/temperature"}, "type": "number"}}}],
    )

    async def scenario():
        await service.gateway.handle_message("home/backyard/temperature", "12.5")

    run(scenario())
    assert service.state.value("outside", "temperature") == 12.5


def test_unmatched_topics_and_missing_paths_are_ignored(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        gateway = service.gateway
        await gateway.handle_message("zigbee2mqtt/some-other-plug", '{"state":"ON"}')
        await gateway.handle_message("zigbee2mqtt/powerplug-terrace", '{"linkquality":42}')

    run(scenario())
    assert len(service.state) == 0
    assert service.store.read_events(kind="state") == []


def test_bad_values_are_audited_not_crashed(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        await service.gateway.handle_message("zigbee2mqtt/powerplug-terrace", '{"power":"not a number"}')

    run(scenario())
    assert service.state.known("powerplug-terrace", "power") is False
    errors = service.store.read_events(kind="mqtt_value_error")
    assert len(errors) == 1
    assert "not a number" in errors[0]["error"]


def test_scale_and_offset_are_applied(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    add_documents(
        service,
        devices=[{"id": "raw", "attributes": {"temperature": {"read": {"topic": "home/raw"}, "type": "number", "scale": 0.1, "offset": -5}}}],
    )

    async def scenario():
        await service.gateway.handle_message("home/raw", "250")

    run(scenario())
    assert service.state.value("raw", "temperature") == 20.0


def test_read_only_attribute_has_no_write_spec(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        return await service.manual_set("powerplug-terrace", {"power": 5})

    results = run(scenario())
    assert results[0]["status"] == "applied"
    assert results[0]["topic"] is None  # read-only attribute: state changes, nothing is published


def test_transport_loop_subscribes_routes_and_runs_rules(tmp_path):
    service, client = make_gateway_service(tmp_path)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "mirror-power",
                "when": {"device": "powerplug-terrace", "attr": "power"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 100}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
            }
        ],
    )

    async def scenario():
        async with running_service(service, client):
            assert client.subscriptions == ["zigbee2mqtt/#", "zwave/#", "home/#"]
            await client.feed("zigbee2mqtt/powerplug-terrace", '{"state":"OFF","power":500}')
            for _ in range(50):
                await asyncio.sleep(0.01)
                if service.state.value("powerplug-terrace", "state") == "ON":
                    break
            assert service.state.value("powerplug-terrace", "state") == "ON"
            assert client.published == [{"topic": "zigbee2mqtt/powerplug-terrace/set", "payload": '{"state":"ON"}', "retain": False}]

    run(scenario())


def test_own_write_echo_is_ignored(tmp_path):
    service, client = make_gateway_service(tmp_path)
    add_documents(service, devices=[plug_doc()])

    async def scenario():
        async with running_service(service, client):
            await service.manual_set("powerplug-terrace", {"state": "ON"})
            assert service.state.value("powerplug-terrace", "state") == "ON"
            events_before = len(service.store.read_events(kind="state"))
            # the broker echoes our own retained write back
            await client.feed("zigbee2mqtt/powerplug-terrace", '{"state":"ON","power":3}')
            for _ in range(30):
                await asyncio.sleep(0.01)
                if service.state.known("powerplug-terrace", "power"):
                    break
            assert service.state.value("powerplug-terrace", "power") == 3
            state_events = [event for event in service.store.read_events(kind="state") if event["attr"] == "state"]
            assert len(state_events) == events_before  # echo did not produce a second change

    run(scenario())


def test_locked_device_refuses_rule_and_manual_writes(tmp_path):
    service, _client = make_gateway_service(tmp_path)
    document = plug_doc()
    document["locked"] = True
    add_documents(service, devices=[document])

    async def scenario():
        return await service.manual_set("powerplug-terrace", {"state": "ON"})

    results = run(scenario())
    assert results[0]["status"] == "skipped"
    assert results[0]["reason"] == "device_locked"
    assert service.state.known("powerplug-terrace", "state") is False
