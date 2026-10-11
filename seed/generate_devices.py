"""Generate seed/devices.json from the live configuration of the three sources.

Not a runtime feature: run it by hand, review the diff, commit the result.

    # names, types, units, limits and enums derived from the source configs
    uv run python seed/generate_devices.py \
        --zwave-store /path/to/zwave-js-ui/store \
        --zigbee-config /path/to/configuration.yaml --zigbee-devices /path/to/devices.yaml \
        --zigbee-inventory /path/to/bridge-devices.json \
        --sniff-topics /tmp/capture.txt --groups

Where the data comes from:

* **zwave-js-ui** store: `nodes.json` (node names), `<driver>.json` (node ids) and
  `<driver>.metadata.jsonl` (label, type, unit, min/max, states, read/write per value).
  Topics are built exactly like zwave-js-ui's Gateway.valueTopic() does for
  `GATEWAY_TYPE.VALUEID` + `nodeNames`: `<prefix>/<node>/<cc>/<endpoint>/<property>[/<key>]`
  with `removeSlash` and `sanitizeTopic` applied.
* **zigbee2mqtt**: `configuration.yaml` (mqtt.base_topic), `devices.yaml` (friendly names) and
  the retained `<base>/bridge/devices` inventory, whose `exposes` give type/unit/limits/enum
  and whether an attribute can be written (access bit 2).
* **home-metrics** flattened topics (`home/<sensor>/<metric>`) are read from an MQTT capture,
  because those names come from its own code rather than its config.

A capture (`--sniff-topics`, one `topic<TAB>payload` per line) is only used to (a) pick up the
home/ metrics, (b) cross-check derived zwave topics (`--verify-topics`) and (c) as a fallback
for sources whose config is not available. Existing seed entries win per attribute, so
hand-tuned limits, defaults, enums and aliases survive a regeneration.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

SEED_DIR = Path(__file__).resolve().parent
DEFAULT_TOPICS = ("zigbee2mqtt/#", "zwave/#", "home/#")

# ---------------------------------------------------------------- zwave-js-ui

# command classes that carry house state; everything else (configuration, version,
# manufacturer, wake up, ...) is interview bookkeeping
ZWAVE_KEEP_CLASSES = {37, 38, 48, 49, 50, 64, 67, 68, 113, 128}
ZWAVE_SKIP_PROPERTIES = {
    "interviewComplete",
    "reset",
    "Time",
    "type",
    "supportedModes",
    "supportedSetpointTypes",
    "setpointScale",
    "supportsReset",
    "supportedScales",
    "supportedRateTypes",
    "supportedSensorTypes",
    "manufacturerData",
    "aggregatedEndpointMembers",
    "lastActive",
}
ZWAVE_SKIP_NODE_IDS = {1}  # the controller/stick
ZWAVE_SKIP_LABEL_PREFIX = ("UNKNOWN",)
ZWAVE_CLASS_UNITS = {128: "%"}
# classes whose values take a '<topic>/set' write even when no metadata was cached for them
ZWAVE_WRITABLE_CLASSES = {37, 38}
ZWAVE_WRITABLE_PROPERTIES = ("setpoint", "mode", "currentvalue", "targetvalue")

# ------------------------------------------------------------------- zigbee2mqtt

Z2M_PREFIX = "zigbee2mqtt/"
Z2M_SKIP_SUFFIXES = ("/set", "/get", "/availability")
Z2M_SKIP_EXPOSES = {"identify"}
Z2M_WRITABLE = {
    "state",
    "brightness",
    "color",
    "color_temp",
    "switch",
    "position",
    "current_heating_setpoint",
    "occupied_heating_setpoint",
    "temperature_setpoint",
    "system_mode",
    "preset",
    "fan_mode",
    "mode",
}

# ----------------------------------------------------------------- home-metrics

HOME_PREFIX = "home/"

UNIT_ALIASES = {"°C": "C", "C": "C", "celsius": "C", "lqi": None}
UNIT_HINTS = (
    ("temperature", "C"),
    ("humidity", "%"),
    ("pressure", "hPa"),
    ("battery", "%"),
    ("consumption", "kWh"),
    ("power", "W"),
    ("energy", "kWh"),
    ("voltage", "V"),
    ("current", "A"),
    ("illuminance", "lux"),
)
UNIT_SUFFIXES = (("_celsius", "C"), ("_kwh", "kWh"), ("_w", "W"), ("_v", "V"), ("_a", "A"), ("_percent", "%"))
ZWAVE_UNIT_BY_LABEL = {"air temperature": "C", "illuminance": "lux"}


def slug(text: str) -> str:
    """Topic segment -> document id ('Air_temperature' -> 'air-temperature')."""
    split = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", str(text).strip())
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", split.replace("_", "-")).strip("-").lower()
    cleaned = re.sub(r"-+", "-", cleaned)
    return cleaned or "unnamed"


def infer_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return "string"


def normalize_unit(unit: Any) -> str | None:
    if not isinstance(unit, str) or not unit.strip():
        return None
    return UNIT_ALIASES.get(unit, unit.strip())


def unit_for(name: str) -> str | None:
    lowered = name.lower()
    for hint, unit in UNIT_HINTS:
        if hint in lowered:
            return unit
    for suffix, unit in UNIT_SUFFIXES:
        if lowered.endswith(suffix):
            return unit
    return None


def remove_slash(text: Any) -> str:
    """zwave-js-ui utils.removeSlash."""
    return str(text).replace("/", "-")


def sanitize_topic(text: Any) -> str:
    """zwave-js-ui utils.sanitizeTopic: whitespace -> '_', drop unsupported characters."""
    value = str(text)
    value = re.sub(r"\s", "_", value)
    return re.sub(r"[^A-Za-z0-9-_À-ÖØ-öø-ÿ/]", "", value)


def merge_attribute(existing: dict[str, Any], discovered: dict[str, Any]) -> dict[str, Any]:
    """Keep the hand-tuned parts of a seed attribute, fill in the rest."""
    merged = dict(existing)
    for key, value in discovered.items():
        if key == "read":
            merged.setdefault("read", value)
            if merged["read"].get("path") is None and value.get("path"):
                merged["read"] = value
        else:
            merged.setdefault(key, value)
    return merged


def read_jsonl(path: Path, *, with_timestamp: bool = False) -> dict[tuple, Any]:
    """Read a zwave-js cache jsonl file into {(node, cc, endpoint, property, propertyKey): value}."""
    result: dict[tuple, Any] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            key = json.loads(entry["k"])
        except (ValueError, KeyError):
            continue
        value_id = (key["nodeId"], key["commandClass"], key.get("endpoint", 0), key.get("property"), key.get("propertyKey"))
        result[value_id] = (entry.get("v"), entry.get("ts")) if with_timestamp else entry.get("v")
    return result


def parse_simple_yaml(text: str) -> dict[str, Any]:
    """Minimal YAML reader: nested 'key: value' maps with indentation, as zigbee2mqtt writes them.

    Only what we need from configuration.yaml (mqtt.base_topic) and devices.yaml
    (friendly_name per IEEE address) - no dependency on PyYAML, so this runs in a thin pod.
    """
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        key, separator, value = line.strip().partition(":")
        if not separator:
            continue
        key = key.strip().strip("'\"")
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1] if stack else root
        value = value.strip()
        if not value:
            child: dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
            continue
        if value.startswith("'") and value.endswith("'") and len(value) > 1:
            parsed: Any = value[1:-1]
        elif value.startswith('"') and value.endswith('"') and len(value) > 1:
            parsed = value[1:-1]
        elif value.startswith("[") and value.endswith("]"):
            parsed = [item.strip().strip("'\"") for item in value[1:-1].split(",") if item.strip()]
        elif value in ("true", "false"):
            parsed = value == "true"
        elif re.fullmatch(r"-?\d+", value):
            parsed = int(value)
        else:
            parsed = value
        parent[key] = parsed
    return root


def zwave_value_topic(prefix: str, node_name: str, value_id: tuple) -> str:
    """Exactly zwave-js-ui Gateway.valueTopic() for GATEWAY_TYPE.VALUEID."""
    _node_id, command_class, endpoint, prop, property_key = value_id
    parts = [prefix, node_name, str(command_class), str(endpoint or 0), remove_slash(prop)]
    if property_key is not None:
        parts.append(remove_slash(property_key))
    return "/".join(sanitize_topic(part) for part in parts)


def zwave_attribute_name(meta: dict[str, Any], value_id: tuple) -> str:
    """Readable attribute id: the zwave-js label, or the property for labelled-less values."""
    _node_id, command_class, _endpoint, prop, property_key = value_id
    label = str(meta.get("label") or "").strip()
    if command_class == 50:
        # meter: the property is always 'value', the label carries the meaning, the unit disambiguates
        base = slug(re.sub(r"\[[^\]]*\]", " ", label) or prop)
        unit = normalize_unit(meta.get("unit"))
        token = re.sub(r"[^a-z0-9]+", "", unit.lower()) if unit else ""
        if token and token not in base:
            base = f"{base}-{token}"
        return base
    base = slug(label or prop)
    if property_key is not None and str(property_key) not in label:
        base = f"{base}-{slug(property_key)}" if not str(property_key).isdigit() else f"{base}-{property_key}"
    return base


def zwave_store_devices(
    store_dir: Path,
    *,
    observed: set[str] | None = None,
    verify: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Derive zwave devices from the zwave-js-ui store, using an MQTT capture to disambiguate.

    The store is the authority for names, topics and metadata. A capture of published topics is
    used for one thing only: zwave-js keeps *mirrored* values on the root endpoint of
    multi-channel devices (a thermostat reports the same setpoint on endpoint 0 and 1), and only
    one of them is actually published. When a property exists at several endpoints and the capture
    saw some of them, those are the ones kept; a value that exists at a single endpoint is always
    kept, even if it did not change while the capture was running.
    """
    store_dir = Path(store_dir)
    settings: dict[str, Any] = {}
    settings_file = store_dir / "settings.json"
    if settings_file.exists():
        settings = json.loads(settings_file.read_text(encoding="utf-8"))
    prefix = str(settings.get("mqtt", {}).get("prefix") or "zwave")
    gateway = settings.get("gateway", {})

    names: dict[int, str] = {}
    names_file = store_dir / "nodes.json"
    if names_file.exists():
        for node_id, entry in json.loads(names_file.read_text(encoding="utf-8")).items():
            if isinstance(entry, dict) and entry.get("name"):
                names[int(node_id)] = str(entry["name"])

    driver_files = [path for path in store_dir.glob("*.json") if path.name not in ("nodes.json", "settings.json", "scenes.json")]
    node_ids: list[int] = []
    for path in driver_files:
        try:
            content = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(content, dict) and isinstance(content.get("nodes"), dict):
            node_ids = [int(node_id) for node_id in content["nodes"]]
            break

    metadata: dict[tuple, Any] = {}
    values: dict[tuple, Any] = {}
    for path in sorted(store_dir.glob("*.metadata.jsonl")):
        metadata.update(read_jsonl(path))
    for path in sorted(store_dir.glob("*.values.jsonl")):
        values.update(read_jsonl(path, with_timestamp=True))

    # candidate values: reported by the device, usable metadata, house-state command class
    candidates: list[tuple[tuple, Any, float]] = []
    for value_id, (value, ts) in values.items():
        node_id, command_class, _endpoint, prop, _key = value_id
        if node_id in ZWAVE_SKIP_NODE_IDS or command_class not in ZWAVE_KEEP_CLASSES:
            continue
        if str(prop) in ZWAVE_SKIP_PROPERTIES or any(str(prop).startswith(prefix_) for prefix_ in ZWAVE_SKIP_LABEL_PREFIX):
            continue
        meta = metadata.get(value_id)
        if isinstance(meta, dict):
            if not meta.get("readable") or meta.get("type") not in ("number", "boolean", "string"):
                continue
            if str(meta.get("label") or "").startswith(ZWAVE_SKIP_LABEL_PREFIX):
                continue
        else:
            # zwave-js did not cache metadata for this value: fall back to the reported value
            if value is None or isinstance(value, (dict, list)):
                continue
            meta = {"type": infer_type(value)}
        candidates.append((value_id, meta, float(ts or 0)))

    # the same property can exist at several endpoints (root mirror + real channel): the one
    # updated most recently wins, ties go to the higher endpoint, the others get a suffix
    grouped: dict[tuple, list[tuple[tuple, Any, float]]] = defaultdict(list)
    for value_id, meta, ts in candidates:
        grouped[(value_id[0], value_id[1], value_id[3], value_id[4])].append((value_id, meta, ts))

    devices: dict[str, dict[str, Any]] = {node_id: {"id": device_id, "attributes": {}} for node_id, device_id in ((node_id, slug(names.get(node_id) or f"nodeID_{node_id}")) for node_id in node_ids) if node_id not in ZWAVE_SKIP_NODE_IDS}
    unconfirmed: list[str] = []

    def select(node_id: int, items: list[tuple[tuple, Any, float]]) -> list[tuple[tuple, Any, float]]:
        """Pick the endpoint(s) that are really published for one property."""
        node_name = names.get(node_id) or f"nodeID_{node_id}"
        topics = {zwave_value_topic(prefix, node_name, item[0]): item for item in items}
        seen = [item for topic, item in topics.items() if topic in (observed or set())]
        if seen:
            return seen
        node_seen = observed is not None and any(topic.startswith(f"{prefix}/{node_name}/") for topic in observed)
        if not node_seen:
            # nothing was observed for this node (it is asleep/offline): trust the store's own view
            stamps = {item[2] for item in items}
            newest = max(stamps)
            return [item for item in items if len(stamps) == 1 or item[2] == newest]
        if len({item[0][2] for item in items}) == 1:
            return items  # single endpoint: nothing to confuse it with
        stamps = {item[2] for item in items}
        newest = max(stamps)
        return [item for item in items if len(stamps) == 1 or item[2] == newest]

    for key, items in sorted(grouped.items()):
        node_id = key[0]
        device_id = slug(names.get(node_id) or f"nodeID_{node_id}")
        attributes = devices.setdefault(node_id, {"id": device_id, "attributes": {}})["attributes"]
        ranked = sorted(select(node_id, items), key=lambda item: -item[0][2])
        endpoints = {item[0][2] for item in ranked}
        for value_id, meta, _ts in ranked:
            name = zwave_attribute_name(meta, value_id)
            if len(endpoints) > 1 and value_id[2] != ranked[0][0][2]:
                name = f"{name}-ep{value_id[2]}"
            if name in attributes and value_id[4] is not None and str(value_id[4]) not in name:
                name = f"{name}-{value_id[4]}"
            suffix = 2
            while name in attributes:
                name = f"{name}-{suffix}"
                suffix += 1
            topic = zwave_value_topic(prefix, names.get(node_id) or f"nodeID_{node_id}", value_id)
            if verify is not None and topic not in verify.get("topics", set()):
                unconfirmed.append(topic)
            definition: dict[str, Any] = {"read": {"topic": topic, "path": "value"}, "type": str(meta.get("type"))}
            if definition["type"] == "number":
                unit = normalize_unit(meta.get("unit")) or ZWAVE_CLASS_UNITS.get(value_id[1]) or ZWAVE_UNIT_BY_LABEL.get(str(meta.get("label") or "").lower())
                if unit:
                    definition["unit"] = unit
                states = meta.get("states")
                if isinstance(states, dict) and states:
                    codes = []
                    for code in states:
                        try:
                            codes.append(int(code))
                        except ValueError:
                            codes.append(code)
                    definition["enum"] = sorted(codes, key=lambda item: (isinstance(item, str), item))
                elif isinstance(meta.get("min"), (int, float)) and isinstance(meta.get("max"), (int, float)) and meta["min"] < meta["max"]:
                    definition["limits"] = [meta["min"], meta["max"]]
            writable = bool(meta.get("writeable")) or (
                value_id[1] in ZWAVE_WRITABLE_CLASSES and any(word in str(value_id[3]).lower() for word in ZWAVE_WRITABLE_PROPERTIES)
            )
            if writable:
                definition["write"] = {"topic": f"{topic}/set", "payload": {"value": "$v"}}
            attributes[name] = definition

    for node_id, device in devices.items():
        if node_id in ZWAVE_SKIP_NODE_IDS:
            continue
        node_name = names.get(node_id) or f"nodeID_{node_id}"
        device["attributes"]["status"] = {
            "read": {"topic": f"{prefix}/{sanitize_topic(node_name)}/status", "path": "status"},
            "type": "string",
        }
        device["attributes"] = dict(sorted(device["attributes"].items()))

    result = {device["id"]: device for node_id, device in sorted(devices.items()) if node_id not in ZWAVE_SKIP_NODE_IDS and device["attributes"]}
    if verify is not None:
        verify.setdefault("unconfirmed", []).extend(unconfirmed)
    return result


