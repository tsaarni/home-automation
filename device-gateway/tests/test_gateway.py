import asyncio
import json
from datetime import timedelta

import httpx
import pytest

from device_gateway.adapters.base import Rejected
from device_gateway.adapters.shelly_rpc import ShellyRpc
from device_gateway.adapters.melcloud_ata import MelCloudAta, timestamp
from device_gateway.adapters.melcloud_client import MelCloudClient
from device_gateway.config import Config, Credentials, ShellyConfig, MelCloudConfig
from device_gateway.export import bindings, merge
from device_gateway.worker import Worker
from device_gateway.commands import now
import device_gateway.worker as gateway_worker


def shelly_config(**kwargs):
    return ShellyConfig(adapter="shelly-rpc", name="plug", url="http://plug", expected_device_id="plug-id", **kwargs)


@pytest.mark.asyncio
async def test_shelly_zero_missing_errors_identity_and_write():
    requests = []
    status = {"output": False, "apower": 0, "aenergy": {"total": 0}, "errors": ["overtemp"]}
    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        result = {"id": "plug-id"} if body["method"] == "Shelly.GetDeviceInfo" else status if body["method"] == "Switch.GetStatus" else {"was_on": False}
        return httpx.Response(200, json={"result": result})
    client = httpx.AsyncClient(base_url="http://plug", transport=httpx.MockTransport(respond))
    adapter = ShellyRpc(shelly_config(), 5, client)
    values, metadata = await adapter.read()
    assert values == {"state": False, "power": 0, "energy": 0}
    assert metadata["protection_errors"] == ["overtemp"]
    with pytest.raises(Rejected):
        await adapter.apply({"state": True, "power": 0})
    await adapter.apply({"state": True})
    assert requests[-1] == {"id": 1, "method": "Switch.Set", "params": {"id": 0, "on": True}}
    adapter.config.expected_device_id = "other"
    with pytest.raises(Rejected, match="identity_mismatch"):
        await adapter.apply({"state": False})
    await adapter.close()


@pytest.mark.asyncio
async def test_rpc_error_inside_http_200():
    client = httpx.AsyncClient(base_url="http://plug", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"error": {"code": -1}})))
    with pytest.raises(Rejected):
        await ShellyRpc(shelly_config(), 5, client).read()
    await client.aclose()


class FakeAccount:
    fahrenheit = False
    def __init__(self):
        self.calls = []
        self.state = {"DeviceID": 42, "DeviceType": 0, "OperationMode": 1, "SetTemperature": 21,
                      "Power": False, "SetFanSpeed": 3, "EffectiveFlags": 8,
                      "RoomTemperature": 0, "LastCommunication": "2026-10-11T12:00:00+03:00"}
    async def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if path == "User/ListDevices":
            return [{"ID": 5, "Structure": {"Floors": [{"Areas": [{"Devices": [{"DeviceID": 42, "Device": {"DeviceType": 0, "MinTempHeat": 10, "MaxTempHeat": 31, "MinTempCoolDry": 16, "MaxTempCoolDry": 31, "TemperatureIncrement": .5}}]}]}]}}]
        if path == "Device/Get":
            return self.state.copy()
        return True


@pytest.mark.asyncio
async def test_melcloud_combined_flags_preservation_bounds_and_independent_read():
    account = FakeAccount()
    adapter = MelCloudAta(MelCloudConfig(adapter="melcloud-ata", name="pump", account="a", device_id=42), account)
    await adapter.initialize()
    values, metadata = await adapter.read()
    assert values["temperature"] == 0
    assert metadata["last_communication"] == "2026-10-11T09:00:00+00:00"
    account.state["SetTemperature"] = 10
    with pytest.raises(Rejected, match="together"):
        await adapter.apply({"mode": "cool"})
    await adapter.apply({"mode": "cool", "setpoint": 20.5})
    payload = account.calls[-1][2]["json"]
    assert payload["EffectiveFlags"] == 14
    assert payload["Power"] is False and payload["SetFanSpeed"] == 3
    assert payload["OperationMode"] == 3 and payload["SetTemperature"] == 20.5
    assert payload["HasPendingCommand"] is True
    assert (await adapter.read())[0]["mode"] == "heat"
    with pytest.raises(Rejected):
        await adapter.apply({"setpoint": 20.2})
    before = len(account.calls)
    with pytest.raises(Rejected, match="expired"):
        await adapter.apply({"setpoint": 20}, expires_at=now() - timedelta(seconds=1))
    assert all(call[1] != "Device/SetAta" for call in account.calls[before:])


