# device-gateway — implementation plan

## Purpose

Add one configurable service that connects automator to local Shelly devices and
MELCloud. First release: on/off for four Shellys, and temperature plus heating/cooling
mode for the heat pump. Adding another supported device requires configuration only.

```text
webui → automator → MQTT commands → device-gateway → device APIs
             ↑                             │
             └──── MQTT state/results ─────┘

metrics → existing device reads → VictoriaMetrics   (unchanged in v1)
```

Automator owns decisions, schedules, locks, overrides and audit history. Gateway
owns API communication, validation, polling and command execution. Webui uses
only automator. Native timers, physical inputs and vendor apps remain independent
sources of device changes, which gateway observes normally.

Use Python 3.14, asyncio, httpx, aiomqtt, pydantic and YAML. One process, one worker
per device, shared MELCloud sessions per account. A failed device must not stop
other workers. No heating policies, public gateway API or configuration UI in v1.

## Verified devices

Read-only inspection on 2026-10-11 confirmed all four Shellys expose `switch:0`,
with local HTTP access available and device authentication/native MQTT disabled.
No device settings or outputs were changed.

| Configuration id | Address | Model | Firmware | Expected device identity |
| --- | --- | --- | --- | --- |
| `plug-livingroom` | `192.168.86.90` | Plug S Gen3 | 2.0.1 | `shellyplugsg3-5432045cc35c` |
| `plug-storage-street` | `192.168.86.133` | Outdoor Plug S Gen3 | 2.0.0 | `shellyoutdoorsg3-e4b063dac314` |
| `heater-storage-car` | `192.168.86.41` | Plus 1PM (Gen2) | 1.7.5 | `shellyplus1pm-4855199d80c8` |
| `heater-storage-street` | `192.168.86.40` | Plus 1PM (Gen2) | 1.7.5 | `shellyplus1pm-4855199bec80` |
| `heatpump` | MELCloud | Device type/identity to inspect | — | Explicit MELCloud device ID |

The outdoor plug has a native three-hour auto-off. Both Plus 1PMs follow physical
inputs and have disabled heating scripts. Enabled schedules found are firmware
updates. These findings are context, not special gateway features: leave the
configuration alone and report output changes regardless of their origin.

An automator timed override means “restore the previous value later,” not “keep
this device continuously in the requested state.” Do not coordinate native timers,
reassert outputs after external changes, or add a special timer display in v1.

## Configuration and ownership

One validated YAML file, mounted through a ConfigMap; secrets referenced by
variable name and supplied through Kubernetes Secrets. Changes take effect on
restart. Provide `validate-config`, read-only `inspect`, and `export-automator`.

```yaml
mqtt:
  host: mosquitto
  port: 1883
  topic_prefix: home/device-gateway
  # Optional username_env/password_env.
defaults:
  shelly_poll_interval: 15s
  http_timeout: 5s
  command_ttl: 30s
accounts:
  melcloud-main:
    username_env: MELCLOUD_USERNAME
    password_env: MELCLOUD_PASSWORD
devices:
  plug-livingroom:
    adapter: shelly-rpc
    name: Living room plug
    url: http://192.168.86.90
    expected_device_id: shellyplugsg3-5432045cc35c
  plug-storage-street:
    adapter: shelly-rpc
    name: Street side storage plug
    url: http://192.168.86.133
    expected_device_id: shellyoutdoorsg3-e4b063dac314
  heater-storage-car:
    adapter: shelly-rpc
    name: Storage car heater
    url: http://192.168.86.41
    expected_device_id: shellyplus1pm-4855199d80c8
  heater-storage-street:
    adapter: shelly-rpc
    name: Storage street heater
    url: http://192.168.86.40
    expected_device_id: shellyplus1pm-4855199bec80
  heatpump:
    adapter: melcloud-ata
    name: Heat pump
    account: melcloud-main
    device_id: REPLACE_WITH_DISCOVERED_ID
    poll_interval: 5m
    followup_interval: 60s
    result_timeout: 5m
    # Optional mode-specific setpoint bounds and step overrides.
```

Shelly `switch_id` defaults to zero; allow an override and optional credential
references. Validate identifiers, URLs, positive intervals, adapter types, account
references and secret presence before startup. Reject the MELCloud placeholder.
A configured device must match its expected identity before a write is allowed.