# ------------------------------------------------------------------ zigbee2mqtt


def z2m_expose_attributes(entry: Any, topic: str) -> Iterable[tuple[str, dict[str, Any]]]:
    """(attribute id, definition) for one expose entry, composites expanded."""
    if not isinstance(entry, dict):
        return
    features = entry.get("features")
    if isinstance(features, list):
        for feature in features:
            yield from z2m_expose_attributes(feature, topic)
        return
    name = entry.get("name")
    prop = entry.get("property") or name
    if not prop or name in Z2M_SKIP_EXPOSES:
        return

    kind = entry.get("type")
    definition: dict[str, Any] = {"read": {"topic": topic, "path": prop}}
    if kind == "numeric":
        definition["type"] = "number"
        unit = normalize_unit(entry.get("unit"))
        if unit:
            definition["unit"] = unit
        minimum, maximum = entry.get("value_min"), entry.get("value_max")
        if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and minimum < maximum:
            definition["limits"] = [minimum, maximum]
    elif kind == "binary":
        value_on, value_off = entry.get("value_on"), entry.get("value_off")
        if isinstance(value_on, bool) or isinstance(value_off, bool):
            definition["type"] = "boolean"
        else:
            definition["type"] = "string"
            values = [value for value in (value_on, value_off) if isinstance(value, str)]
            if values:
                definition["enum"] = values
    elif kind == "enum":
        definition["type"] = "string"
        if isinstance(entry.get("values"), list):
            definition["enum"] = [value for value in entry["values"] if not isinstance(value, (dict, list))]
    else:
        definition["type"] = "string"

    if int(entry.get("access") or 0) & 2:
        definition["write"] = {"topic": f"{topic}/set", "payload": {prop: "$v"}}
    yield slug(prop), definition


