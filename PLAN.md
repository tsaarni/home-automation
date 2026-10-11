# home-automator v2 — plan

One service owns home automation as **data, not code**: devices, groups and rules are JSON
documents, edited over REST, persisted as cleartext JSON files, executed in one process.
Everything the deployed app does today is reproduced as a small set of rule documents.

## Decisions

| Topic | Choice |
|---|---|
| Language | Python 3.13, FastAPI, pydantic v2, aiomqtt |
| UI | One static HTML page, no build step, served by the app |
| Repo | Overhaul in place (`git history keeps the old code`) |
| Auth | None in app — Cloudflare Access at the edge |
| Exposure | Cloudflare Tunnel only (no Contour/HTTPProxy); plain k8s `Service` |
| Store | Cleartext JSON files on a PVC — `config.json` + `pending.json` + append-only `events.jsonl` |
| Config | Env vars only at bootstrap; everything else is a document |

## Architecture

```
MQTT ──► gateway ──► state ──► evaluator ──► gateway ──► MQTT
                      ▲            │
                      │        audit events
        scheduler ────┘            ▼
                      └────── JSON files (config, pending, events)
 REST/UI ──────────────────────────┘
```

One invariant: **every** value change (MQTT read, manual `POST /set`, action write)
goes through one `apply_state()` path, and that is the only place rules re-evaluate.

## Document model — three kinds

### `device` — binds a thing to MQTT (`topic` = match, `path` = JSON key)

```jsonc
// PUT /api/v1/devices/thermostat-bathroom
{ "id": "thermostat-bathroom",
  "attributes": {
    "setpoint": {
      "read":  { "topic": "zwave/thermostat-bathroom/67/0/setpoint/1", "path": "value" },
      "write": { "topic": "zwave/thermostat-bathroom/67/0/setpoint/1/set", "payload": { "value": "$v" } },
      "type": "number", "unit": "°C", "limits": [5, 30] },
    "temperature": {
      "read": { "topic": "zwave/thermostat-bathroom/49/0/Air_temperature", "path": "value" },
      "type": "number", "unit": "°C" }
  }
}

// PUT /api/v1/devices/powerplug-terrace  (Zigbee: one topic, value in payload)
{ "id": "powerplug-terrace",
  "attributes": {
    "state": { "read":  { "topic": "zigbee2mqtt/powerplug-terrace", "path": "state" },
               "write": { "topic": "zigbee2mqtt/powerplug-terrace/set", "payload": { "state": "$v" } },
               "type": "string", "enum": ["ON","OFF"] },
    "power": { "read": { "topic": "zigbee2mqtt/powerplug-terrace", "path": "power" }, "type": "number", "unit": "W" }
  }
}
```

### `rule` — `when` (trigger) / `if` (condition) / `for` (debounce) / `then` (actions)

```jsonc
{ "id": "bathroom-setback", "enabled": true, "priority": 100,
  "when": { "device": "thermostat-bathroom", "attr": "setpoint", "changed": true },
  "if":   { "all": [ { "attr": ["thermostat-bathroom","setpoint"], "op": "!=", "value": 17 } ] },
  "for":  "3h",
  "then": [ { "set": { "device": "thermostat-bathroom", "attr": "setpoint", "value": 17 } } ] }
```

### `group` — a named alias for several devices (write-only fan-out)

```jsonc
// PUT /api/v1/groups/floor-heating
{ "id": "floor-heating", "name": "Floor heating",
  "members": ["floor-heating-a", "floor-heating-b", "floor-heating-c"] }
```

Actions target either `{device: id}` or `{group: id}`; groups are flat (no nested groups).

## Use cases

### Today's behaviour (must work at cutover)

| Behaviour | Rules |
|---|---|
| **Terrace lights** — ON at dusk, OFF 23:30, ON 06:00, OFF at sunrise | 4 time rules |
| **Toilet night tariff** — 24 °C at 22:00, 15 °C at 07:00 | 2 time rules |
| **Bathroom setback** — after a manual change, back to 17 °C after 3 h | 1 `for` rule |
| **Heating curve** — bathroom target from outdoor temperature | 1 `set_curve` rule |