Adapter definitions own the supported attributes and normalized types. YAML owns
addresses, identities, polling settings and names. Export deterministic automator
bindings from those two sources; no retained discovery/capability protocol is needed.
Export may inspect MELCloud read-only to resolve mode-dependent bounds. Explicit
configuration overrides are allowed when metadata is unavailable.

Installation is an explicit merge: update gateway-owned transport bindings and
validation fields, preserve locks and unrelated user settings, and show conflicts
rather than silently overwrite them. Name is the initial default, subsequently
editable in automator. The gateway does not edit automator through REST at runtime.
Use existing UI room inference and generic controls; adding a supported device
must not require another hand-written UI entry.

## Adapters

A small common interface: initialize/check identity, read normalized state,
validate a patch, apply it, and close resources. A patch is an attribute/value map;
validate the whole patch before any API write. Reject unknown or read-only fields.
Serialize API operations per device, but never hold its worker waiting for a cloud
confirmation: schedule later reads so subsequent commands can still execute.
Use finite timeouts, bounded queues, capped read/reconnect backoff with jitter and
cancellation-aware shutdown. Prioritize commands over routine polling.

### Shelly RPC

One adapter covers all four models using the shared Gen2+ API:

- Check identity with `Shelly.GetDeviceInfo`; read using `Switch.GetStatus`.
- Write an explicit boolean with POST `/rpc`:
  `{"id":1,"method":"Switch.Set","params":{"id":0,"on":true}}`.
  Never use toggle, which is unsafe to repeat after uncertain delivery.
- Check both HTTP status and RPC error responses. `Switch.Set` returns `was_on`,
  the previous state; perform a fresh status read to verify the requested output.
- Normalize `output` to boolean `state`, `apower` to `power` (W),
  `aenergy.total / 1000` to `energy` (kWh), plus voltage, current and optional
  `device_temperature` (C). Internal temperature is not ambient temperature.
- Preserve zeros; distinguish missing readings and protection errors from offline.
- Poll every 15 seconds initially and read immediately after a write.
  Implement documented HTTP digest authentication if credentials are configured.

### MELCloud air-to-air

Support `DeviceType=0` in v1. Inspect the actual unit first; if it is air-to-water,
revise the adapter explicitly rather than send air-to-air payloads to it.

Login through `Login/ClientLogin`, retain `LoginData.ContextKey`, enumerate all
buildings/floors/areas through `User/ListDevices`, and select the configured device.
Resolve its building ID. Read through `Device/Get?id=…&buildingID=…`; use
`X-MitsContextKey` for authenticated calls and `Device/SetAta` for writes.

| Normalized write | MELCloud field | Value | EffectiveFlags bit |
| --- | --- | --- | --- |
| `setpoint` | `SetTemperature` | Degrees C | `4` |
| `mode` | `OperationMode` | `heat` → `1`, `cool` → `3` | `2` |

Read fresh state, copy it, merge requested fields and the corresponding flag bits,
set `HasPendingCommand=true`, and post the resulting state. Follow the verified
client behavior for existing flags; test with captured responses. Preserve power,
fan, vanes and other unrelated fields. A mode change must not implicitly power on.
Power control and dry/fan/auto writes are deferred, but publish their observed values
when present using named modes rather than raw vendor integers.

Support `{"mode":"heat","setpoint":21}` as one API operation. Validate setpoint
against the resulting mode's bounds and increment, using device metadata or explicit
configuration. For mode-only writes, reject an incompatible existing setpoint with
an actionable error requesting a combined patch; do not silently change temperature.

Publish room temperature, setpoint, mode and optional telemetry as **MELCloud-reported
state**. They describe what the cloud reports, not a measured physical delivery
receipt. A successful setter is `accepted`; a subsequent independent read matching
all requested fields is `reported`. Include pending-command/last-communication data
when available, but do not invent a physical-confirmation guarantee. Rules consume
this same reported state, never automator's locally requested value.

Normal polling starts at five minutes; command follow-ups at one minute, bounded
by five minutes. Share account scheduling, honor server backoff/Retry-After and
reuse sessions. Renew expired sessions once per failed operation; do not loop on
invalid credentials. These intervals are configurable defaults, not vendor quotas.
Coordinate routine/follow-up reads and existing metrics traffic when evaluating
cloud load. Parse timestamps correctly, retaining their real timezone meaning.

