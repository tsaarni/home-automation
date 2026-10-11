"""Seed documents and the config-driven device generator - plan task 10."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from astral import Observer
from astral.sun import sun

from automator.models import Device, Group, Rule, check_group_references, check_rule_references
from install import install, load_seed
from support import FakeClock, HELSINKI_LAT, HELSINKI_LON, make_service, run

TZ = ZoneInfo("Europe/Helsinki")
PARTIAL = timedelta(seconds=1)
SEED_DIR = Path(__file__).resolve().parents[2] / "seed"


def local(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=TZ)


def solar(event: str, day) -> datetime:
    return sun(Observer(latitude=HELSINKI_LAT, longitude=HELSINKI_LON), date=day, tzinfo=TZ, dawn_dusk_depression=6.0)[event]


def test_seed_documents_are_valid_and_consistent():
    model = load_seed()
    devices = {key: Device.model_validate({**document, "id": key}) for key, document in model["devices"].items()}
    groups = {key: Group.model_validate({**document, "id": key}) for key, document in model["groups"].items()}
    rules = {key: Rule.model_validate({**document, "id": key}) for key, document in model["rules"].items()}

    assert {"terrace-dusk", "terrace-nightoff", "terrace-morningon", "terrace-sunrise", "toilet-night", "toilet-day", "bathroom-setback", "bathroom-curve"} <= set(rules)
    for group in groups.values():
        assert check_group_references(group, devices) == []
    for rule in rules.values():
        assert check_rule_references(rule, devices, groups) == [], f"rule {rule.id} has broken references"
    # the parity rules cover the real device inventory
    assert {"powerplug-terrace", "thermostat-bathroom", "thermostat-toilet", "temperature-backyard"} <= set(devices)
    assert devices["powerplug-terrace"].attributes["state"].enum == ["ON", "OFF"]
    assert devices["thermostat-toilet"].attributes["setpoint"].limits is not None
    assert devices["thermostat-toilet"].attributes["setpoint"].write.topic.endswith("/67/1/setpoint/1/set")
    for device in devices.values():
        for attr, definition in device.attributes.items():
            assert definition.read is not None, f"{device.id}.{attr} has no read binding"


def test_install_writes_a_config_that_the_service_loads(tmp_path):
    path = install(tmp_path / "data", force=True)
    saved = json.loads(path.read_text())
    assert set(saved) == {"version", "devices", "groups", "rules"}

    import pytest

    with pytest.raises(SystemExit):
        install(tmp_path / "data")
    install(tmp_path / "data", force=True)  # --force overwrites


def test_seeded_config_runs_the_parity_scenarios(tmp_path):
    install(tmp_path / "data", force=True)
    clock = FakeClock(local(2026, 1, 15, 15))
    service = make_service(tmp_path, clock)
    day = local(2026, 1, 15, 12).date()

    async def scenario():
        await service.start()
        assert len(service.store.devices) > 15 and len(service.store.rules) >= 8

        # terrace lights: dusk on, 23:30 off, 06:00 on, sunrise off
        await service.scheduler.tick(clock())
        clock.set((solar("dusk", day) + PARTIAL).astimezone(ZoneInfo("UTC")))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON"
        clock.set((local(2026, 1, 15, 23, 30) + PARTIAL).astimezone(ZoneInfo("UTC")))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"
        clock.set((local(2026, 1, 16, 6) + PARTIAL).astimezone(ZoneInfo("UTC")))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "ON"
        clock.set((solar("sunrise", local(2026, 1, 16, 12).date()) + PARTIAL).astimezone(ZoneInfo("UTC")))
        await service.scheduler.tick(clock())
        assert service.state.value("powerplug-terrace", "state") == "OFF"

        # floor heating night tariff
        clock.set((local(2026, 1, 16, 22) + PARTIAL).astimezone(ZoneInfo("UTC")))
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-toilet", "setpoint") == 24
        clock.set((local(2026, 1, 17, 7) + PARTIAL).astimezone(ZoneInfo("UTC")))
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-toilet", "setpoint") == 15

        # bathroom setback: manual change, then back to 17 after 3h
        await service.manual_set("thermostat-bathroom", {"setpoint": 22})
        clock.advance(3 * 3600)
        await service.scheduler.tick(clock())
        assert service.state.value("thermostat-bathroom", "setpoint") == 17

        # heating curve from the outdoor temperature
        clock.advance(60)
        await service.apply_state("temperature-backyard", "temperature", 0)
        assert service.state.value("thermostat-bathroom", "setpoint") == 21
        clock.advance(60)
        await service.apply_state("temperature-backyard", "temperature", -20)
        assert service.state.value("thermostat-bathroom", "setpoint") == 25

        # group action (the seeded example rule ships disabled, use the service path)
        member = service.store.groups["powerplug"].members[0]
        await service.group_set("powerplug", {"state": "ON"})
        assert service.state.value(member, "state") == "ON"

        await service.stop()

    run(scenario())
    assert {event["rule"] for event in service.store.read_events(kind="rule_fire")} >= {
        "terrace-dusk",
        "terrace-nightoff",
        "terrace-morningon",
        "terrace-sunrise",
        "toilet-night",
        "toilet-day",
        "bathroom-setback",
        "bathroom-curve",
    }


# --------------------------------------------------------------- the generator


def write_store(tmp_path: Path) -> Path:
    """A miniature zwave-js-ui store: two nodes, one mirror, metadata for most values."""
    store = tmp_path / "zwave-store"
    store.mkdir()
    (store / "settings.json").write_text(json.dumps({"mqtt": {"prefix": "zwave"}, "gateway": {"type": 0, "nodeNames": True}}))
    (store / "nodes.json").write_text(json.dumps({"1": {}, "8": {"name": "thermostat-bathroom"}}))
    (store / "c73500b8.json").write_text(json.dumps({"controller": {"homeId": 1}, "nodes": {"1": {"id": 1}, "8": {"id": 8}}}))

    metadata = [
        # a mirror pair: the device reports the setpoint on endpoint 0 and 1
        {"k": json.dumps({"nodeId": 8, "commandClass": 67, "endpoint": 0, "property": "setpoint", "propertyKey": 1}), "v": {"type": "number", "readable": True, "writeable": True, "min": 5, "max": 40, "unit": "°C"}},
        {"k": json.dumps({"nodeId": 8, "commandClass": 67, "endpoint": 1, "property": "setpoint", "propertyKey": 1}), "v": {"type": "number", "readable": True, "writeable": True, "min": 5, "max": 40, "unit": "°C"}},
        {"k": json.dumps({"nodeId": 8, "commandClass": 49, "endpoint": 0, "property": "Air temperature"}), "v": {"type": "number", "readable": True, "writeable": False, "unit": "°C", "label": "Air temperature"}},
        {"k": json.dumps({"nodeId": 8, "commandClass": 50, "endpoint": 4, "property": "value", "propertyKey": 65537}), "v": {"type": "number", "readable": True, "writeable": False, "label": "Electric Consumption [kWh]", "unit": "kWh"}},
        {"k": json.dumps({"nodeId": 8, "commandClass": 64, "endpoint": 0, "property": "mode"}), "v": {"type": "number", "readable": True, "writeable": True, "states": {"0": "Off", "1": "Heat", "11": "Energy heat"}}},
        {"k": json.dumps({"nodeId": 1, "commandClass": 49, "endpoint": 0, "property": "Air temperature"}), "v": {"type": "number", "readable": True, "writeable": False, "unit": "°C"}},
    ]
    values = [
        ("8", {"nodeId": 8, "commandClass": 67, "endpoint": 0, "property": "setpoint", "propertyKey": 1}, 24, 100),
        ("8", {"nodeId": 8, "commandClass": 67, "endpoint": 1, "property": "setpoint", "propertyKey": 1}, 17, 200),
        ("8", {"nodeId": 8, "commandClass": 49, "endpoint": 0, "property": "Air temperature"}, 20.5, 150),
        ("8", {"nodeId": 8, "commandClass": 50, "endpoint": 4, "property": "value", "propertyKey": 65537}, 2839, 150),
        ("8", {"nodeId": 8, "commandClass": 64, "endpoint": 0, "property": "mode"}, 1, None),
        ("8", {"nodeId": 8, "commandClass": 37, "endpoint": 4, "property": "currentValue"}, False, 150),
        ("1", {"nodeId": 1, "commandClass": 49, "endpoint": 0, "property": "Air temperature"}, 30, 150),
    ]
    (store / "c73500b8.metadata.jsonl").write_text("".join(json.dumps(entry) + "\n" for entry in metadata))
    (store / "c73500b8.values.jsonl").write_text("".join(json.dumps({"k": json.dumps(key), "v": value, "ts": ts}) + "\n" for _, key, value, ts in values))
    return store


def test_generator_derives_zwave_devices_from_the_store(tmp_path):
    from generate_devices import zwave_store_devices

    store = write_store(tmp_path)
    # the broker publishes endpoint 1 of the mirrored setpoint, not endpoint 0
    observed = {"zwave/thermostat-bathroom/67/1/setpoint/1", "zwave/thermostat-bathroom/49/0/Air_temperature", "zwave/thermostat-bathroom/status"}
    devices = zwave_store_devices(store, observed=observed)

    assert set(devices) == {"thermostat-bathroom"}  # the controller (node 1) is skipped
    attributes = devices["thermostat-bathroom"]["attributes"]

    # label/property derived names
    assert "setpoint-1" in attributes
    assert attributes["setpoint-1"]["type"] == "number"
    assert attributes["setpoint-1"]["unit"] == "C"
    assert attributes["setpoint-1"]["limits"] == [5, 40]
    assert attributes["setpoint-1"]["read"]["topic"] == "zwave/thermostat-bathroom/67/1/setpoint/1"  # mirror dropped
    assert attributes["setpoint-1"]["write"] == {"topic": "zwave/thermostat-bathroom/67/1/setpoint/1/set", "payload": {"value": "$v"}}

    assert attributes["air-temperature"]["read"]["topic"] == "zwave/thermostat-bathroom/49/0/Air_temperature"
    assert "write" not in attributes["air-temperature"]

    # meter values keep their label-derived name and unit, and are kept even when not observed
    assert attributes["electric-consumption-kwh"]["unit"] == "kWh"
    assert attributes["electric-consumption-kwh"]["read"]["topic"] == "zwave/thermostat-bathroom/50/4/value/65537"

    # states become an enum, notification-style values without metadata fall back to the value type
    assert attributes["mode"]["enum"] == [0, 1, 11]
    assert attributes["current-value"]["type"] == "boolean"
    assert attributes["current-value"]["write"]["topic"] == "zwave/thermostat-bathroom/37/4/currentValue/set"
    assert attributes["status"]["read"] == {"topic": "zwave/thermostat-bathroom/status", "path": "status"}

    for key, document in devices.items():
        Device.model_validate({**document, "id": key})


def test_generator_keeps_sleeping_devices_from_the_store(tmp_path):
    from generate_devices import zwave_store_devices

    store = write_store(tmp_path)
    # nothing at all observed for this node: fall back to what the store itself reports
    devices = zwave_store_devices(store, observed={"zwave/some-other-node/status"})
    attributes = devices["thermostat-bathroom"]["attributes"]
    assert attributes["setpoint-1"]["read"]["topic"] == "zwave/thermostat-bathroom/67/1/setpoint/1"  # newest ts wins
    assert devices["thermostat-bathroom"]["attributes"]["setpoint-1"]["limits"] == [5, 40]


def test_generator_reads_the_zigbee2mqtt_configuration_and_inventory():
    from generate_devices import build_devices, build_groups, zigbee_config, parse_simple_yaml

    configuration = parse_simple_yaml("mqtt:\n  base_topic: zigbee2mqtt\nserial:\n  port: /dev/zigbee\n")
    assert configuration["mqtt"]["base_topic"] == "zigbee2mqtt"
    devices_yaml = parse_simple_yaml(
        "'0x00158d0007dfa780':\n  friendly_name: 'temperature-backyard'\n'0xf0d1b800001bcc5c':\n  friendly_name: 'powerplug-terrace'\n"
    )
    assert devices_yaml["0x00158d0007dfa780"]["friendly_name"] == "temperature-backyard"

    config_file = SEED_DIR.parent / "tests" / "automator" / "tmp-config.yaml"
    config_file.write_text("mqtt:\n  base_topic: zigbee2mqtt\n")
    try:
        base_topic, addresses = zigbee_config(config_file, None)
    finally:
        config_file.unlink()
    assert base_topic == "zigbee2mqtt" and addresses == {}

    inventory = [
        {"friendly_name": "Coordinator", "type": "Coordinator", "definition": None},
        {
            "friendly_name": "powerplug-terrace",
            "type": "Router",
            "definition": {
                "exposes": [
                    {"type": "switch", "features": [{"access": 7, "name": "state", "property": "state", "type": "binary", "value_on": "ON", "value_off": "OFF"}]},
                    {"access": 1, "name": "linkquality", "property": "linkquality", "type": "numeric", "unit": "lqi", "value_min": 0, "value_max": 255},
                ]
            },
        },
        {
            "friendly_name": "motion-agara-front",
            "type": "EndDevice",
            "definition": {
                "exposes": [
                    {"access": 1, "name": "occupancy", "property": "occupancy", "type": "binary", "value_on": True, "value_off": False},
                    {"access": 7, "name": "motion_sensitivity", "property": "motion_sensitivity", "type": "enum", "values": ["low", "medium", "high"]},
                    {"access": 1, "name": "identify", "property": "identify", "type": "enum", "values": ["identify"]},
                ]
            },
        },
    ]
    messages = {
        "zigbee2mqtt/bridge/devices": inventory,
        "zigbee2mqtt/temperature-13": {"battery": 80, "temperature": 20.7},
        "home/thermostat-bedroom/electric_power_w": 0.04,
        "home/backyard/temperature_celsius": 1.5,
    }
    devices = build_devices(messages, observed=None)

    assert set(devices) == {"powerplug-terrace", "motion-agara-front", "temperature-13", "thermostat-bedroom", "backyard"}
    plug = devices["powerplug-terrace"]["attributes"]
    assert plug["state"]["enum"] == ["ON", "OFF"]
    assert plug["state"]["write"] == {"topic": "zigbee2mqtt/powerplug-terrace/set", "payload": {"state": "$v"}}
    assert plug["linkquality"]["limits"] == [0, 255]
    assert "unit" not in plug["linkquality"]  # 'lqi' is not a unit we show
    assert "write" not in plug["linkquality"]  # access 1 = read only
    assert devices["motion-agara-front"]["attributes"]["occupancy"]["type"] == "boolean"
    assert devices["motion-agara-front"]["attributes"]["motion-sensitivity"]["enum"] == ["low", "medium", "high"]
    assert "identify" not in devices["motion-agara-front"]["attributes"]
    assert devices["thermostat-bedroom"]["attributes"]["electric-power-w"]["unit"] == "W"
    assert devices["backyard"]["attributes"]["temperature-celsius"]["unit"] == "C"

    groups = build_groups(devices)
    assert "powerplug" not in groups  # a single member is not a group

    for key, document in devices.items():
        Device.model_validate({**document, "id": key})


def test_generator_merge_keeps_hand_tuned_bits():
    from generate_devices import build_devices, merge_devices

    seed = json.loads((SEED_DIR / "devices.json").read_text())
    generated = build_devices({"zigbee2mqtt/powerplug-terrace": {"state": "ON", "power": 12.5}})
    merged = merge_devices(seed, generated)
    plug = merged["powerplug-terrace"]["attributes"]
    assert plug["state"]["enum"] == ["ON", "OFF"]  # hand-written enum survives
    assert plug["state"]["default"] == "OFF"
    assert "state" in plug  # regenerated input is not needed under a second name
    assert len({json.dumps(definition.get("read"), sort_keys=True) for definition in plug.values()}) == len(plug)
    assert "thermostat-toilet" in merged and "siren-kitchen" in merged
