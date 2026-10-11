# home-automator

Home automation as data, not code: devices, groups and rules are JSON documents,
edited over REST, stored as cleartext files, executed in one process.

⚠️ Personal project, built for one specific house and broker. The API and document
schema are stable enough to read and copy; nothing here is a general product.

## What it does

* Binds MQTT topics to device attributes (read and write specs).
* Evaluates rules on every value change: `when` / `if` / `for` / `then`.
* Fires time, solar (`dusk`, `sunrise`, ...) and interval triggers.
* Remembers pending debounce (`for`) and timed override (`revert_after`) timers across restarts.
* Keeps an append-only audit log of every state change, write, rule firing and error.
* Serves a small static UI and a REST API for all of the above, plus Prometheus metrics.

At cutover it reproduces the previous app exactly: terrace lights at dusk/23:30/06:00/sunrise,
the toilet night tariff, the bathroom setback and the outdoor-temperature heating curve
(see `seed/rules.json`).

## Architecture

```
MQTT ──► gateway ──► state ──► evaluator ──► gateway ──► MQTT
                      ▲            │
                      │        audit events
        scheduler ────┘            ▼
                      └────── JSON files (config, pending, events)
 REST/UI ──────────────────────────┘
```

One invariant: **every** value change (MQTT read, manual `POST /set`, action write) goes
through one `apply_state()` path, and that is the only place rules re-evaluate. Writes
collected during one evaluation are applied together, after all rules of that tick were
evaluated, highest priority first (`priority` desc, then rule id).

| Module | Responsibility |
|---|---|
| `config.py` | env-only bootstrap settings (broker, data dir, timezone, lat/lon, port) |
| `store.py` | `config.json` (atomic rewrite), `pending.json`, `events.jsonl` (append, capped), mtime reload |
| `models.py` | pydantic documents: device, group, rule + reference/value validation |
| `state.py` | in-memory current values, change detection |
| `mqtt_gateway.py` | wildcard subscriptions, topic → (device, attr) routing, publish, reconnect |
| `evaluator.py` | when / if / for / then, groups, priority, guards, dry run, dependency index |
| `scheduler.py` | time/solar/interval wakeups (zoneinfo + astral) and pending timer firing |
| `service.py` | wiring, serialised write path, metrics, manual set, restart resync |
| `api.py` + `ui/index.html` | REST surface and the static UI |

## Documents

### device — binds a thing to MQTT (`topic` = match, `path` = JSON key)

```jsonc
// PUT /api/v1/devices/thermostat-bathroom
{ "id": "thermostat-bathroom",
  "attributes": {
    "setpoint": {
      "read":  { "topic": "zwave/thermostat-bathroom/67/0/setpoint/1", "path": "value" },
      "write": { "topic": "zwave/thermostat-bathroom/67/0/setpoint/1/set", "payload": { "value": "$v" } },
      "type": "number", "unit": "C", "limits": [5, 30], "default": 17 },
    "temperature": { "read": { "topic": "zwave/thermostat-bathroom/49/0/Air_temperature", "path": "value" }, "type": "number", "unit": "C" }
  } }

// PUT /api/v1/devices/powerplug-terrace   (Zigbee: one topic, value inside the payload)
{ "id": "powerplug-terrace",
  "attributes": {
    "state": { "read":  { "topic": "zigbee2mqtt/powerplug-terrace", "path": "state" },
               "write": { "topic": "zigbee2mqtt/powerplug-terrace/set", "payload": { "state": "$v" } },
               "type": "string", "enum": ["ON", "OFF"] },
    "power": { "read": { "topic": "zigbee2mqtt/powerplug-terrace", "path": "power" }, "type": "number", "unit": "W" }
  } }
```

Attribute fields: `type` (`number`/`string`/`boolean`), optional `unit`, `limits` (numbers only),
`enum`, `scale` / `offset` (applied as `value = raw * scale + offset` on read, inverted on write),
`default` (used when a timed override has no previous value to restore).
`locked: true` on a device refuses every write (vacation switch).

