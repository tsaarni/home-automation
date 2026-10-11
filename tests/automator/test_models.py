"""Document models and reference checks - plan task 3."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from automator.models import (
    Device,
    Group,
    Rule,
    check_group_references,
    check_rule_references,
    groups_containing_device,
    interpolate,
    rule_attribute_refs,
    rules_referencing_attribute,
    rules_referencing_device,
    rules_referencing_group,
)
from support import group_doc, plug_doc, plug_group_members, thermostat_doc


def build_devices(*documents: dict) -> dict[str, Device]:
    return {device.id: device for device in (Device.model_validate(document) for document in documents)}


def build_groups(*documents: dict) -> dict[str, Group]:
    return {group.id: group for group in (Group.model_validate(document) for document in documents)}


def build_rule(**overrides) -> Rule:
    document = {
        "id": "r1",
        "when": {"device": "thermostat-bathroom", "attr": "setpoint", "changed": True},
        "then": [{"set": {"device": "thermostat-bathroom", "attr": "setpoint", "value": 17}}],
    }
    document.update(overrides)
    return Rule.model_validate(document)


# ------------------------------------------------------------------ happy path


def test_plan_examples_validate():
    thermostat = Device.model_validate(thermostat_doc())
    assert thermostat.attributes["setpoint"].limits == (5, 30)
    assert thermostat.attributes["setpoint"].write.topic.endswith("/set")

    plug = Device.model_validate(plug_doc())
    assert plug.attributes["state"].enum == ["ON", "OFF"]

    group = Group.model_validate(group_doc("floor-heating", ["floor-heating-a", "floor-heating-b"]))
    assert group.members == ["floor-heating-a", "floor-heating-b"]

    rule = build_rule(
        priority=100,
        **{
            "if": {"all": [{"attr": ["thermostat-bathroom", "setpoint"], "op": "ne", "value": 17}]},
            "for": "3h",
        },
    )
    assert rule.for_.total_seconds() == 3 * 3600
    assert rule.if_.terms()[0].op == "ne"


def test_rule_document_uses_json_aliases_and_round_trips():
    rule = build_rule(**{"if": {"all": [{"attr": ["thermostat-bathroom", "temperature"], "op": "lt", "value": 10}]}, "for": "90m"})
    document = rule.doc()
    assert set(document) >= {"id", "when", "if", "for", "then", "enabled", "priority", "once", "rate_limit"}
    assert document["for"] == "90m"
    assert document["if"]["all"][0] == {"attr": ["thermostat-bathroom", "temperature"], "op": "lt", "value": 10}
    assert Rule.model_validate(document).for_.total_seconds() == 90 * 60


def test_all_duration_units_round_trip():
    assert build_rule(**{"for": "45s"}).doc()["for"] == "45s"
    assert build_rule(**{"for": "15m"}).doc()["for"] == "15m"
    assert build_rule(**{"for": "3h"}).doc()["for"] == "3h"
    assert build_rule(**{"for": "2d"}).doc()["for"] == "2d"
    assert build_rule(**{"for": 600}).doc()["for"] == "10m"


def test_when_variants():
    assert build_rule(when={"device": "powerplug-terrace", "attr": "state"}).when.kind == "state"
    assert build_rule(when={"device": "powerplug-terrace", "attr": "state"}).when.changed is False
    weekly = build_rule(when={"at": "14:00", "days": ["Sat"]})
    assert weekly.when.kind == "at" and weekly.when.days == ["Sat"]
    solar = build_rule(when={"at": "dusk", "offset": "-30m"})
    assert solar.when.kind == "at"
    assert build_rule(when={"every": "15m"}).when.kind == "every"


def test_publish_and_curve_actions():
    rule = build_rule(
        then=[
            {"set_curve": {"device": "thermostat-bathroom", "attr": "setpoint", "x": {"device": "thermostat-bathroom", "attr": "temperature"}, "points": [[-20, 25], [20, 17]]}},
            {"publish": {"topic": "home/notify", "payload": {"value": "$v"}}},
        ]
    )
    assert [action.kind for action in rule.then] == ["set_curve", "publish"]


# ------------------------------------------------------------------ bad documents


@pytest.mark.parametrize(
    "overrides",
    [
        {"bogus": 1},
        {"id": "with/slash"},
        {"attributes": {}},
        {"attributes": {"a": {"limits": [1, 2]}}},
        {"attributes": {"a": {"type": "string", "limits": [1, 2]}}},
        {"attributes": {"a": {"type": "number", "limits": [5, 5]}}},
        {"attributes": {"a": {"type": "boolean", "enum": [True]}}},
        {"attributes": {"a": {"enum": []}}},
        {"attributes": {"bad id": {"type": "string"}}},
        {"attributes": {"a": {"type": "number", "default": 50, "limits": [0, 10]}}},
    ],
)
def test_bad_devices_are_rejected(overrides):
    document = {"id": "d1", "attributes": {"a": {"type": "string"}}}
    document.update(overrides)
    with pytest.raises(ValidationError):
        Device.model_validate(document)


@pytest.mark.parametrize(
    "when",
    [
        {"device": "d", "at": "22:00"},
        {"attr": "a"},
        {"device": "d"},
        {"at": "22:00", "every": "1h"},
        {"every": "1h", "days": ["Sat"]},
        {"at": "22:00", "days": ["Funday"]},
        {"at": "25:00"},
        {"at": "22:00", "offset": "-30m"},
        {"at": 1900},
    ],
)
def test_bad_triggers_are_rejected(when):
    with pytest.raises(ValidationError):
        build_rule(when=when)


@pytest.mark.parametrize(
    "overrides",
    [
        {"for": "soon"},
        {"for": "-3h"},
        {"for": ""},
        {"then": []},
        {"then": [{"set": {"device": "d", "attr": "a", "value": 1}, "publish": {"topic": "t"}}]},
        {"then": [{"publish": {"payload": 1}}]},
        {"then": [{"set": {"attr": "a", "value": 1}}]},
        {"then": [{"set": {"device": "d", "group": "g", "attr": "a", "value": 1}}]},
        {"then": [{"set": {"device": "d", "attr": "a", "value": 1, "revert_after": "later"}}]},
        {"if": {"all": [], "any": []}},
        {"if": {"all": [{"attr": ["d", "a"], "op": "like", "value": 1}]}},
        {"if": {"all": [{"attr": ["d"]}]}},
        {"then": [{"set_curve": {"device": "d", "attr": "a", "x": {"device": "d", "attr": "b"}, "points": [[1, 1]]}}]},
        {"then": [{"set_curve": {"device": "d", "attr": "a", "x": {"device": "d", "attr": "b"}, "points": [[1, 1], [0, 2]]}}]},
        {"priority": "high"},
    ],
)
def test_bad_rules_are_rejected(overrides):
    with pytest.raises(ValidationError):
        build_rule(**overrides)


@pytest.mark.parametrize(
    "members",
    [[], ["floor-heating-a", "floor-heating-a"], ["bad id"]],
)
def test_bad_groups_are_rejected(members):
    with pytest.raises(ValidationError):
        Group.model_validate(group_doc("g", members))


# --------------------------------------------------------------- reference checks


@pytest.fixture
def model():
    devices = build_devices(
        thermostat_doc(),
        plug_doc(),
        *plug_group_members(count=2),
        {"id": "temperature-backyard", "attributes": {"temperature": {"type": "number"}}},
    )
    groups = build_groups(group_doc("floor-heating", ["floor-heating-a", "floor-heating-b"]))
    return devices, groups


def test_valid_rule_passes_reference_check(model):
    devices, groups = model
    rule = build_rule(
        **{
            "when": {"device": "temperature-backyard", "attr": "temperature"},
            "if": {"any": [{"attr": ["thermostat-bathroom", "setpoint"], "op": "lt", "value": 18}]},
            "then": [{"set": {"group": "floor-heating", "attr": "state", "value": "ON"}}],
        }
    )
    assert check_rule_references(rule, devices, groups) == []


def test_reference_checks_report_every_problem(model):
    devices, groups = model
    rule = build_rule(
        when={"device": "ghost", "attr": "attr"},
        **{
            "if": {
                "all": [
                    {"attr": ["thermostat-bathroom", "nope"], "op": "eq", "value": 1},
                    {"attr": ["powerplug-terrace", "state"], "op": "gt", "value": 1},
                    {"attr": ["thermostat-bathroom", "setpoint"], "op": "eq", "value": "warm"},
                    {"attr": ["thermostat-bathroom", "setpoint"], "op": "eq", "value": {"device": "ghost", "attr": "x"}},
                    {"attr": ["thermostat-bathroom", "temperature"], "op": "lt", "value": 100},
                ]
            },
            "then": [
                {"set": {"device": "thermostat-bathroom", "attr": "setpoint", "value": 99}},
                {"set": {"group": "ghost-group", "attr": "state", "value": "ON"}},
                {"set_curve": {"device": "powerplug-terrace", "attr": "state", "x": {"device": "ghost", "attr": "y"}, "points": [[0, 1], [1, 2]]}},
            ],
        },
    )
    problems = check_rule_references(rule, devices, groups)
    joined = " | ".join(problems)
    assert "unknown device 'ghost'" in joined
    assert "has no attribute 'nope'" in joined
    assert "requires a number attribute" in joined
    assert "is not a number" in joined
    assert "outside limits" in joined
    assert "unknown group 'ghost-group'" in joined
    assert len(problems) >= 8


def test_group_members_must_share_the_attribute_and_type():
    devices = build_devices(plug_doc("floor-heating-a"), thermostat_doc("floor-heating-b"))
    groups = build_groups(group_doc("mixed", ["floor-heating-a", "floor-heating-b"]))
    rule = build_rule(then=[{"set": {"group": "mixed", "attr": "state", "value": "ON"}}])
    problems = check_rule_references(rule, devices, groups)
    assert any("has no attribute 'state'" in problem for problem in problems) or any("unknown device" in problem for problem in problems)

    groups = build_groups(group_doc("plugs", ["floor-heating-a"]))
    rule = build_rule(then=[{"set": {"group": "plugs", "attr": "state", "value": "MAYBE"}}])
    assert any("not one of" in problem for problem in check_rule_references(rule, devices, groups))


def test_group_reference_checks(model):
    devices, _groups = model
    group = Group.model_validate(group_doc("broken", ["floor-heating-a", "ghost"]))
    assert check_group_references(group, devices) == ["members[1]: unknown device 'ghost'"]


def test_reverse_lookup_helpers(model):
    devices, groups = model
    rule = build_rule(
        **{
            "if": {"all": [{"attr": ["temperature-backyard", "temperature"], "op": "gt", "value": 0}]},
            "then": [{"set": {"group": "floor-heating", "attr": "state", "value": "ON", "revert_after": "4h"}}],
        }
    )
    rules = {rule.id: rule}
    assert rules_referencing_device(rules, "thermostat-bathroom") == ["r1"]
    assert rules_referencing_device(rules, "temperature-backyard") == ["r1"]
    assert rules_referencing_group(rules, "floor-heating") == ["r1"]
    assert rules_referencing_attribute(rules, "thermostat-bathroom", "setpoint") == ["r1"]
    assert rules_referencing_attribute(rules, "thermostat-bathroom", "temperature") == []
    assert ("thermostat-bathroom", "setpoint") in rule_attribute_refs(rule)
    assert ("floor-heating-a", "state") not in rule_attribute_refs(rule)  # group members expand at run time
    assert groups_containing_device(groups, "floor-heating-b") == ["floor-heating"]


def test_interpolation():
    points = [(-20, 25), (-5, 23), (0, 21), (10, 19), (20, 17)]
    assert interpolate(points, -30) == 25
    assert interpolate(points, -20) == 25
    assert interpolate(points, -10) == pytest.approx(23.667, abs=1e-3)
    assert interpolate(points, 15) == 18
    assert interpolate(points, 100) == 17