@pytest.mark.asyncio
async def test_account_one_renewal_and_retry_after(monkeypatch):
    monkeypatch.setenv("M_USER", "u"); monkeypatch.setenv("M_PASS", "p")
    login_calls = 0
    requests = 0
    def respond(request):
        nonlocal login_calls, requests
        if request.url.path.endswith("ClientLogin"):
            login_calls += 1
            return httpx.Response(200, json={"LoginData": {"ContextKey": str(login_calls)}})
        requests += 1
        if requests == 1:
            return httpx.Response(401)
        return httpx.Response(429, headers={"Retry-After": "120"}, json={})
    client = httpx.AsyncClient(base_url="http://cloud/", transport=httpx.MockTransport(respond))
    account = MelCloudClient(Credentials(username_env="M_USER", password_env="M_PASS"), 5, client)
    with pytest.raises(Rejected, match="http_rejection"):
        await account.request("GET", "Device/Get")
    assert login_calls == 2 and requests == 2
    with pytest.raises(Rejected, match="backoff"):
        await account.request("GET", "Device/Get")
    await account.close()


class FakeService:
    def __init__(self): self.sent = []
    async def publish(self, suffix, data, retain=False): self.sent.append((suffix, data, retain))


class FakeAdapter:
    source = "device"
    writable = {"state"}
    confirmation_status = "confirmed"
    poll_interval = 15
    readback_interval = 0
    def __init__(self): self.writes = []; self.state = False
    async def initialize(self): pass
    def validate(self, patch):
        if set(patch) != {"state"}: raise Rejected("bad_patch")
    async def apply(self, patch, expires_at=None): self.writes.append(patch); self.state = patch["state"]
    async def read(self): return {"state": self.state}, {}


def command(key, values=None, seconds=30):
    return json.dumps({"request_id": key, "values": values or {"state": True}, "expires_at": (now() + timedelta(seconds=seconds)).isoformat()})


@pytest.mark.asyncio
async def test_worker_duplicates_expiry_supersession_and_readback(monkeypatch):
    service, adapter = FakeService(), FakeAdapter()
    worker = Worker("plug", shelly_config(), adapter, service.publish)
    payload = command("first")
    await worker.receive(payload)
    await worker.receive(payload)
    assert worker.queue.qsize() == 1
    await worker.receive(command("first", {"state": False}))
    assert service.sent[-1][1]["reason"] == "request_id_conflict"
    await worker.receive(command("second", {"state": False}))
    await worker.execute(worker.queue.get_nowait())
    assert adapter.writes == []  # superseded queued request was dropped
    await worker.execute(worker.queue.get_nowait())
    await worker.read()
    assert worker.cache["second"][1]["status"] == "confirmed"
    await worker.receive(command("expired", seconds=-1))
    assert service.sent[-1][1]["reason"] == "expired"
    await worker.receive(command("retained"), retained=True)
    assert service.sent[-1][1]["reason"] == "retained_command"
    current = now()
    await worker.receive(command("delayed", seconds=30))
    monkeypatch.setattr(gateway_worker, "now", lambda: current + timedelta(seconds=31))
    await worker.execute(worker.queue.get_nowait())
    assert worker.cache["delayed"][1]["status"] == "failed"