### group — a flat, write-only alias

```jsonc
{ "id": "floor-heating", "name": "Floor heating",
  "members": ["floor-heating-a", "floor-heating-b", "floor-heating-c"] }
```

Actions target either `{device: id}` or `{group: id}`; the target attribute must exist with the
same type on every member, which is checked when the rule or group is written.

### rule — `when` (one trigger) / `if` / `for` / `then`

```jsonc
{ "id": "bathroom-setback", "enabled": true, "priority": 100,
  "when": { "device": "thermostat-bathroom", "attr": "setpoint", "changed": true },
  "if":   { "all": [ { "attr": ["thermostat-bathroom","setpoint"], "op": "ne", "value": 17 } ] },
  "for":  "3h",
  "then": [ { "set": { "device": "thermostat-bathroom", "attr": "setpoint", "value": 17 } } ] }
```

* `when` — `{device, attr, changed}` (edge), `{device, attr}` (every message),
  `{at: "HH:MM" | "sunrise" | "sunset" | "dusk" | "dawn" | "noon" | "midnight", offset, days}`,
  `{every: "15m"}`. `days` = `["Mon"…"Sun"]` (omit = every day), `offset` = `"-30m"`.
* `if` — `{all: [...]}` or `{any: [...]}` of `{attr: [device, attr], op, value}`;
  `op ∈ eq ne gt ge lt le` (comparisons are numeric), `value` is a literal or `{device, attr}`.
  An attribute whose value is still unknown makes its term false and is reported in the event log.
* `for` — act only if `if` still holds after this long. A new trigger restarts the timer, the
  condition turning false cancels it, and pending timers survive restarts (`pending.json`).
* `once: true` — one-shot: the rule is deleted when its trigger is resolved (recorded in the log).
* action `revert_after: "4h"` — timed override: set the value, then restore the previous value
  (or the attribute `default`) later. One override per (device, attr), a newer write replaces it,
  and it survives rule disable/delete and restarts.
* actions: `set` (device or group), `set_curve` (linear interpolation over another attribute),
  `publish` (raw topic escape hatch, `$v` is the trigger value).
* guards: no write when the value is unchanged, `limits`/`enum` reject bad values,
  per-rule `rate_limit` (seconds, default 1) throttles a rule, `locked` devices are never written.
* timers: on boot `pending.json` is reloaded and time rules are re-asserted; firings that were
  missed while the service was down are caught up once if they are younger than `CATCH_UP_MAX`
  (default 12h).

## Layout

```
src/automator/         config.py store.py models.py state.py mqtt_gateway.py
                       evaluator.py scheduler.py service.py api.py ui/index.html
seed/                  devices.json groups.json rules.json install.py generate_devices.py
                       README.md (how the seed is extracted, and why)
tests/automator/       fake clock + fake broker; one test module per plan task
deploy/                Dockerfile, app.yaml (Deployment/Service/PVC), README.md
data/                  config.json pending.json events.jsonl  (runtime, not in git)
```

## REST API

```
GET    /api/v1/devices                 GET    /api/v1/rules                 GET    /api/v1/groups
GET    /api/v1/devices/{id}            GET    /api/v1/rules/{id}            GET    /api/v1/groups/{id}
PUT    /api/v1/devices/{id}            PUT    /api/v1/rules/{id}            PUT    /api/v1/groups/{id}
DELETE /api/v1/devices/{id}            DELETE /api/v1/rules/{id}            DELETE /api/v1/groups/{id}
GET    /api/v1/state                   POST   /api/v1/rules/{id}/enable | /disable
GET    /api/v1/state/{device}          POST   /api/v1/rules/{id}/test     # dry run, no side effects
POST   /api/v1/devices/{id}/set        POST   /api/v1/groups/{id}/set
GET    /api/v1/timers                  POST   /api/v1/reload   POST /api/v1/dry-run
GET    /api/v1/events?since=&until=&rule=&kind=&limit=
GET    /metrics   GET /healthz   GET /readyz   GET / (UI)   /openapi.json   /docs
```

