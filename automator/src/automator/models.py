"""Document models: device, group and rule.

The three document kinds are plain JSON, validated here and stored verbatim by
automator.store. Cross-document checks (does this device exist, does this attribute
exist, is this value in range) live in check_rule_references and friends, because
they need the whole model, not just one document.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Annotated, Any, Literal, Mapping

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
    model_validator,
)

from .util import DurationError, format_duration, parse_duration

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
EQUALS_OPS = ("eq", "ne")
NUMERIC_OPS = ("gt", "ge", "lt", "le")
OPS = EQUALS_OPS + NUMERIC_OPS
SOLAR_EVENTS = ("sunrise", "sunset", "dusk", "dawn", "noon", "midnight")
CLOCK_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
AttrType = Literal["number", "string", "boolean"]
Op = Literal["eq", "ne", "gt", "ge", "lt", "le"]


def _duration(value: Any) -> timedelta:
    try:
        return parse_duration(value)
    except DurationError as exc:
        raise ValueError(str(exc)) from None


Duration = Annotated[
    timedelta,
    BeforeValidator(_duration),
    PlainSerializer(format_duration, return_type=str, when_used="json"),
]


class Doc(BaseModel):
    """Base class for stored documents."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def doc(self) -> dict[str, Any]:
        """The JSON document as stored on disk (aliases applied, nulls dropped)."""
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)


class ReadSpec(Doc):
    """Where an attribute's value comes from on MQTT."""

    topic: str = Field(min_length=1)
    path: str | None = None


class WriteSpec(Doc):
    """How an attribute is written back to MQTT ('$v' is the value)."""

    topic: str = Field(min_length=1)
    payload: Any = "$v"
    retain: bool = False


def render_payload(template: Any, value: Any) -> Any:
    """Substitute $v in a write payload template, preserving the value's type."""
    if isinstance(template, dict):
        return {key: render_payload(item, value) for key, item in template.items()}
    if isinstance(template, list):
        return [render_payload(item, value) for item in template]
    if isinstance(template, str):
        if template == "$v":
            return value
        if "$v" in template:
            return template.replace("$v", str(value))
    return template


class Attribute(Doc):
    """One readable/writable value of a device."""

    read: ReadSpec | None = None
    write: WriteSpec | None = None
    type: AttrType = "string"
    unit: str | None = None
    limits: tuple[float, float] | None = None
    enum: list[Any] | None = None
    scale: float = 1.0
    offset: float = 0.0
    default: Any = None

    @model_validator(mode="after")
    def _validate_shape(self) -> "Attribute":
        if self.limits is not None:
            if self.type != "number":
                raise ValueError("limits are only valid for number attributes")
            if self.limits[0] >= self.limits[1]:
                raise ValueError("limits must be [min, max] with min < max")
        if self.enum is not None:
            if not self.enum:
                raise ValueError("enum must not be empty")
            if self.type == "boolean":
                raise ValueError("enum is not valid for boolean attributes")
        if self.default is not None:
            self.coerce(self.default, for_write=True)
        return self

    def coerce(self, value: Any, *, for_write: bool = False) -> Any:
        """Convert an incoming value to this attribute's type, or raise ValueError."""
        if self.type == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                raise ValueError(f"{value!r} is not a number")
            try:
                number = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{value!r} is not a number") from None
            if for_write and self.limits is not None and not self.limits[0] <= number <= self.limits[1]:
                raise ValueError(f"{number:g} is outside limits {list(self.limits)}")
            coerced: Any = int(number) if number.is_integer() else number
        elif self.type == "boolean":
            if isinstance(value, bool):
                coerced = value
            elif isinstance(value, str) and value.strip().lower() in ("true", "1", "on", "yes"):
                coerced = True
            elif isinstance(value, str) and value.strip().lower() in ("false", "0", "off", "no"):
                coerced = False
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                coerced = bool(value)
            else:
                raise ValueError(f"{value!r} is not a boolean")
        else:
            if isinstance(value, (dict, list)):
                raise ValueError("a string attribute cannot hold an object or list")
            coerced = value if isinstance(value, str) else str(value)

        if for_write and self.enum is not None and coerced not in self.enum:
            raise ValueError(f"{coerced!r} is not one of {self.enum}")
        return coerced

    def decode(self, raw: Any) -> Any:
        """Raw MQTT payload value -> typed state value (scale/offset applied)."""
        if self.type == "number" and not isinstance(raw, bool):
            try:
                return self.coerce(float(raw) * self.scale + self.offset)
            except (TypeError, ValueError):
                raise ValueError(f"{raw!r} is not a number") from None
        return self.coerce(raw)

    def encode(self, value: Any) -> Any:
        """Typed value -> raw MQTT payload value (inverse of decode)."""
        if self.type == "number" and (self.scale != 1.0 or self.offset != 0.0):
            return (float(value) - self.offset) / self.scale
        return value

    def write_payload(self, value: Any) -> Any:
        if self.write is None:
            return None
        return render_payload(self.write.payload, self.encode(value))

    def describe(self) -> dict[str, Any]:
        return self.doc()