```jsonc
// terrace lights, dusk
{ "id": "terrace-dusk", "when": { "at": "dusk" },
  "then": [ { "set": { "device": "powerplug-terrace", "attr": "state", "value": "ON" } } ] }

// toilet night tariff
{ "id": "toilet-night", "when": { "at": "22:00" },
  "then": [ { "set": { "device": "thermostat-toilet", "attr": "setpoint", "value": 24 } } ] }

// heating curve (interpolation stays an action, not a language)
{ "id": "bathroom-curve", "when": { "device": "temperature-backyard", "attr": "temperature" },
  "then": [ { "set_curve": { "device": "thermostat-bathroom", "attr": "setpoint",
               "x": { "device": "temperature-backyard", "attr": "temperature" },
               "points": [[-20,25],[-5,23],[0,21],[10,19],[20,17]] } } ] }
```

### Manual control

```
POST /api/v1/devices/thermostat-bathroom/set   {"setpoint": 22}
POST /api/v1/devices/floor-heating-a/set       {"state":"ON","revert_after":"4h"}
POST /api/v1/groups/floor-heating/set          {"state":"ON","revert_after":"4h"}
```
Audited, limit-checked, goes through `apply_state()` so rules still see it.
`revert_after` = timed override: restore the previous value afterwards.

### Schedules (repeating & one-shot)

| Need | Rule |
|---|---|
| Weekly: Saturday 14:00 | `at` + `days: ["Sat"]` |
| One-shot: ON at 14:00 for 4 h | `once: true` + action `revert_after` |
| Ad-hoc now, revert in 4 h | `POST /set` with `revert_after` |

```jsonc
// weekly
{ "id": "saturday-heat", "when": { "at": "14:00", "days": ["Sat"] },
  "then": [ { "set": { "device": "floor-heating-a", "attr": "state", "value": "ON" } } ] }

// one-shot: ON at 14:00 for 4 h, then auto-restore
{ "id": "adhoc-floor-heat", "once": true, "when": { "at": "14:00" },
  "then": [ { "set": { "device": "floor-heating-a", "attr": "state", "value": "ON", "revert_after": "4h" } } ] }
```

### Groups (aliases)

```jsonc
// one-shot: whole floor heating ON at 14:00 for 4 h
{ "id": "adhoc-floor-heat", "once": true, "when": { "at": "14:00" },
  "then": [ { "set": { "group": "floor-heating", "attr": "state", "value": "ON", "revert_after": "4h" } } ] }
```

### Later (needs home-metrics to publish energy/price to MQTT first)

| Behaviour | Rule sketch |
|---|---|
| Reduce heat when house power > threshold | `if: power > 15000` |
| Shed heat when electricity price spikes | `if: price_with_tax > 0.25` |
| Re-apply while condition stays true | `when: {every: "15m"}` + `if` |

## Rule semantics

- `when` — one trigger: `{device, attr, changed}` (edge), `{device, attr}` (every message),
  `{at: "HH:MM" | "sunrise" | "sunset" | "dusk", offset, days}`, `{every: "15m"}`.
  `days` = `["Mon"…"Sun"]` (omit = every day).
- `if` — `{all: [], any: []}` of `{attr, op, value}`; `op ∈ eq ne gt ge lt le`; `value` literal or `{device, attr}`.
- `for` — act only if `if` still holds after this long; a new `when` event restarts it;
  `if` turning false cancels it. Pending timers survive restarts (stored in `pending.json`).
- `once: true` — one-shot schedule; the rule is deleted after it fires (the firing is recorded in `events.jsonl`).
- action `revert_after: "4h"` — set the value, then restore the previous value afterwards (timed overrides);
  uses the same persisted timers as `for`.
- `group` — named alias → device list, write-only fan-out (no group conditions in v1). Flat, members
  validated at write time; the target attr must exist on every member. Actions use `{device: id}` or `{group: id}`.
- actions: `set` (device or group), `set_curve`, `publish` (raw topic escape hatch).
- `priority` — higher wins when two rules want the same attribute; tie → rule id; conflicts are logged.
- **Deterministic order** — evaluate a tick in `priority` desc / `id` asc; apply all writes after evaluation, never interleaved.
- **Guards** — no write if value unchanged; per-rule rate limit; `limits` reject bad values;
  per-device `locked` flag (vacation/manual override).
