"""One device's bounded command queue, polling and readback lifecycle.

Independent of MQTT clients and vendor APIs: receives command payloads and emits
messages through the supplied publisher, using the common Adapter contract.
"""
import asyncio
import json
import logging
import random
import time
from collections import OrderedDict
from typing import Any, Protocol

from .adapters.base import Adapter, Rejected
from .commands import Command, TERMINAL, now, stamp
from .config import Device

LOG = logging.getLogger(__name__)


class Publisher(Protocol):
    async def __call__(self, suffix: str, data: dict[str, Any], retain: bool = False) -> None: ...


class Worker:
    def __init__(self, device_id: str, config: Device, adapter: Adapter, publish: Publisher):
        self.id, self.config, self.adapter = device_id, config, adapter
        self.publish = publish
        self.queue = asyncio.Queue(maxsize=32)
        self.cache = OrderedDict()
        self.pending = {}
        self.snapshot = None
        self.last_success = None
        self.next_poll = 0
        self.failures = 0
        self.initialized = False

    async def result(self, command, outcome, reason=None):
        result = {"request_id": command.request_id, "values": command.values, "status": outcome, "time": stamp()}
        if reason:
            result["reason"] = reason
        cached = self.cache.get(command.request_id)
        if cached is not None and cached[0] == command.model_dump(mode="json"):
            self.cache[command.request_id] = (cached[0], result)
        await self.publish(f"{self.id}/result", result)
        return result

    async def receive(self, payload, retained=False):
        try:
            if len(payload) > 65536:
                raise ValueError("command_too_large")
            command = Command.model_validate_json(payload)
        except (ValueError, TypeError):
            result = {"status": "failed", "reason": "malformed_command", "time": stamp()}
            try:
                parsed = json.loads(payload) if len(payload) <= 65536 else None
                if isinstance(parsed, dict) and isinstance(parsed.get("request_id"), str) and 0 < len(parsed["request_id"]) <= 128:
                    result["request_id"] = parsed["request_id"]
            except (ValueError, TypeError):
                pass
            await self.publish(f"{self.id}/result", result)
            return
        if retained:
            await self.publish(f"{self.id}/result", {"request_id": command.request_id, "status": "failed", "reason": "retained_command", "time": stamp()})
            return
        content = command.model_dump(mode="json")
        cached = self.cache.get(command.request_id)
        if cached:
            if cached[0] != content:
                await self.publish(f"{self.id}/result", {"request_id": command.request_id, "status": "failed", "reason": "request_id_conflict", "time": stamp()})
            else:
                await self.publish(f"{self.id}/result", cached[1])
            return
        if command.expires_at <= now():
            await self.result(command, "failed", "expired")
            return
        if self.queue.full() or len(self.pending) >= 32:
            await self.result(command, "failed", "queue_full")
            return
        self.cache[command.request_id] = (content, {"request_id": command.request_id, "values": command.values, "status": "pending", "time": stamp()})
        while len(self.cache) > 512:
            # Never evict active requests, or duplicate deliveries could execute twice.
            removable = next((key for key, (_, result) in self.cache.items() if result["status"] in TERMINAL), None)
            if removable is None:
                break
            del self.cache[removable]
        for key, (older, deadline, followup) in list(self.pending.items()):
            if set(older.values) & set(command.values):
                del self.pending[key]
                await self.result(older, "unconfirmed", "superseded")
        # Queued work is marked superseded, then cheaply dropped before execution.
        for key, (original, result) in list(self.cache.items()):
            if key != command.request_id and result["status"] == "pending" and set(original["values"]) & set(command.values):
                await self.result(Command.model_validate(original), "unconfirmed", "superseded")
        self.queue.put_nowait(command)

    async def read(self):
        if not self.initialized:
            await self.adapter.initialize()
            self.initialized = True
        values, metadata = await self.adapter.read()
        self.last_success = stamp()
        self.snapshot = {"values": values, "observed_at": self.last_success, "source": self.adapter.source, **metadata}
        await self.publish(f"{self.id}/state", self.snapshot, retain=True)
        await self.publish(f"{self.id}/availability", {"available": True, "last_successful_read": self.last_success}, retain=True)
        self.failures = 0
        for key, (command, deadline, followup) in list(self.pending.items()):
            if all(values.get(attr) == value for attr, value in command.values.items()):
                del self.pending[key]
                await self.result(command, self.adapter.confirmation_status)
        return values

    async def execute(self, command):
        if self.cache[command.request_id][1]["status"] != "pending":
            return
        if command.expires_at <= now():
            await self.result(command, "failed", "expired")
            return
        try:
            if not self.initialized:
                await self.adapter.initialize()
                self.initialized = True
        except Exception as exc:
            await self.result(command, "failed", str(exc) if isinstance(exc, Rejected) else "preflight_failed")
            return
        try:
            # Check expiry immediately before adapter execution as well.
            if command.expires_at <= now():
                await self.result(command, "failed", "expired")
                return
            await self.adapter.apply(command.values, expires_at=command.expires_at)
        except Rejected as exc:
            await self.result(command, "failed", str(exc))
            return
        except Exception:
            if self.cache[command.request_id][1]["status"] in TERMINAL:
                return
            # A request may have reached the API. Never replay the write.
            self.pending[command.request_id] = (command, time.monotonic() + self.config.result_timeout, time.monotonic())
            await self.result(command, "accepted", "delivery_uncertain")
        else:
            if self.cache[command.request_id][1]["status"] in TERMINAL:
                return  # a newer command superseded this request while its write was executing
            await self.result(command, "accepted")
            self.pending[command.request_id] = (command, time.monotonic() + self.config.result_timeout, time.monotonic() + self.adapter.readback_interval)
        # Local devices read back immediately; cloud adapters specify a delayed read.
        self.next_poll = 0 if self.adapter.readback_interval == 0 else time.monotonic() + self.adapter.poll_interval

    async def run(self):
        interval = self.adapter.poll_interval
        while True:
            # Execute queued commands before any routine read.
            if not self.queue.empty():
                await self.execute(self.queue.get_nowait())
                continue
            current = time.monotonic()
            for key, (command, deadline, followup) in list(self.pending.items()):
                if current >= deadline:
                    del self.pending[key]
                    await self.result(command, "unconfirmed", "result_deadline")
            due = min([self.next_poll, *[item[2] for item in self.pending.values()]])
            if current >= due:
                try:
                    await self.read()
                    self.next_poll = time.monotonic() + interval
                except Exception as exc:
                    self.failures += 1
                    LOG.warning("read failed for %s (%s)", self.id, type(exc).__name__)
                    await self.publish(f"{self.id}/availability", {"available": False, "last_successful_read": self.last_success, "reason": str(exc) if isinstance(exc, Rejected) else "read_failed"}, retain=True)
                    self.next_poll = time.monotonic() + min(interval * 4, interval * 2 ** min(self.failures - 1, 10)) * random.uniform(.8, 1.2)
                for key, (command, deadline, followup) in list(self.pending.items()):
                    self.pending[key] = (command, deadline, max(self.next_poll if self.failures else 0, time.monotonic() + self.config.followup_interval))
                continue
            timeout = max(.01, min([due - current, *[item[1] - current for item in self.pending.values()]]))
            try:
                command = await asyncio.wait_for(self.queue.get(), timeout=timeout)
            except TimeoutError:
                continue
            await self.execute(command)

    async def run_forever(self):
        while True:
            try:
                await self.run()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOG.exception("worker failed for %s; recovering without replay", self.id)
                for key, (content, result) in list(self.cache.items()):
                    if result["status"] not in TERMINAL:
                        await self.result(Command.model_validate(content), "unconfirmed", "worker_recovery")
                self.pending.clear()
                await asyncio.sleep(random.uniform(1, 2))