* `PUT` is an upsert by client-chosen id; ids are immutable (rename = create + move references).
* Referential integrity is enforced: unknown device/group/attribute references, a group member
  missing the target attribute, a type mismatch, a non-numeric comparison or a bad value are
  rejected with **422** and a list of problems. Deleting a still-referenced document is **422** too.
* `POST /devices/{id}/set` takes attribute values plus optional `{"revert_after": "4h"}`,
  `POST /groups/{id}/set` fans out over the members.
* Every write reports a status: `applied`, `unchanged`, `dry-run`, `skipped` (`device_locked`)
  or `error` (with a reason), and lands in the audit log.

## Running it

```bash
uv sync                       # install dependencies (Python 3.13+)
uv run python -m automator    # DATA_DIR=./data, PORT=80 by default

DATA_DIR=/tmp/automator PORT=8099 MQTT_URL=none DRY_RUN=true \
  TZ=Europe/Helsinki LAT=60.17 LON=24.94 uv run python -m automator
```

Environment variables (everything else is a document):

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mosquitto` | `host`, `host:port` or `mqtt://user:pass@host:1883`; `none` disables MQTT |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | – | credentials (also parsed from `MQTT_URL`) |
| `MQTT_TOPICS` | `zigbee2mqtt/#,zwave/#,home/#` | subscription wildcards |
| `DATA_DIR` | `data` | where config.json / pending.json / events.jsonl live |
| `HOST` / `PORT` | `0.0.0.0` / `80` | HTTP listen address |
| `TZ` | `Europe/Helsinki` | zone for schedules and day matching |
| `LAT` / `LON` / `ELEVATION` | – / – / 0 | solar triggers (absent = those triggers are inert) |
| `DRY_RUN` | `false` | plan writes, publish nothing, change no state |
| `SCHEDULER_TICK` | `1` | scheduler resolution in seconds |
| `CATCH_UP_MAX` | `12h` | how late a missed schedule may be caught up |
| `EVENTS_MAX_BYTES` | `2000000` | `events.jsonl` is trimmed to the newest half above this |
| `LOG_LEVEL` | `INFO` | log level |

### Seeding a fresh data directory

```bash
uv run python seed/install.py data   # writes data/config.json from seed/*.json
```

### Where `seed/devices.json` comes from

The device documents are **not** typed by hand. `seed/generate_devices.py` extracts them from the
configuration of the three sources (the zwave-js-ui store, the zigbee2mqtt configuration and
device inventory, and the home-metrics topics), then merges them into the committed file. Your
hand edits win, so a refresh only adds what is new.

The committed file holds 40 devices (29 zigbee2mqtt, 12 zwave-js-ui, home-metrics values merged
into the thermostats) and 313 attributes, including the aliases and defaults that the parity
rules use.

See [seed/README.md](seed/README.md) for the full procedure: what the seed is for, where each
field comes from, the exact extraction commands, the name and topic rules, the checks, and the
cautions.

## Tests

```bash
uv run pytest -q          # tests/automator: fake clock + in-process fake broker, no network
```

The suite mirrors the implementation plan: store, models, state/index, gateway, evaluator
scenarios, scheduler, API, restart/reconnect and the seed set.

## Deployment

See [deploy/README.md](deploy/README.md). One replica, one PVC (plain files, single writer),
plain `Service`; exposure is a Cloudflare Tunnel route and there is no auth in the app.

## Cutover

1. Deploy v2 in parallel with `DRY_RUN=true`; watch `/api/v1/events` for `dry-run` writes and
   compare them with the old app's behaviour.
2. Turn dry run off and confirm the four parity behaviours plus manual control.
3. Delete the old deployment, ConfigMap and the `mqtttimer`/`thermostat` code
   (`src/homeautomator`, `src/main.py`, `src/task.py`, `src/utils.py`, `main.py`, the example
   YAMLs and the root `Dockerfile` still referenced by the old image).
4. Follow-up in home-metrics (separate repo): publish energy and price to MQTT, then enable the
   power-limit and price-shedding rules.
