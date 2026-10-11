"""State store and the (device, attr) -> rules index - plan task 5."""

from __future__ import annotations

import json
import os
import time

from automator.models import Rule
from automator.state import UNSET
from support import add_documents, make_service, plug_doc, run


def rule_doc(rule_id: str = "r1", attr: str = "state", priority: int = 0) -> dict:
    return {
        "id": rule_id,
        "priority": priority,
        "when": {"device": "powerplug-terrace", "attr": attr},
        "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
    }


def test_state_set_reports_changes(tmp_path):
    service = make_service(tmp_path)
    add_documents(service, devices=[plug_doc()])

    assert service.state.value("powerplug-terrace", "state", UNSET) is UNSET
    assert service.state.known("powerplug-terrace", "state") is False

    assert run(service.apply_state("powerplug-terrace", "state", "ON")) is True
    assert run(service.apply_state("powerplug-terrace", "state", "ON")) is False  # de-duplicated
    assert run(service.apply_state("powerplug-terrace", "power", 12.0)) is True
    assert run(service.apply_state("powerplug-terrace", "power", 12.0000000001)) is False  # within tolerance

    assert service.state.value("powerplug-terrace", "state") == "ON"
    snapshot = service.state.snapshot()
    assert snapshot["powerplug-terrace"]["state"]["value"] == "ON"
    assert snapshot["powerplug-terrace"]["power"]["value"] == 12.0
    assert service.state.device_snapshot("powerplug-terrace")["state"]["value"] == "ON"

    service.state.forget_attribute("powerplug-terrace", "power")
    assert service.state.known("powerplug-terrace", "power") is False
    service.state.forget_device("powerplug-terrace")
    assert len(service.state) == 0


def test_index_follows_rule_edits(tmp_path):
    service = make_service(tmp_path)
    add_documents(service, devices=[plug_doc()], rules=[rule_doc()])

    assert [rule.id for rule in service.evaluator.rules_for("powerplug-terrace", "state")] == ["r1"]
    assert service.evaluator.rules_for("powerplug-terrace", "power") == []

    service.store.put_rule(Rule.model_validate(rule_doc(attr="power")))
    assert service.evaluator.rules_for("powerplug-terrace", "state") == []
    assert [rule.id for rule in service.evaluator.rules_for("powerplug-terrace", "power")] == ["r1"]

    service.store.delete_rule("r1")
    assert service.evaluator.rules_for("powerplug-terrace", "power") == []


def test_index_follows_hand_edited_config(tmp_path):
    service = make_service(tmp_path)
    add_documents(service, devices=[plug_doc()])
    assert service.evaluator.rules_for("powerplug-terrace", "power") == []

    config_path = tmp_path / "data" / "config.json"
    document = json.loads(config_path.read_text())
    document["rules"]["hand-written"] = rule_doc("hand-written", attr="power")
    config_path.write_text(json.dumps(document))
    os.utime(config_path, (time.time() + 5, time.time() + 5))

    assert service.reload_config_if_changed() is True
    assert [rule.id for rule in service.evaluator.rules_for("powerplug-terrace", "power")] == ["hand-written"]


def test_rules_are_ordered_by_priority_then_id(tmp_path):
    service = make_service(tmp_path)
    add_documents(service, devices=[plug_doc()])
    for rule_id, priority in (("b", 5), ("a", 5), ("c", 9), ("d", 0)):
        service.store.put_rule(Rule.model_validate(rule_doc(rule_id, priority=priority)))

    assert [rule.id for rule in service.evaluator.rules_for("powerplug-terrace", "state")] == ["c", "a", "b", "d"]


def test_condition_on_unknown_attribute_is_false_and_reported(tmp_path):
    service = make_service(tmp_path)
    add_documents(
        service,
        devices=[plug_doc()],
        rules=[
            {
                "id": "power-limit",
                "when": {"at": "22:00"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": 100}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "OFF"}}],
            }
        ],
    )
    rule = service.store.rules["power-limit"]
    satisfied, unknown = service.evaluator.evaluate_condition(rule.if_)
    assert satisfied is False
    assert unknown == ["powerplug-terrace.power"]

    run(service.apply_state("powerplug-terrace", "power", 150))
    satisfied, unknown = service.evaluator.evaluate_condition(rule.if_)
    assert satisfied is True
    assert unknown == []


def test_condition_operators(tmp_path):
    service = make_service(tmp_path)
    add_documents(service, devices=[plug_doc()])
    run(service.apply_state("powerplug-terrace", "power", 100))

    def check(op, value):
        rule = Rule.model_validate(
            {
                "id": "cmp",
                "when": {"at": "22:00"},
                "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": op, "value": value}]},
                "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
            }
        )
        return service.evaluator.evaluate_condition(rule.if_)[0]

    assert check("eq", 100) and check("ne", 99)
    assert check("gt", 99) and not check("gt", 100)
    assert check("ge", 100) and check("lt", 101) and check("le", 100)
    assert check("eq", 100.0)  # numbers compare numerically


def test_condition_can_reference_another_attribute(tmp_path):
    service = make_service(tmp_path)
    add_documents(service, devices=[plug_doc(), {"id": "temperature-backyard", "attributes": {"temperature": {"type": "number"}}}])
    rule = Rule.model_validate(
        {
            "id": "warmer-than-outside",
            "when": {"at": "22:00"},
            "if": {"all": [{"attr": ["powerplug-terrace", "power"], "op": "gt", "value": {"device": "temperature-backyard", "attr": "temperature"}}]},
            "then": [{"set": {"device": "powerplug-terrace", "attr": "state", "value": "ON"}}],
        }
    )
    satisfied, unknown = service.evaluator.evaluate_condition(rule.if_)
    assert satisfied is False and unknown == ["powerplug-terrace.power", "temperature-backyard.temperature"]

    run(service.apply_state("powerplug-terrace", "power", 15))
    run(service.apply_state("temperature-backyard", "temperature", 10))
    assert service.evaluator.evaluate_condition(rule.if_)[0] is True