class CommandBinding(Doc):
    """Opt-in correlated patch transport; state is reported independently."""

    topic: str = Field(min_length=1)
    result_topic: str = Field(min_length=1)
    state_topic: str = Field(min_length=1)
    availability_topic: str = Field(min_length=1)
    service_availability_topic: str | None = None
    expiry: Duration = Field(default=timedelta(seconds=30))
    result_timeout: Duration = Field(default=timedelta(minutes=5))
    stale_after: Duration = Field(default=timedelta(minutes=10))

    @model_validator(mode="after")
    def positive(self):
        if any(value.total_seconds() <= 0 for value in (self.expiry, self.result_timeout, self.stale_after)):
            raise ValueError("command intervals must be positive")
        return self


class Device(Doc):
    """A thing with attributes, bound to MQTT topics."""

    id: str = Field(pattern=ID_PATTERN)
    name: str | None = None
    description: str | None = None
    locked: bool = False
    attributes: dict[str, Attribute] = Field(min_length=1)
    command: CommandBinding | None = None

    @model_validator(mode="after")
    def shared_transport(self):
        if self.command:
            for attribute in self.attributes.values():
                if attribute.write and (attribute.write.topic != self.command.topic or attribute.write.retain):
                    raise ValueError("gateway writable attributes must use the shared non-retained command topic")
        return self

    @field_validator("attributes")
    @classmethod
    def _validate_attribute_ids(cls, value: dict[str, Attribute]) -> dict[str, Attribute]:
        for attr in value:
            if not re.fullmatch(ID_PATTERN, attr):
                raise ValueError(f"invalid attribute id {attr!r}")
        return value


class Group(Doc):
    """A flat, write-only alias for several devices."""

    id: str = Field(pattern=ID_PATTERN)
    name: str | None = None
    members: list[str] = Field(min_length=1)

    @field_validator("members")
    @classmethod
    def _validate_members(cls, value: list[str]) -> list[str]:
        for member in value:
            if not re.fullmatch(ID_PATTERN, member):
                raise ValueError(f"invalid member id {member!r}")
        if len(set(value)) != len(value):
            raise ValueError("duplicate group members")
        return value


class ValueRef(Doc):
    """A reference to another attribute's current value."""

    device: str
    attr: str


class Term(Doc):
    """One condition term: attr <op> value."""

    attr: tuple[str, str]
    op: Op = "eq"
    value: ValueRef | bool | int | float | str


