"""Gateway intent tracking. Only independent snapshots enter the rule state path."""
from datetime import datetime, timedelta
import uuid

from .state import values_equal

TERMINAL = {"confirmed", "reported", "failed", "unconfirmed"}
OUTCOMES = TERMINAL | {"accepted"}


class CommandTransport:
    def __init__(self, service):
        self.service = service
        self.pending = {}
        self.latest = {}
        self.observations = {}
        self.availability = {}
        self.service_availability = {}
        self.outcomes = {}

    def recover_audit(self):
        requests = {}
        terminal = set()
        for event in self.service.store.read_events(limit=self.service.settings.events_memory):
            key = event.get("request_id")
            if not key:
                continue
            if event.get("status") in TERMINAL:
                terminal.add(key)
            elif event.get("status") in ("pending", "accepted"):
                requests[key] = event
        for key, event in requests.items():
            if key not in terminal:
                self.service.store.append_event({"type": "command_result", "device": event.get("device"), "request_id": key, "status": "unconfirmed", "reason": "restart_without_result"})

    def intent(self, device, attr):
        key = self.latest.get((device, attr))
        request = self.pending.get(key)
        if request and attr in request["active"]:
            return {"request_id": key, "value": request["values"][attr], "status": request["status"], "revert_after": request["durations"].get(attr)}
        return None

    def describe(self, device):
        self.expire()
        configured = self.service.store.devices.get(device)
        if not configured or not configured.command:
            return {}
        available = self.availability.get(device, {"available": False})
        service_online = self.service_availability.get(configured.command.service_availability_topic, True)
        available = {**available, "available": available["available"] and service_online}
        return {"pending": {attr: {k: v for k, v in intent.items() if k != "revert_after"} for attr in configured.attributes if (intent := self.intent(device, attr))},
                "availability": available,
                "command_results": self.outcomes.get(device, {})}

    def expire(self):
        now = self.service.clock()
        for device in self.service.store.devices.values():
            if not device.command:
                continue
            observation = self.observations.get(device.id)
            if observation and now - observation > device.command.stale_after:
                self.service.state.forget_device(device.id)
                self.availability[device.id] = {"available": False, "reason": "stale"}
        for key, request in list(self.pending.items()):
            if now >= request["deadline"]:
                self.finish(key, "unconfirmed", "result_timeout")

    def finish(self, key, status, reason=None):
        request = self.pending.get(key)
        if not request:
            return
        for attr, value in request["values"].items():
            event = {"rule": request["audit"].get(attr, {}).get("rule"), "source": request["audit"].get(attr, {}).get("source"), "type": "command_result", "device": request["device"], "attr": attr, "value": value, "request_id": key, "status": status, "reason": reason}
            self.service.store.append_event(event)
            if self.latest.get((request["device"], attr)) == key:
                self.outcomes.setdefault(request["device"], {})[attr] = event
            if status == "failed":
                self.service.store.delete_timers(lambda timer: timer.get("request_id") == key and timer.get("attr") == attr)
        if status in TERMINAL:
            del self.pending[key]
        else:
            request["status"] = status

    async def apply(self, writes, dry_run=None):
        svc = self.service
        results = [svc.resolve_write(write) for write in writes]
        # Validate the entire patch before publication, including fields suppressed as unchanged.
        if any(result["status"] in ("error", "skipped") for result in results):
            return [svc._record_write(result if result["status"] in ("error", "skipped") else {**result, "status": "skipped", "reason": "invalid_patch"}) for result in results]
        active = [(write, result) for write, result in zip(writes, results) if result["status"] == "applied"]
        if not active:
            return [svc._record_write(result) for result in results]
        if svc.dry_run if dry_run is None else dry_run:
            return [svc._record_write({**result, "status": "dry-run"}) for result in results]
        binding = svc.store.devices[writes[0].device].command
        if len(self.pending) >= 1024:
            return [svc._record_write({**result, "status": "error", "reason": "pending_capacity"}) for result in results]
        key = str(uuid.uuid4())
        # Include unchanged fields in a combined patch: mode-only validation must see the requested setpoint.
        values = {result["attr"]: result["value"] for result in results}
        request = {"device": writes[0].device, "values": values, "active": set(values), "durations": {write.attr: write.revert_after for write in writes}, "audit": {result["attr"]: result.copy() for result in results}, "status": "pending", "deadline": svc.clock() + binding.result_timeout}
        self.pending[key] = request
        previous_latest = {attr: self.latest.get((writes[0].device, attr)) for attr in values}
        for attr in values:
            self.latest[(writes[0].device, attr)] = key
        try:
            await svc.gateway.publish(binding.topic, {"request_id": key, "values": values, "expires_at": (svc.clock() + binding.expiry).isoformat()}, retain=False)
            svc.metrics.inc("publishes_total")
        except Exception as exc:
            del self.pending[key]
            for attr, previous in previous_latest.items():
                if previous:
                    self.latest[(writes[0].device, attr)] = previous
                else:
                    self.latest.pop((writes[0].device, attr), None)
            return [svc._record_write({**result, "status": "error", "reason": f"publish_failed: {exc}"}) for result in results]
        for attr, previous in previous_latest.items():
            if previous in self.pending:
                self.pending[previous]["active"].discard(attr)
        for write, result in zip(writes, results):
            result.update(status="pending", request_id=key, topic=binding.topic)
            if not write.is_revert:
                svc.store.delete_timers(lambda timer: timer.get("kind") == "revert" and timer.get("device") == write.device and timer.get("attr") == write.attr)
                if write.revert_after:
                    svc._arm_revert(write, result)
            svc._record_write(result)
        return results

    async def handle(self, topic, payload):
        svc = self.service
        devices = [d for d in svc.store.devices.values() if d.command]
        matching = [d for d in devices if topic in (d.command.state_topic, d.command.result_topic, d.command.availability_topic, d.command.service_availability_topic)]
        if not matching:
            return False, []
        changes = []
        async with svc.critical():
            for device in matching:
                binding = device.command
                if not isinstance(payload, dict):
                    continue
                if topic == binding.result_topic:
                    key = payload.get("request_id")
                    if payload.get("status") not in OUTCOMES:
                        continue
                    request = self.pending.get(key)
                    if request and request["device"] == device.id:
                        self.finish(key, payload["status"], payload.get("reason"))
                    else:
                        svc.store.append_event({"type": "command_result", "device": device.id, **payload, "late": True})
                elif topic in (binding.availability_topic, binding.service_availability_topic):
                    if not isinstance(payload.get("available"), bool):
                        continue
                    if topic == binding.service_availability_topic:
                        self.service_availability[topic] = payload["available"]
                    else:
                        self.availability[device.id] = payload
                    if not payload["available"]:
                        svc.state.forget_device(device.id)
                else:
                    try:
                        ts = datetime.fromisoformat(payload["observed_at"].replace("Z", "+00:00"))
                        if ts.tzinfo is None or not isinstance(payload["values"], dict):
                            continue
                        if ts > svc.clock() + timedelta(seconds=30):
                            continue
                        if device.id in self.observations and ts <= self.observations[device.id]:
                            continue
                        decoded = {attr: attribute.decode(payload["values"][attr]) for attr, attribute in device.attributes.items() if attr in payload["values"] and payload["values"][attr] is not None}
                    except (KeyError, TypeError, ValueError):
                        continue
                    self.observations[device.id] = ts
                    if svc.clock() - ts > binding.stale_after:
                        svc.state.forget_device(device.id)
                        continue
                    # Install the whole snapshot before evaluation so combined fields are coherent.
                    previous = {attr: svc.state.get(device.id, attr) for attr in device.attributes}
                    for attr in device.attributes:
                        if attr not in decoded:
                            svc.state.forget_attribute(device.id, attr)
                    changed = []
                    for attr, value in decoded.items():
                        old = previous[attr]
                        if old is not None and values_equal(old.value, value):
                            svc.state.refresh(device.id, attr, value, ts, payload.get("source", "gateway"))
                        else:
                            svc.state.set(device.id, attr, value, ts, payload.get("source", "gateway"))
                            changed.append((attr, value, old))
                    for attr, value, old in changed:
                        svc.store.append_event({"type": "state", "device": device.id, "attr": attr, "value": value, "previous": old.value if old else None, "source": payload.get("source", "gateway")})
                        await svc.evaluator.on_state_change(device.id, attr, value, old.value if old else None, ts, True, payload.get("source", "gateway"))
                        changes.append((device.id, attr, value))
        return True, changes