- **Echo-safe** — `changed` fires on value change, not message arrival; own write-echoes ignored.
- **Reconnect** — on MQTT reconnect: resubscribe `zigbee2mqtt/#`, `zwave/#`, `home/#`,
  re-request retained, re-evaluate `if` rules.
- **Time** — UTC internally; schedule in `Europe/Helsinki` (zoneinfo); astral for solar events.

## Persistence (cleartext files, no database)

```
data/
  config.json     # {"devices":{...}, "groups":{...}, "rules":{...}} — the human-readable model
  pending.json    # active for / revert_after timers (survive restart)
  events.jsonl    # append-only audit log, one JSON object per line, capped
```

- State (current attribute values) is **in-memory only**, rebuilt from MQTT on boot.
- Writes are rare: `config.json` only when a document is edited; `pending.json` only when a timer is
  armed/cancelled/fired; `events.jsonl` is append-only (no rewrite).
- Bounded size: `events.jsonl` is capped — when it exceeds a size/line limit, rewrite keeping the last
  half; `config.json` grows only with your config; `pending.json` holds only active timers.
- Atomic writes: temp file + `os.replace`. One replica (single writer).
- The server reloads `config.json` on mtime change, so editing files by hand and editing via REST
  converge on the same store (last write wins).
- Backup / review = copy or read the `data/` dir; it is git-friendly.

## Required behaviours (from design review)

1. **Restart semantics** — boot: reload `pending.json`, re-assert time rules once (idempotent via the
   no-write-if-unchanged guard), resubscribe + request retained. State starts unknown; `if` rules wait
   for their first message. State itself is not persisted (in-memory only).
2. **`revert_after` rules** — one active revert per (device, attr); a newer write replaces it; restore
   to the value captured at override time, else the attr `default`, else no-op + warn; reverts survive
   rule disable/delete.
3. **Attribute types** — every attr has `type` (number/string/boolean), optional `enum`, optional
   `scale`/`offset`. Rule `value` validated against type at write time; `gt/ge/lt/le` numeric only.
4. **Referential integrity on DELETE** — `422` if a device/group is referenced by a rule or group;
   ids are immutable (rename = create + move refs).
5. **`publish` escape hatch** — `{ "publish": { "topic": "...", "payload": {"value": "$v"} } }` for
   anything not modelled as a device.
6. **`/metrics` + error surfacing** — rule fires, rule errors, MQTT connected, pending-timer count;
   repeated failures become distinct audit events.

Deferred (hooks only until a real case appears): group *read* conditions (`match: any|all`),
computed/virtual values, `notify`/`http` actions, history/window aggregates, export endpoint.

## REST API (no auth)

```
GET    /api/v1/devices                 GET    /api/v1/rules                 GET    /api/v1/groups
GET    /api/v1/devices/{id}            GET    /api/v1/rules/{id}            GET    /api/v1/groups/{id}
PUT    /api/v1/devices/{id}            PUT    /api/v1/rules/{id}            PUT    /api/v1/groups/{id}
DELETE /api/v1/devices/{id}            DELETE /api/v1/rules/{id}            DELETE /api/v1/groups/{id}
GET    /api/v1/state                   POST   /api/v1/rules/{id}/enable | /disable
GET    /api/v1/state/{device}          POST   /api/v1/rules/{id}/test     # dry-run
POST   /api/v1/devices/{id}/set        POST   /api/v1/groups/{id}/set
GET    /api/v1/events?since=&rule=&limit=
GET    /metrics
GET    /healthz  /readyz
```

- `PUT` idempotent (client-chosen id); invalid device/attr refs rejected `422` at write time.
- `PUT /rules` accepts `once`; `POST /set` body accepts `revert_after`.
- `/openapi.json` + `/docs` available for tooling.

## UI (static page, three tabs)

1. **State** — attributes with value/unit/ts + manual set.
2. **Rules** — list, enable/disable, JSON editor with inline validation, "test" button.
3. **Events** — recent evaluations/actions.

