# Device gateway

Python 3.14 asyncio bridge for Gen2+ Shelly switches and MELCloud air-to-air units.
Decisions, schedules and overrides remain in automator. Metrics collectors are unchanged.

```bash
uv sync --python 3.14
uv run device-gateway --config config.yaml validate-config
uv run device-gateway --config config.yaml inspect
uv run device-gateway --config config.yaml export-automator --output bindings.json
uv run device-gateway --config config.yaml export-automator --merge ../automator/data/config.json --output merged.json
uv run device-gateway --config config.yaml run
uv run pytest
```

Copy `example-config.yaml` to `config.yaml`, verify the configured heat pump ID belongs to your account, and supply the referenced
secrets in the environment. The checked-in ID 210764 was inspected read-only on
2026-10-11 (air-to-air, Celsius; heat 10–31°C, cool 16–31°C, 0.5°C increments).
Non-numeric placeholders deliberately fail validation. Use the existing MELCloud account's
read-only `User/ListDevices` response to discover the ID and confirm DeviceType=0.
MELCloud accounts using Fahrenheit fail closed; select Celsius before enabling this adapter.
Bounds come from device metadata, or explicitly configure both `setpoint_bounds.heat`
and `.cool` with `min`, `max` and `step`. No fallback temperature bounds are invented.

The checked-in `automator-bindings.json` contains all five generated devices and
`tests/fixtures/inspection.json` records sanitized read-only observations.

Review `merged.json` before installing it into automator's data directory. The merge
preserves locks, names and unrelated settings; a pre-existing device without gateway
ownership or with a different command topic produces a conflict. Keep a backup of
`config.json`. The gateway never edits automator at runtime. Run automator in dry-run
first, then start gateway reads and inspect availability/state before enabling writes.

All MQTT publications/subscriptions use QoS 1. Commands are non-retained patches:

```json
{"request_id":"unique-id","values":{"mode":"heat","setpoint":21},"expires_at":"2026-10-11T12:00:30Z"}
```

Shelly results become `confirmed` after fresh local readback. MELCloud setters become
`accepted`, then `reported` after an independent read matches. Neither result proves
that this request caused the observed state. Timeouts never blindly retry writes;
readback resolves them or the result becomes `unconfirmed`. Follow-up reads share
account sessions and server backoff. Existing metrics polling adds to cloud traffic.
Native timers, physical inputs and vendor-app changes are observed normally.

`/healthz` reports process health and `/readyz` requires a broker connection, on port
8080. Offline devices do not affect process health. Config changes require restart.
There is no command-state PVC or offline MQTT backlog. Duplicate IDs are cached only
in memory; clients must not replay old requests after a restart.

Live-write verification requires an explicitly agreed device/value. Record the fresh
previous reading, submit one patch, inspect its result and independent snapshot, then
restore the previous value using a new request ID. Verify a short automator override
restores that value too. Do not use toggle or infer physical delivery from MELCloud.

Rollback: stop the gateway Deployment, restore the previous automator configuration
(or remove its generated command/read/write bindings), and reload automator. Metrics
and unrelated devices continue to operate. Clear removed retained device state with
`device-gateway --config config.yaml clear-retained removed-device-id`; this command
rejects devices still present in the configuration. Service offline is published by
MQTT Last Will. No device-native configuration is modified.

API evidence: [Shelly RPC/authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
[pymelcloud write merge](https://github.com/vilppuvuorinen/pymelcloud/blob/master/pymelcloud/device.py),
[air-to-air mappings](https://github.com/vilppuvuorinen/pymelcloud/blob/master/pymelcloud/ata_device.py).

## Code layout and extension

```text
src/device_gateway/
  config.py                  Common settings and separate adapter config schemas
  commands.py                Command envelope and outcome constants
  factory.py                 Adapter construction and shared resource ownership
  service.py                 Startup, wiring and shutdown
  worker.py                  One device's queue, polling and command readback
  mqtt.py                    Broker connection, QoS and MQTT routing
  health.py                  Process health and broker readiness
  export.py                  Generic automator bindings and conflict-aware merge
  adapters/
    base.py                  Adapter and resource interfaces
    __init__.py              Built-in adapter registry
    shelly_rpc.py            Shelly API, validation and attribute definitions
    melcloud_ata.py           Air-to-air API, validation and attribute definitions
    melcloud_client.py        Shared MELCloud account session and server backoff
    http.py                  Shared HTTP response validation
```

`service.py` wires each worker to an adapter and a publisher. The worker owns command
ordering, expiry, deduplication, supersession, polling and correlated results. It
uses the adapter interface and never chooses behavior by vendor name. `mqtt.py`
handles the broker without knowing device APIs. `export.py` gets attribute definitions
from the adapters and adds transport bindings without defining device capabilities.

Each adapter implements `adapters/base.py`: identity initialization, normalized reads,
whole-patch validation/application, inspection, attribute export and resource cleanup.
It specifies polling/readback timing and whether matching reads mean `confirmed` or
`reported`. A definite API rejection raises `Rejected`; uncertain delivery leaves
readback to the worker. Adapter operations are serialized by their worker.

To support a new **adapter type**, add its implementation under `adapters/`, declare
its specific configuration schema in `config.py` and include it in the discriminated
`Device` union, then register its factory in `adapters/__init__.py`. No worker, MQTT,
CLI or exporter branch is needed. Return normalized attribute specs from
`export_attributes()`; the exporter supplies MQTT paths and shared write topics.
Use `resources.shared((vendor, account_id), create_client)` for account clients.
The factory closes shared clients once after all device workers stop.

To add another **device using an existing adapter**, add its YAML configuration and
regenerate the automator bindings. No implementation changes are needed.
