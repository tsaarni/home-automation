"""Store: config.json, pending.json, events.jsonl - plan task 2."""

from __future__ import annotations

import json
import os
import time
from datetime import timedelta

import pytest

from automator.models import Device, Group, Rule
from automator.store import ConfigError, Store
from automator.util import to_iso
from support import FakeClock, plug_doc, group_doc, thermostat_doc


def make_store(tmp_path, clock=None, **kwargs) -> Store:
    store = Store(tmp_path / "data", clock=clock or FakeClock(), **kwargs)
    store.load()
    return store


def test_put_get_list_delete_roundtrip(tmp_path):
    store = make_store(tmp_path)
    store.put_device(Device.model_validate(plug_doc()))
    store.put_group(Group.model_validate(group_doc("floor-heating", ["powerplug-terrace"])))
    store.put_rule(Rule.model_validate({
        "id": "terrace-dusk",
        "when": {"at": "dusk"},
        "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
    }))

    assert set(store.devices) == {"powerplug-terrace"}
    assert store.devices["powerplug-terrace"].attributes["state"].enum == ["ON", "OFF"]
    assert set(store.groups) == {"floor-heating"}
    assert store.rules["terrace-dusk"].when.at == "dusk"
    assert (tmp_path / "data" / "config.json").exists()

    assert store.delete_device("powerplug-terrace") is not None
    assert store.delete_device("powerplug-terrace") is None
    assert store.devices == {}
    assert store.delete_rule("terrace-dusk") is not None
    assert store.delete_group("floor-heating") is not None

    saved = json.loads((tmp_path / "data" / "config.json").read_text())
    assert saved["devices"] == {} and saved["rules"] == {} and saved["groups"] == {}


def test_config_json_is_human_readable_document(tmp_path):
    store = make_store(tmp_path)
    store.put_rule(Rule.model_validate({
        "id": "bathroom-setback",
        "priority": 100,
        "when": {"device": "thermostat-bathroom", "attr": "setpoint", "changed": True},
        "if": {"all": [{"attr": ["thermostat-bathroom", "setpoint"], "op": "ne", "value": 17}]},
        "for": "3h",
        "then": [{"set": {"device": "thermostat-bathroom", "attr": "setpoint", "value": 17}}],
    }))
    saved = json.loads((tmp_path / "data" / "config.json").read_text())
    rule = saved["rules"]["bathroom-setback"]
    assert rule["for"] == "3h"
    assert rule["if"]["all"][0]["op"] == "ne"  # ops use the eq/ne vocabulary
    assert rule["then"][0]["set"]["value"] == 17


def test_reload_when_file_changes(tmp_path):
    store = make_store(tmp_path)
    store.put_device(Device.model_validate(plug_doc()))
    assert store.reload_if_changed() is False

    config_path = tmp_path / "data" / "config.json"
    document = json.loads(config_path.read_text())
    document["devices"]["manual-plug"] = plug_doc("manual-plug")
    config_path.write_text(json.dumps(document))
    os.utime(config_path, (time.time() + 5, time.time() + 5))

    assert store.reload_if_changed() is True
    assert set(store.devices) == {"powerplug-terrace", "manual-plug"}
    assert store.reload_if_changed() is False
    assert any(event["action"] == "reload" for event in store.read_events())


def test_broken_config_is_reported_but_keeps_running(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "config.json").write_text("{not json")
    store = Store(data_dir, clock=FakeClock())
    with pytest.raises(ConfigError):
        store.load()

    (data_dir / "config.json").write_text(json.dumps({"devices": {"powerplug-terrace": plug_doc()}, "bogus": {}}))
    store = Store(data_dir, clock=FakeClock())
    store.load()
    assert set(store.devices) == {"powerplug-terrace"}  # unknown top-level keys are ignored