def zigbee_config(config_path: Path | None, devices_path: Path | None) -> tuple[str, dict[str, str]]:
    """(base topic, {friendly name: ieee address}) from zigbee2mqtt's own configuration."""
    base_topic = Z2M_PREFIX.rstrip("/")
    if config_path is not None and Path(config_path).exists():
        config = parse_simple_yaml(Path(config_path).read_text(encoding="utf-8"))
        base_topic = str((config.get("mqtt") or {}).get("base_topic") or base_topic)
    addresses: dict[str, str] = {}
    if devices_path is not None and Path(devices_path).exists():
        devices = parse_simple_yaml(Path(devices_path).read_text(encoding="utf-8"))
        for address, entry in devices.items():
            if isinstance(entry, dict) and entry.get("friendly_name"):
                addresses[str(entry["friendly_name"])] = str(address)
    return base_topic, addresses


def z2m_devices(
    messages: dict[str, Any],
    devices: dict[str, dict[str, Any]],
    *,
    inventory: list[Any] | None = None,
    base_topic: str = Z2M_PREFIX.rstrip("/"),
) -> None:
    inventory = inventory if inventory is not None else messages.get(f"{base_topic}/bridge/devices")
    if isinstance(inventory, list):
        for entry in inventory:
            if not isinstance(entry, dict) or entry.get("type") == "Coordinator":
                continue
            name = entry.get("friendly_name")
            if not name or not isinstance(entry.get("definition"), dict):
                continue
            device_id = slug(name)
            attributes = devices.setdefault(device_id, {"id": device_id, "attributes": {}})["attributes"]
            for expose in entry["definition"].get("exposes") or []:
                for attr_id, definition in z2m_expose_attributes(expose, f"{base_topic}/{name}"):
                    attributes[attr_id] = merge_attribute(attributes.get(attr_id, {}), definition)

    # whatever devices published while we listened (fallback for inventory-less setups)
    for topic, payload in sorted(messages.items()):
        parts = topic.split("/")
        if not topic.startswith(f"{base_topic}/") or len(parts) != 2 or not isinstance(payload, dict):
            continue
        if parts[1] == "bridge" or any(topic.endswith(suffix) for suffix in Z2M_SKIP_SUFFIXES):
            continue
        device_id = slug(parts[1])
        attributes = devices.setdefault(device_id, {"id": device_id, "attributes": {}})["attributes"]
        for key, value in payload.items():
            if value is None or isinstance(value, (dict, list)):
                continue
            definition: dict[str, Any] = {"read": {"topic": topic, "path": key}, "type": infer_type(value)}
            if definition["type"] == "number":
                unit = unit_for(key)
                if unit:
                    definition["unit"] = unit
            elif definition["type"] == "string" and str(value) in ("ON", "OFF"):
                definition["enum"] = ["ON", "OFF"]
            if key in Z2M_WRITABLE:
                definition["write"] = {"topic": f"{topic}/set", "payload": {key: "$v"}}
            attributes.setdefault(slug(key), definition)