Polling first; SSE only if needed.

## Devices to seed (verified on the live broker)

- **z2m** (29) — 13 temp, 6 powerplugs, 5 motion, 2 contact, 2 buttons, 1 repeater.
- **zwavejs2mqtt** (12) — 8 thermostats, 2 door sensors, powerplug-car, siren-kitchen.
- **home-metrics flattened** — `home/<sensor>/<metric>` (temperature, power, energy, voltage).
- Generated once by `seed/generate_devices.py` from live topics; not a runtime feature.

## Deployment

- `Deployment` (1 replica) + `PVC` for `/data` + `Service` on port 80.
- Env only: `MQTT_URL=mosquitto`, `DATA_DIR=/data`, `TZ`, `LAT`, `LON`, `PORT`.
- Tunnel: add `automator.home.protonode.fi → http://automator:80` in Cloudflare Zero Trust.
- Image: `quay.io/tsaarni/home-automator:v2`.

## Layout

```
src/automator/
  config.py  store.py  models.py  mqtt_gateway.py  state.py
  evaluator.py  scheduler.py  api.py  ui/index.html
seed/devices.json  seed/groups.json  seed/rules.json  seed/generate_devices.py
tests/          # fake clock + in-process fake broker; scenario test per use case
deploy/         # Dockerfile, deployment+service+pvc
```

## Agent task list (execute in order, each with a verification)

1. Scaffold `pyproject.toml` + package + `config.py`; `/healthz` serves.
   ✅ `uv run python -m automator` → HTTP 200 on `/healthz`.
2. `store.py`: JSON-file store — `config.json` (atomic rewrite), `pending.json`, `events.jsonl` (append, capped); mtime reload.
   ✅ unit tests: put/get/list/delete, events append, pending upsert, reload-on-change.
3. `models.py`: `Device`/`Group`/`Rule` pydantic models + ref validation.
   ✅ schema tests: valid docs pass; bad refs/ops/types/units/members rejected with field errors.
4. `mqtt_gateway.py`: wildcard subscribe; topic/path extraction; `apply_state()` with value dedup.
   ✅ fake-broker test: zigbee and zwave payloads both land in state; echoes deduped.
5. `state.py`: current values + `(device,attr) → rules` dependency index.
   ✅ index test: editing a rule updates the index; missing attr reports unknown.
6. `api.py`: full REST surface above (devices/groups/rules) + `/metrics`, OpenAPI, `422` validation.
   ✅ curl each route; `PUT` a rule/group referencing a missing device → `422`; `DELETE` referenced doc → `422`.
7. `evaluator.py`: `when/if/for/then`, `once` (delete after fire), action `revert_after` (one per attr, newer write replaces, restore fallback), group fan-out, priority, guards, dry-run.
   ✅ scenario tests: the 4 "today's behaviour" cases + weekly + one-shot timed override + revert-cancel pass.
8. `scheduler.py`: time/solar/interval wakeups, `zoneinfo`, astral offsets.
   ✅ fake-clock test: fires at 22:00, dusk, and `every: 15m`.
9. Reconnect resync + append-only events writer + boot assert (time rules once) + `pending.json` reload.
   ✅ test: broker drop/reconnect re-evaluates `if` rules; restart re-asserts schedule and reloads timers.
10. `seed/generate_devices.py` → `devices.json` + `groups.json` + `rules.json` (parity set).
    ✅ seed loads into a fresh `data/` dir and passes all scenario tests.
11. `ui/index.html`: state/rules/events tabs + JSON editor + test button + "turn on for N" quick action (device or group).
    ✅ manual set and a timed override via UI appear in `/events` and revert on schedule.
12. `deploy/`: Dockerfile, deployment/service/PVC; build + push `:v2`.
    ✅ `kubectl apply` + tunnel route → UI reachable at `automator.home.protonode.fi`.
13. Cutover: run v2 parallel in dry-run → diff events vs old app → enable → delete old
    deployment/ConfigMap and the `mqtttimer`/`thermostat` code.
14. Follow-up (separate repo): publish energy/price to MQTT in home-metrics, then enable
    power-limit and price-shedding rules.