class Condition(Doc):
    """Condition tree; one level: all / any of terms."""

    all: list[Term] | None = None
    any: list[Term] | None = None

    @model_validator(mode="after")
    def _validate_shape(self) -> "Condition":
        given = [name for name in ("all", "any") if getattr(self, name) is not None]
        if len(given) != 1:
            raise ValueError("condition must have exactly one of 'all' or 'any'")
        terms = self.all if self.all is not None else self.any
        if not terms:
            raise ValueError(f"'{given[0]}' must not be empty")
        return self

    def terms(self) -> list[Term]:
        return list(self.all if self.all is not None else (self.any or []))


class When(Doc):
    """The single trigger of a rule."""

    device: str | None = None
    attr: str | None = None
    changed: bool = False
    at: str | None = None
    offset: str | None = None
    days: list[str] | None = None
    every: Duration | None = None

    @model_validator(mode="after")
    def _validate_shape(self) -> "When":
        kinds = [self.device is not None, self.at is not None, self.every is not None]
        if sum(kinds) != 1:
            raise ValueError("'when' needs exactly one of device/attr, at or every")
        if self.device is None and self.attr is not None:
            raise ValueError("'attr' requires 'device'")
        if self.device is not None and self.attr is None:
            raise ValueError("'device' requires 'attr'")
        if self.attr is not None and self.changed is False and self.device is None:
            raise ValueError("'changed' requires a device trigger")
        if self.days is not None:
            if self.at is None:
                raise ValueError("'days' is only valid with 'at'")
            if not self.days:
                raise ValueError("'days' must not be empty")
            for day in self.days:
                if day not in DAYS:
                    raise ValueError(f"invalid day {day!r}, expected one of {list(DAYS)}")
        if self.offset is not None:
            if self.at is None:
                raise ValueError("'offset' is only valid with 'at'")
            try:
                parse_duration(self.offset, allow_negative=True)
            except DurationError as exc:
                raise ValueError(str(exc)) from None
            if self.at not in SOLAR_EVENTS:
                raise ValueError("'offset' is only supported for solar triggers")
        if self.at is not None and self.at not in SOLAR_EVENTS and not CLOCK_RE.match(self.at):
            raise ValueError(f"invalid 'at' {self.at!r}, expected HH:MM or one of {list(SOLAR_EVENTS)}")
        return self

    @property
    def kind(self) -> str:
        if self.device is not None:
            return "state"
        if self.at is not None:
            return "at"
        return "every"


class SetAction(Doc):
    """Set one attribute on a device or on every member of a group."""

    device: str | None = None
    group: str | None = None
    attr: str
    value: ValueRef | bool | int | float | str
    revert_after: Duration | None = None

    @model_validator(mode="after")
    def _validate_shape(self) -> "SetAction":
        if (self.device is None) == (self.group is None):
            raise ValueError("'set' needs exactly one of device or group")
        return self


class CurveAction(Doc):
    """Set an attribute from a linear interpolation over another value."""

    device: str | None = None
    group: str | None = None
    attr: str
    x: ValueRef
    points: list[tuple[float, float]] = Field(min_length=2)

    @model_validator(mode="after")
    def _validate_shape(self) -> "CurveAction":
        if (self.device is None) == (self.group is None):
            raise ValueError("'set_curve' needs exactly one of device or group")
        xs = [point[0] for point in self.points]
        if any(b <= a for a, b in zip(xs, xs[1:])):
            raise ValueError("curve points must be sorted by strictly increasing x")
        return self


class PublishAction(Doc):
    """Raw MQTT escape hatch for anything not modelled as a device."""

    topic: str = Field(min_length=1)
    payload: Any = None
    retain: bool = False


class Action(Doc):
    """One of set / set_curve / publish."""

    set: SetAction | None = None
    set_curve: CurveAction | None = None
    publish: PublishAction | None = None

    @model_validator(mode="after")
    def _validate_shape(self) -> "Action":
        given = [name for name in ("set", "set_curve", "publish") if getattr(self, name) is not None]
        if len(given) != 1:
            raise ValueError("action must have exactly one of 'set', 'set_curve' or 'publish'")
        return self

    @property
    def kind(self) -> str:
        for name in ("set", "set_curve", "publish"):
            if getattr(self, name) is not None:
                return name
        raise AssertionError("unreachable")