# --------------------------------------------------------------- home-metrics


def home_devices(messages: dict[str, Any], devices: dict[str, dict[str, Any]]) -> None:
    for topic, payload in sorted(messages.items()):
        parts = topic.split("/")
        if not topic.startswith(HOME_PREFIX) or len(parts) != 3 or isinstance(payload, (dict, list)):
            continue
        device_id = slug(parts[1])
        attributes = devices.setdefault(device_id, {"id": device_id, "attributes": {}})["attributes"]
        metric = slug(parts[2])
        definition: dict[str, Any] = {"read": {"topic": topic}, "type": infer_type(payload)}
        if definition["type"] == "number":
            unit = unit_for(metric)
            if unit:
                definition["unit"] = unit
        attributes[metric] = merge_attribute(attributes.get(metric, {}), definition)


def build_devices(
    messages: dict[str, Any],
    *,
    zwave_store: Path | None = None,
    zigbee_inventory: list[Any] | None = None,
    zigbee_base_topic: str = Z2M_PREFIX.rstrip("/"),
    observed: set[str] | None = None,
    verify: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Turn captured topics plus source configurations into device documents."""
    devices: dict[str, dict[str, Any]] = {}
    if zwave_store is not None:
        devices.update(zwave_store_devices(zwave_store, observed=observed, verify=verify))
    z2m_devices(messages, devices, inventory=zigbee_inventory, base_topic=zigbee_base_topic)
    home_devices(messages, devices)
    for device_id, device in devices.items():
        if not device["attributes"]:
            device["attributes"] = {"value": {"read": {"topic": ""}, "type": "string"}}
        device["attributes"] = dict(sorted(device["attributes"].items()))
    return dict(sorted(devices.items()))


def build_groups(devices: dict[str, dict[str, Any]], *, min_members: int = 2) -> dict[str, dict[str, Any]]:
    """Group ids sharing a prefix ('powerplug-1-kitchen' + '-2' -> 'powerplug')."""
    buckets: dict[str, list[str]] = defaultdict(list)
    for device_id in devices:
        if "-" not in device_id:
            continue
        buckets[device_id.split("-")[0]].append(device_id)
    groups = {}
    for prefix, members in sorted(buckets.items()):
        shared = None
        for member in sorted(members):
            attributes = {name for name, definition in devices[member]["attributes"].items() if definition.get("write")}
            shared = attributes if shared is None else (shared & attributes)
        if len(members) >= min_members and shared:
            groups[prefix] = {"id": prefix, "name": prefix.replace("-", " ").capitalize(), "members": sorted(members)}
    return groups


# ----------------------------------------------------------------- discovery


async def collect(host: str, port: int, topics: Iterable[str], duration: float, *, username=None, password=None) -> dict[str, Any]:
    """Listen for a while and keep the last payload per topic (aiomqtt 1.x and 2.x)."""
    import aiomqtt  # imported here so the pure helpers work without a broker

    messages: dict[str, Any] = {}

    async def consume(stream: Any) -> None:
        async for message in stream:
            payload = message.payload
            text = payload.decode("utf-8", errors="replace") if isinstance(payload, (bytes, bytearray)) else str(payload)
            topic = str(getattr(message.topic, "value", message.topic))
            try:
                messages[topic] = json.loads(text.strip())
            except json.JSONDecodeError:
                messages[topic] = text.strip()

    async with aiomqtt.Client(hostname=host, port=port, username=username, password=password) as client:
        for topic in topics:
            await client.subscribe(topic)
        try:
            async with asyncio.timeout(duration):
                raw = client.messages
                candidate = raw() if callable(raw) else raw
                if hasattr(candidate, "__aenter__"):
                    async with candidate as stream:
                        await consume(stream)
                else:
                    await consume(candidate)
        except TimeoutError:
            pass
    return messages


def load_capture(path: Path) -> tuple[dict[str, Any], set[str]]:
    """Read a 'topic<TAB>payload' capture; returns (messages, topics)."""
    messages: dict[str, Any] = {}
    topics: set[str] = set()
    if not Path(path).exists():
        return messages, topics
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        topic, _, payload = line.partition("\t")
        topic = topic.strip()
        if not topic:
            continue
        topics.add(topic)
        try:
            messages[topic] = json.loads(payload)
        except json.JSONDecodeError:
            messages[topic] = payload.strip()
    return messages, topics


def load_existing(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def merge_devices(existing: dict[str, dict[str, Any]], discovered: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Union, existing document winning per attribute (and per bound topic)."""
    merged = {device_id: dict(document) for device_id, document in existing.items()}
    for device_id, document in discovered.items():
        if device_id not in merged:
            merged[device_id] = document
            continue
        target = dict(merged[device_id])
        attributes = dict(target.get("attributes", {}))
        bound = {json.dumps(definition.get("read"), sort_keys=True) for definition in attributes.values()}
        for attr, definition in document.get("attributes", {}).items():
            binding = json.dumps(definition.get("read"), sort_keys=True)
            if attr not in attributes and binding in bound:
                continue  # the same topic is already covered by a hand-written alias
            attributes[attr] = merge_attribute(attributes.get(attr, {}), definition)
            bound.add(binding)
        target["attributes"] = dict(sorted(attributes.items()))
        merged[device_id] = target
    return dict(sorted(merged.items()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Derive seed/devices.json from the configuration of the MQTT sources. Not a runtime feature.",
        epilog=(
            "Sources: --zwave-store (zwave-js-ui store: names, metadata, topics), "
            "--zigbee-config/--zigbee-devices/--zigbee-inventory (zigbee2mqtt config and bridge inventory), "
            "--sniff-topics (a 'topic<TAB>payload' capture, used for the home/ metrics and to disambiguate "
            "zwave root-endpoint mirrors), or listen with --mqtt/--duration. Existing seed entries win per "
            "attribute, so hand-tuned values survive. Review the diff and commit the result."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--mqtt", default="mosquitto", help="broker host or mqtt://user:pass@host:1883")
    parser.add_argument("--topics", default=",".join(DEFAULT_TOPICS))
    parser.add_argument("--duration", type=float, default=120.0, help="how long to listen, in seconds")
    parser.add_argument("--sniff-topics", type=Path, help="use a 'topic<TAB>payload' capture instead of listening")
    parser.add_argument("--zwave-store", type=Path, help="zwave-js-ui store directory (names, metadata)")
    parser.add_argument("--zigbee-config", type=Path, help="zigbee2mqtt configuration.yaml")
    parser.add_argument("--zigbee-devices", type=Path, help="zigbee2mqtt devices.yaml")
    parser.add_argument("--zigbee-inventory", type=Path, help="saved payload of <base>/bridge/devices")
    parser.add_argument("--devices-out", type=Path, default=SEED_DIR / "devices.json")
    parser.add_argument("--groups-out", type=Path, default=SEED_DIR / "groups.json")
    parser.add_argument("--groups", action="store_true", help="also regenerate groups.json from id prefixes")
    parser.add_argument("--no-merge", action="store_true", help="ignore the existing seed file")
    parser.add_argument("--verify-topics", action="store_true", help="report derived zwave topics that the capture never saw")
    args = parser.parse_args(argv)

    sys.path.insert(0, str(SEED_DIR.parent / "src"))
    try:
        from automator.models import Device, Group  # noqa: PLC0415
        from automator.util import atomic_write_json  # noqa: PLC0415

        validate = True
    except ImportError:  # running in a thin pod that only has aiomqtt
        validate = False

        def atomic_write_json(path: Path, payload: Any) -> None:  # type: ignore[misc]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")

    if args.sniff_topics:
        messages, captured = load_capture(args.sniff_topics)
        print(f"capture {args.sniff_topics}: {len(captured)} topics")
    else:
        topics = tuple(topic.strip() for topic in args.topics.split(",") if topic.strip())
        print(f"listening on {args.mqtt} for {args.duration:g}s: {', '.join(topics)}", flush=True)
        from automator.config import parse_mqtt_url  # noqa: PLC0415

        host, port, username, password = parse_mqtt_url(args.mqtt)
        messages = asyncio.run(collect(host, port, topics, args.duration, username=username, password=password))
        captured = set(messages)

    base_topic, addresses = zigbee_config(args.zigbee_config, args.zigbee_devices)
    if addresses:
        print(f"zigbee2mqtt base topic {base_topic!r}, {len(addresses)} names in devices.yaml")
    inventory = None
    if args.zigbee_inventory:
        inventory = json.loads(Path(args.zigbee_inventory).read_text(encoding="utf-8"))
    elif isinstance(messages.get(f"{base_topic}/bridge/devices"), list):
        inventory = messages[f"{base_topic}/bridge/devices"]

    verify: dict[str, Any] = {"topics": captured} if args.verify_topics else None
    discovered = build_devices(
        messages,
        zwave_store=args.zwave_store,
        zigbee_inventory=inventory,
        zigbee_base_topic=base_topic,
        observed=captured if args.zwave_store else None,
        verify=verify,
    )
    print(f"derived {len(discovered)} devices")

    existing = {} if args.no_merge else load_existing(args.devices_out)
    devices = merge_devices(existing, discovered)
    if validate:
        for key, document in devices.items():
            Device.model_validate({**document, "id": key})
    atomic_write_json(args.devices_out, devices)
    print(f"wrote {args.devices_out}: {len(devices)} devices")

    if args.groups:
        groups = load_existing(args.groups_out)
        groups.update(build_groups(devices))
        if validate:
            for key, document in groups.items():
                Group.model_validate({**document, "id": key})
        atomic_write_json(args.groups_out, groups)
        print(f"wrote {args.groups_out}: {len(groups)} groups")

    if verify is not None:
        unconfirmed = sorted(set(verify.get("unconfirmed", [])))
        print(f"zwave topics the capture never saw: {len(unconfirmed)}")
        for topic in unconfirmed[:20]:
            print("   ?", topic)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