## MQTT contract

Prefix `home/device-gateway` fits automator's existing `home/#` subscription.

| Topic suffix | Content | Retained |
| --- | --- | --- |
| `/availability` | Service online/offline; offline Last Will | Yes |
| `/{device}/state` | Complete normalized snapshot and observation metadata | Yes |
| `/{device}/availability` | Reachability and last successful read | Yes |
| `/{device}/set` | Command patch with identity and expiry | No |
| `/{device}/result` | Correlated execution outcome | No |

```json
{"request_id":"uuid","values":{"mode":"heat","setpoint":21},
 "expires_at":"2026-10-11T12:00:30Z"}
```

```json
{"values":{"state":true,"power":218.7,"energy":582.814563},
 "observed_at":"2026-10-11T12:00:01Z","source":"device"}
```

State `source` is `device` for local Shelly reads and `melcloud` for cloud reads.
Include available capture timestamps separately. A snapshot replaces the gateway
attribute set: omitted readings become unknown, not indefinitely retained values.
On failure publish availability without fabricating new readings.

Use QoS 1 explicitly in publishers and subscriptions; current automator publishing
must be extended accordingly. Use clean sessions with no offline command backlog.
Reject retained, expired and malformed commands, including expiry checked again
before execution. Deduplicate IDs in a bounded in-memory cache, returning the known
result; reject the same ID with different content. Never replay commands on restart.
Expiry is an execution deadline, not a cloud cancellation or confirmation deadline.

Outcomes: `accepted` (API accepted), `confirmed` (Shelly readback matches),
`reported` (later MELCloud read matches), `failed` (definite rejection), or
`unconfirmed` (uncertain outcome/deadline). Include request ID, requested fields,
time and an error/reason code. An API timeout may have applied the write: read back,
then report uncertainty if unresolved; do not blindly retry. Confirmation/reporting
means matching state was observed, not proof that this request caused it.

A newer request supersedes older pending intent for overlapping attributes. Already
executing writes cannot be cancelled reliably; preserve per-device execution order
and expire/drop superseded queued work. Late results belong in audit history but
must not overwrite newer intent. Broker reconnect refreshes state; retained readings
keep their original observation time. Clear removed-device retained topics using an
explicit maintenance command.

## Automator and webui

Opt in gateway devices through a small optional device-level `command` binding
(command/result/state/availability topics, expiry and result timeout). Keep ordinary
attribute read/write bindings for rule validation and existing UI control discovery.
The binding identifies a shared patch transport; exporter guarantees every writable
attribute uses it. Existing Zigbee/Z-Wave devices keep their current semantics.

- Batch manual multi-attribute `/set` requests into one patch. For a rule evaluation,
  resolve existing priority conflicts first, then batch compatible winning writes
  by device into one patch. Preserve per-attribute audit and revert metadata.
  Combined mode/setpoint must reach MELCloud together; avoid accidental batching
  of independent requests or incompatible override durations.
- Register pending intent, publish and return `pending` with the request ID. Broker
  publication is not API acceptance. Receive results asynchronously; never wait for
  them while holding automator's state lock or MQTT receive loop.
- Requested state is separate from reported state. Only snapshots enter the normal
  state/evaluation path. Handle state/result arrival in either order.
- Check pending intent before the unchanged-value guard. If OFF is observed while
  ON is pending, a new OFF request must still send OFF. Deduplicate only equivalent
  active intent; apply unchanged suppression to fresh readings with no conflicting
  request. Maintain existing rule priority/rate limits to prevent feedback loops.
- Refresh timestamps for unchanged snapshots without firing change-triggered rules.
  Reject older observations; invalidate missing fields. Stale/unavailable data must
  appear unknown to gateway-dependent conditions, with expiry handled even when
  no further messages arrive. Do not alter unrelated device freshness behavior.
- Show unavailable status without automatically blocking a fresh command attempt.
  Gateway rechecks identity/reachability and returns the actual outcome. Continue
  enforcing locks, attribute types, limits and dry-run before publication.
- Keep pending metadata in memory. On restart, recent audited requests lacking a
  terminal result are unresolved; do not reconstruct/replay them. Refresh state.
  Existing persisted override timers continue independently.
