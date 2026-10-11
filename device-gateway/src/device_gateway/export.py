"""Deterministic binding generation and explicit conflict-reporting installation."""
import copy


async def bindings(config, adapters):
    documents = []
    for name, device in sorted(config.devices.items()):
        adapter = adapters[name]
        base = f"{config.mqtt.topic_prefix}/{name}"
        attributes = await adapter.export_attributes()
        for attr, spec in attributes.items():
            spec["read"] = {"topic": base + "/state", "path": "values." + attr}
            if attr in adapter.writable:
                spec["write"] = {"topic": base + "/set", "payload": "$v", "retain": False}
        interval = adapter.poll_interval
        documents.append({"id": name, "name": device.name, "attributes": attributes, "command": {
            "topic": base + "/set", "result_topic": base + "/result", "state_topic": base + "/state",
            "availability_topic": base + "/availability", "service_availability_topic": config.mqtt.topic_prefix + "/availability",
            "expiry": f"{config.defaults.command_ttl:g}s", "result_timeout": f"{device.result_timeout:g}s", "stale_after": f"{interval * 3:g}s",
        }})
    return documents


OWNED = {"read", "write", "type", "unit", "limits", "enum"}


def merge(existing, generated):
    """Only replace gateway-owned fields on already opted-in documents."""
    result = copy.deepcopy(existing)
    conflicts = []
    devices = result.setdefault("devices", [])
    # Automator's on-disk document collection uses dictionaries keyed by id.
    mapping = devices if isinstance(devices, dict) else {d["id"]: d for d in devices}
    for document in generated:
        old = mapping.get(document["id"])
        if old is None:
            mapping[document["id"]] = copy.deepcopy(document)
            continue
        if not old.get("command"):
            conflicts.append(f"{document['id']}: existing device has no gateway ownership; resolve explicitly")
            continue
        if old["command"]["topic"] != document["command"]["topic"]:
            conflicts.append(f"{document['id']}: command topic conflict")
            continue
        collisions = [attr for attr in document["attributes"] if attr in old.get("attributes", {})
                      and (old["attributes"][attr].get("read") or {}).get("topic") not in (None, old["command"].get("state_topic"))]
        if collisions:
            conflicts.append(f"{document['id']}: unrelated attribute read bindings: {', '.join(collisions)}")
            continue
        old["command"] = copy.deepcopy(document["command"])
        for attr, spec in document["attributes"].items():
            target = old.setdefault("attributes", {}).setdefault(attr, {})
            for field in OWNED:
                target.pop(field, None)
            target.update({key: copy.deepcopy(value) for key, value in spec.items() if key in OWNED or key not in target})
    result["devices"] = mapping if isinstance(devices, dict) else list(mapping.values())
    return result, conflicts