class Rule(Doc):
    """when / if / for / then."""

    id: str = Field(pattern=ID_PATTERN)
    name: str | None = None
    description: str | None = None
    enabled: bool = True
    priority: int = 0
    once: bool = False
    when: When
    if_: Condition | None = Field(default=None, alias="if")
    for_: Duration | None = Field(default=None, alias="for")
    then: list[Action] = Field(min_length=1)
    rate_limit: float = Field(default=1.0, ge=0)

    def trigger_targets(self) -> list[tuple[str, str]]:
        if self.when.device is not None and self.when.attr is not None:
            return [(self.when.device, self.when.attr)]
        return []


class ReferenceError(ValueError):
    """Raised when a document references something that does not exist."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


def condition_refs(condition: Condition | None) -> set[tuple[str, str]]:
    refs: set[tuple[str, str]] = set()
    if condition is None:
        return refs
    for term in condition.terms():
        refs.add((term.attr[0], term.attr[1]))
        if isinstance(term.value, ValueRef):
            refs.add((term.value.device, term.value.attr))
    return refs


def action_attribute_refs(actions: list[Action]) -> set[tuple[str, str]]:
    refs: set[tuple[str, str]] = set()
    for action in actions:
        for item in (action.set, action.set_curve):
            if item is None:
                continue
            if item.device is not None:
                refs.add((item.device, item.attr))
            if isinstance(item, CurveAction):
                refs.add((item.x.device, item.x.attr))
    return refs


def rule_attribute_refs(rule: Rule) -> set[tuple[str, str]]:
    refs = set(rule.trigger_targets())
    refs |= condition_refs(rule.if_)
    refs |= action_attribute_refs(rule.then)
    return refs


def rule_device_refs(rule: Rule) -> set[str]:
    refs = {device for device, _ in rule_attribute_refs(rule)}
    if rule.when.device is not None:
        refs.add(rule.when.device)
    return refs


def rule_group_refs(rule: Rule) -> set[str]:
    refs: set[str] = set()
    for action in rule.then:
        for item in (action.set, action.set_curve):
            if item is not None and item.group is not None:
                refs.add(item.group)
    return refs


def _check_attribute(
    devices: Mapping[str, Device],
    errors: list[str],
    where: str,
    device_id: str,
    attr: str,
) -> Attribute | None:
    device = devices.get(device_id)
    if device is None:
        errors.append(f"{where}: unknown device '{device_id}'")
        return None
    attribute = device.attributes.get(attr)
    if attribute is None:
        errors.append(f"{where}: device '{device_id}' has no attribute '{attr}'")
        return None
    return attribute


def _check_target(
    devices: Mapping[str, Device],
    groups: Mapping[str, Group],
    errors: list[str],
    where: str,
    device_id: str | None,
    group_id: str | None,
    attr: str,
) -> list[tuple[str, Attribute]]:
    """Resolve a set/set_curve target to (device_id, attribute) pairs."""
    if group_id is not None:
        group = groups.get(group_id)
        if group is None:
            errors.append(f"{where}: unknown group '{group_id}'")
            return []
        resolved: list[tuple[str, Attribute]] = []
        reference: str | None = None
        for member in group.members:
            attribute = _check_attribute(devices, errors, f"{where} (group '{group_id}')", member, attr)
            if attribute is None:
                continue
            if reference is None:
                reference = attribute.type
            elif attribute.type != reference:
                errors.append(
                    f"{where} (group '{group_id}'): member '{member}' attribute '{attr}' is "
                    f"{attribute.type}, expected {reference}"
                )
            resolved.append((member, attribute))
        return resolved

    if device_id is None:
        errors.append(f"{where}: no device or group given")
        return []
    attribute = _check_attribute(devices, errors, where, device_id, attr)
    return [] if attribute is None else [(device_id, attribute)]


def check_rule_references(
    rule: Rule,
    devices: Mapping[str, Device],
    groups: Mapping[str, Group],
) -> list[str]:
    """Return a list of human readable problems with a rule's references and values."""
    errors: list[str] = []

    if rule.when.device is not None and rule.when.attr is not None:
        _check_attribute(devices, errors, "when", rule.when.device, rule.when.attr)

    for condition_name, condition in (("if", rule.if_),):
        if condition is None:
            continue
        for index, term in enumerate(condition.terms()):
            where = f"{condition_name}[{index}]"
            left: Attribute | None = None
            if len(term.attr) != 2:
                errors.append(f"{where}: attr must be [device, attr]")
            else:
                left = _check_attribute(devices, errors, where, term.attr[0], term.attr[1])
            if left is not None and term.op in NUMERIC_OPS and left.type != "number":
                errors.append(f"{where}: operator '{term.op}' requires a number attribute")
            if isinstance(term.value, ValueRef):
                right = _check_attribute(devices, errors, where, term.value.device, term.value.attr)
                if left is not None and right is not None and term.op in NUMERIC_OPS and right.type != "number":
                    errors.append(f"{where}: comparison value {term.value.device}.{term.value.attr} is not a number")
            elif left is not None:
                try:
                    left.coerce(term.value)
                except ValueError as exc:
                    errors.append(f"{where}: {exc}")

    for index, action in enumerate(rule.then):
        where = f"then[{index}]"
        if action.set is not None:
            item = action.set
            resolved = _check_target(devices, groups, errors, where, item.device, item.group, item.attr)
            if isinstance(item.value, ValueRef):
                _check_attribute(devices, errors, where, item.value.device, item.value.attr)
            else:
                for device_id, attribute in resolved:
                    try:
                        attribute.coerce(item.value, for_write=True)
                    except ValueError as exc:
                        errors.append(f"{where}: {device_id}.{item.attr}: {exc}")
        elif action.set_curve is not None:
            item = action.set_curve
            resolved = _check_target(devices, groups, errors, where, item.device, item.group, item.attr)
            for device_id, attribute in resolved:
                if attribute.type != "number":
                    errors.append(f"{where}: {device_id}.{item.attr} is not a number attribute")
            _check_attribute(devices, errors, where, item.x.device, item.x.attr)
        elif action.publish is not None and not action.publish.topic.strip():
            errors.append(f"{where}: publish topic must not be empty")

    return errors


def check_group_references(group: Group, devices: Mapping[str, Device]) -> list[str]:
    return [f"members[{index}]: unknown device '{member}'" for index, member in enumerate(group.members) if member not in devices]


def rules_referencing_device(rules: Mapping[str, Rule], device_id: str) -> list[str]:
    return sorted(rule.id for rule in rules.values() if device_id in rule_device_refs(rule))


def rules_referencing_group(rules: Mapping[str, Rule], group_id: str) -> list[str]:
    return sorted(rule.id for rule in rules.values() if group_id in rule_group_refs(rule))


def rules_referencing_attribute(rules: Mapping[str, Rule], device_id: str, attr: str) -> list[str]:
    return sorted(rule.id for rule in rules.values() if (device_id, attr) in rule_attribute_refs(rule))


def groups_containing_device(groups: Mapping[str, Group], device_id: str) -> list[str]:
    return sorted(group.id for group in groups.values() if device_id in group.members)


def interpolate(points: list[tuple[float, float]], x: float) -> float:
    """Piecewise linear interpolation, clamped to the outermost points."""
    if x <= points[0][0]:
        return points[0][1]
    if x >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= x <= x1:
            ratio = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
            return y0 + ratio * (y1 - y0)
    return points[-1][1]