- Arm overrides after successful publication, using the previous fresh reported
  value or configured default and the requested duration. They restore a value
  later, not enforce it continuously. Definite rejection cancels only that request's
  timer; ambiguous outcomes retain restoration. Reverts are new tracked commands,
  can supersede pending intent and can fail. Never cancel newer timers on late results.
- Limit read-only rejection to gateway bindings; defer a broader virtual-attribute
  redesign and changes to the raw-publish escape hatch.

Extend existing schemas, API responses and audit views with pending/accepted,
confirmed/reported, failed and unconfirmed outcomes. UI shows current reported
value separately from pending intent; request completion comes through normal
API refresh. MELCloud feedback says “reported by MELCloud,” not “heat pump confirmed.”
Use existing boolean and numeric/select controls, adding a mode/setpoint submission
that sends one patch when both are edited. Use string mode labels so existing
thermostat numeric mappings cannot mislabel MELCloud cooling.

## Deployment and boundaries

Add the package, example config, Dockerfile, build integration and Kubernetes
Deployment/ConfigMap/Secret references. One replica with Recreate rollout prevents
overlapping consumers. Provide process health and broker readiness; one device
being offline must not restart the service. No PVC for command state.

Keep existing metrics collectors and dashboards in v1. Accept duplicate read polling
as a temporary tradeoff; gateway does not write VictoriaMetrics. Cloud reads must
remain bounded alongside the existing MELCloud collector. Consolidating device reads
and choosing the future metrics transport is a separate change with explicit series
compatibility checks, not part of enabling controls.

Defer WebSocket push, dynamic capability topics, hot reload, configuration UI,
physical cloud delivery guarantees, additional operating modes and new heating rules.
Rollback stops gateway command consumption and removes/disables these generated
bindings. Existing metrics and unrelated automation remain available.

## Delivery and verification

1. Scaffold validated config, adapter interface and read-only inspection. Capture
   sanitized Shelly fixtures and inspect MELCloud type, identity and capabilities.
2. Implement both readers and MQTT snapshots/availability. Test zeros, optional and
   missing fields, timestamps, partial responses, auth, identity mismatch and recovery.
3. Implement patch validation/writes and correlated results. Test Shelly readback,
   MELCloud fields/flags, combined mode/setpoint, unrelated-setting preservation,
   API errors inside HTTP 200, timeouts, duplicates, expiry and bounded follow-ups.
4. Add opt-in automator transport, batching and asynchronous tracking. Test OFF while
   ON is pending, ordering/supersession, rule priorities, unchanged freshness,
   snapshot invalidation, lock freedom, dry-run, timers and restart without replay.
   Run existing automator tests to protect Zigbee/Z-Wave behavior.
5. Add deterministic export/merge and UI feedback. Test repeatable generation, user
   edit preservation, room/control fallback, combined edits and accurate outcome
   labels. Run webui tests, typecheck, lint and build.
6. Add deployment and documentation. Smoke-test reads first; live writes use an
   explicitly agreed device/value and restore its previous setting. Verify one
   command and override end to end, then record rollback instructions.

Completion: all five devices are configured; Shelly on/off and MELCloud heat/cool
plus setpoint work through the same automator path; external changes are observed;
failures and uncertainty are visible; another supported device needs configuration
and regenerated bindings only; existing metrics and automation remain functional.

## Sources and remaining checks

Shelly vendor references:
[Switch](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/),
[Plug S Gen3](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen3/ShellyPlugSG3/),
[Outdoor Plug S Gen3](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen3/ShellyOutdoorPlugSG3/),
[Plus 1PM](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen2/ShellyPlus1PM/),
[authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/).

MELCloud is an undocumented cloud interface. Evidence comes from the existing
collector and the archived pymelcloud implementation:
[client](https://github.com/vilppuvuorinen/pymelcloud/blob/master/pymelcloud/client.py),
[air-to-air mappings](https://github.com/vilppuvuorinen/pymelcloud/blob/master/pymelcloud/ata_device.py),
[write merge](https://github.com/vilppuvuorinen/pymelcloud/blob/master/pymelcloud/device.py).
Verify the actual account/device responses, Celsius handling, mode-specific limits,
flags and session behavior before live writes. No live MELCloud inspection has
been performed yet; API implementation evidence is not a vendor contract.