@pytest.mark.asyncio
async def test_uncertain_write_readback_without_retry():
    service, adapter = FakeService(), FakeAdapter()
    async def apply(patch, expires_at=None):
        adapter.writes.append(patch)
        adapter.state = True
        raise httpx.ReadTimeout("uncertain")
    adapter.apply = apply
    worker = Worker("plug", shelly_config(), adapter, service.publish)
    await worker.receive(command("timeout"))
    await worker.execute(worker.queue.get_nowait())
    await worker.read()
    assert len(adapter.writes) == 1
    assert worker.cache["timeout"][1]["status"] == "confirmed"


@pytest.mark.asyncio
async def test_export_merge_preserves_user_settings_and_reports_conflicts():
    config = Config(devices={"plug": shelly_config()})
    adapter = ShellyRpc(config.devices["plug"], 5)
    try:
        generated = await bindings(config, {"plug": adapter})
    finally:
        await adapter.close()
    old = {"devices": {"plug": {**generated[0], "locked": True, "name": "User name"}}}
    merged, conflicts = merge(old, generated)
    assert not conflicts and merged["devices"]["plug"]["locked"] is True
    assert merged["devices"]["plug"]["name"] == "User name"
    _, conflicts = merge({"devices": [{"id": "plug", "attributes": {}}]}, generated)
    assert conflicts
    assert timestamp("/Date(0+0300)/") == "1970-01-01T00:00:00+00:00"


@pytest.mark.asyncio
async def test_running_worker_idle_and_cloud_followup_deadline():
    service, adapter = FakeService(), FakeAdapter()
    adapter.source = "melcloud"
    adapter.confirmation_status = "reported"
    adapter.poll_interval = .2
    adapter.readback_interval = .02
    config = shelly_config(poll_interval=.2, followup_interval=.02, result_timeout=.06)
    worker = Worker("cloud", config, adapter, service.publish)
    # Independent cloud reads do not yet match the accepted request.
    async def accept(patch, expires_at=None): adapter.writes.append(patch)
    adapter.apply = accept
    task = asyncio.create_task(worker.run())
    try:
        await asyncio.sleep(.01)
        assert not task.done()  # an idle worker must keep running without pending requests
        await worker.receive(command("cloud-command"))
        await asyncio.sleep(.1)
        assert not task.done()
        assert len(adapter.writes) == 1
        assert worker.cache["cloud-command"][1]["status"] == "unconfirmed"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_two_workers_offline_isolation_and_recovery():
    service = FakeService()
    bad, good = FakeAdapter(), FakeAdapter()
    reads = 0
    async def offline():
        nonlocal reads
        reads += 1
        if reads == 1:
            raise httpx.ConnectError("offline")
        return {"state": False}, {}
    bad.read = offline
    config = shelly_config(poll_interval=.02)
    bad.poll_interval = good.poll_interval = .02
    workers = [Worker(name, config, adapter, service.publish) for name, adapter in (("bad", bad), ("good", good))]
    tasks = [asyncio.create_task(worker.run()) for worker in workers]
    try:
        await workers[1].receive(command("on"))
        await asyncio.sleep(.07)
        assert all(not task.done() for task in tasks)
        assert workers[1].cache["on"][1]["status"] == "confirmed"
        assert workers[0].last_success is not None
        assert any(topic == "bad/availability" and not data["available"] for topic, data, retain in service.sent)
    finally:
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_expired_duplicate_returns_known_result(monkeypatch):
    worker = Worker("plug", shelly_config(), FakeAdapter(), FakeService().publish)
    current = now()
    payload = command("short", seconds=30)
    await worker.receive(payload)
    await worker.execute(worker.queue.get_nowait())
    await worker.read()
    monkeypatch.setattr(gateway_worker, "now", lambda: current + timedelta(seconds=31))
    await worker.receive(payload)
    assert worker.cache["short"][1]["status"] == "confirmed"