def test_invalid_document_in_config_is_rejected(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    broken = plug_doc()
    broken["attributes"]["state"]["bogus"] = True
    (data_dir / "config.json").write_text(json.dumps({"devices": {"powerplug-terrace": broken}}))
    with pytest.raises(ConfigError) as excinfo:
        Store(data_dir, clock=FakeClock()).load()
    assert "powerplug-terrace" in str(excinfo.value)


def test_events_append_filter_and_limit(tmp_path):
    clock = FakeClock()
    store = make_store(tmp_path, clock)
    store.append_event({"type": "state", "device": "powerplug-terrace", "attr": "state", "value": "ON"})
    clock.advance(60)
    store.append_event({"type": "write", "rule": "r1", "device": "powerplug-terrace", "attr": "state", "value": "OFF"})

    events = store.read_events()
    assert [event["type"] for event in events] == ["state", "write"]
    assert events[0]["ts"] == to_iso(clock.now - timedelta(seconds=60))
    assert (tmp_path / "data" / "events.jsonl").read_text().count("\n") == 2

    assert len(store.read_events(rule="r1")) == 1
    assert len(store.read_events(since=clock.now - timedelta(seconds=30))) == 1
    assert len(store.read_events(until=clock.now - timedelta(seconds=30))) == 1
    assert [event["type"] for event in store.read_events(limit=1)] == ["write"]
    assert len(store.read_events(kind="state")) == 1
    assert len(store.read_events(category="activity")) == 1
    assert len(store.read_events(category="telemetry")) == 1
    assert len(store.read_events(exclude_kinds=["state"])) == 1


def test_events_subscribe(tmp_path):
    store = make_store(tmp_path)
    received = []
    unsubscribe = store.subscribe(lambda ev: received.append(ev))
    store.append_event({"type": "test_event", "val": 123})
    assert len(received) == 1
    assert received[0]["val"] == 123

    unsubscribe()
    store.append_event({"type": "test_event", "val": 456})
    assert len(received) == 1


def test_events_file_is_capped(tmp_path):
    store = make_store(tmp_path, events_max_bytes=800)
    for index in range(200):
        store.append_event({"type": "state", "device": "d", "attr": "a", "value": index})
    lines = (tmp_path / "data" / "events.jsonl").read_text().splitlines()
    assert 0 < len(lines) < 200
    assert json.loads(lines[-1])["value"] == 199


def test_pending_timers_upsert_and_survive_restart(tmp_path):
    clock = FakeClock()
    store = make_store(tmp_path, clock)
    due = clock.now + timedelta(hours=3)
    store.put_timer({"id": "for:r1", "kind": "for", "rule": "r1", "due_at": due})
    store.put_timer({"id": "for:r1", "kind": "for", "rule": "r1", "due_at": due, "note": "replaced"})
    store.put_timer({"id": "revert:d:a", "kind": "revert", "device": "d", "attr": "a", "due_at": clock.now})
    store.set_last_fired("r1", clock.now)

    assert store.get_timer("for:r1")["note"] == "replaced"
    assert len(store.list_timers()) == 2
    assert len(store.list_timers("revert")) == 1
    assert [timer["id"] for timer in store.due_timers(clock.now)] == ["revert:d:a"]

    reloaded = Store(tmp_path / "data", clock=clock)
    reloaded.load()
    assert reloaded.get_timer("for:r1")["due_at"] == to_iso(due)
    assert to_iso(reloaded.get_last_fired("r1")) == to_iso(clock.now)
    assert reloaded.delete_timer("for:r1")["rule"] == "r1"
    assert reloaded.get_timer("for:r1") is None
    assert len(Store(tmp_path / "data", clock=clock).list_timers()) == 0


def test_events_are_written_atomically(tmp_path):
    store = make_store(tmp_path)
    store.put_device(Device.model_validate(thermostat_doc()))
    leftovers = [path.name for path in (tmp_path / "data").iterdir() if path.name.endswith(".tmp")]
    assert leftovers == []
