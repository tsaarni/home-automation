# home-webui — plan

A dedicated web UI for \`home-automator\`, built around **what you want to do**
(*"turn the terrace lights on until midnight"*, *"why didn't the bathroom setback run?"*)
instead of around the stored documents (*rules, attributes, JSON bodies*).

Status: **plan** (rev 2, after review).

Repo: \`~/hobby/home-webui\` (new, separate from \`home-automator\`).
Backend: \`home-automator\` REST API — **unchanged for v1** (upgrade wishes in §16).

---

## 1. Why a new UI

The current UI is a single static \`index.html\` (468 lines, no build step) inside
\`home-automator\`. It is an *admin console for the data model*:

| Tab | What it shows | Why it fails the use case |
|---|---|---|
| State | one table row per **(device, attribute)** — 313 rows for 40 devices | you scroll past \`linkquality\`, \`power-outage-count\`, \`voltage\` to find "terrace lights" |
| Rules | list of rules + a **raw JSON textarea** + "PUT replaces the whole document" | you cannot see *when* a rule runs; writing a schedule means writing JSON |
| Events | flat reverse-chronological table of raw event dicts | no notion of "this schedule ran"; no human reason; no filtering by *thing* |

Concretely missing:

* No "next run" / "last run" per schedule.
* No explanation of a *non*-firing ("skipped: condition_false") — the thing you actually
  want to know at 23:35 when the terrace light is still on.
* No rooms/things — only ids like \`temperature-9-bathroom\`.
* No view of temporary state: an armed \`for\` timer or a \`revert_after\` override is
  invisible until it fires.
* No provenance: nothing says whether a value came from MQTT, a manual set, or which rule
  wrote it (\`source\` *is* in the event log, it just isn't surfaced).

Worth keeping: single origin with the API, no app-level auth (Cloudflare Access at the
edge), the split list/detail pattern, and the honest audit-event feed.

---

## 2. Jobs to be done (the whole design hangs off these)

The user is one household checking things from the sofa. In order of frequency:

1. **"Is everything as it should be right now?"** — glance at the house, see anything
   off (light still on after midnight, bathroom colder than its target, a schedule that
   didn't run).
2. **"Change something for a while."** — terrace lights on for the evening, bathroom a
   bit warmer, all plugs off until morning. Most of these are *temporary*, so every
   control needs "…for 2h / until morning / until next schedule" and a visible restore.
3. **"Set up / adjust a schedule."** — "terrace lights on at dusk, off at 23:30" as one
   idea, without writing JSON.
4. **"Did it run?"** — when did the bathroom setback last fire and what did it do?
   Why did the terrace light *not* turn off last night?
5. **"Why is this value what it is?"** — did I set it, did a schedule set it, or did the
   device just report it?

Everything below exists to make these five fast. Features that don't serve one of them
are cut or deferred.

---

## 3. Design principles

1. **User nouns, not schema nouns.** The app speaks *rooms, things, schedules, runs,
   overrides*. Device ids, attribute names, rule docs and event types never appear in a
   default view (they live in *Advanced*).
2. **Sentences, not forms.** Every schedule reads as a sentence —
   "**At dusk** → turn **Terrace lights** **on**" — in the list, in the builder and in the
   activity log. Editing a schedule looks like editing the sentence.
3. **Thing-centric.** Automations are grouped and browsed by *what they affect*, not by
   their trigger mechanics. "What does my terrace light do?" is a first-class question;
   "Time & sun vs Reactions" is a filter, not the home.
4. **Progressive disclosure.** Primary readings first; noisy telemetry behind "All
   readings"; advanced fields behind "Advanced"; rare event types under "system".
5. **Answer "why".** Every past run and every current value can explain itself in one
   click (reason translation, §9; provenance, §6.2).
6. **Never lie through the abstraction.** If a hand-written rule uses a feature the
   builder does not model, the builder says so and hands you the raw document — it never
   silently drops a field on save (§7.3).
7. **No surprises.** \`dry_run\`, MQTT down, warnings, rule errors and *state that differs
   from what a schedule says it should be* are visible in the header at all times.
8. **Mobile-first.** The most common action is "check and poke from the sofa". Phone
   layout is the default; desktop is the comfortable version of it.

---

## 4. Concepts (the UI's own vocabulary)

| UI noun | Meaning | Backed by |
|---|---|---|
| **Room** | a place: Bathroom, Terrace, Kitchen, Storage… | curated map + id heuristic (§8). No backend concept. |
| **Thing** | a physical device you care about: "Bathroom thermostat", "Terrace lights" | \`device\` |
| **Reading** | one value of a thing: Temperature, Target, Power, Motion | \`device.attributes[attr]\` |
| **Control** | a reading you can write, with a widget: switch, target temperature, on-for | attribute with \`write\` |
| **Schedule** | an automation, shown as a sentence | \`rule\` |
| **Trigger / Condition / Action** | the When / Only-if / Do halves of a schedule | \`when\`, \`if\`+\`for\`, \`then\` |
| **Run** | one evaluation of a schedule with its outcome: ran / did nothing / skipped (why) / failed | derived from events (§9) |
| **Override** | a temporary value with an automatic restore time | \`revert\` timer |
| **Pending** | a schedule waiting for its hold period to elapse | \`for\` timer |
| **Provenance** | where a current value came from | \`source\` / \`rule\` in events |
| **Expected now** | what a schedule says the value *should* be right now, vs what it is | derived: rules × state (§6.3) |

---

## 5. Screens

Four destinations: **Home**, **Schedules**, **Activity**, **Advanced**.

### 5.1 Home (Now)

The default screen. Grid of room cards; phone = single column, desktop = 2–3 columns.

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│  Home          ● live   mqtt up   1 override   ⚠ 1 thing off-schedule   │
├────────────────────────────────────────────────────────────────────────┤
│  TERRACE                                          after 23:30 → OFF    │
│   ● Lights          ON   (17:42, by "Terrace lights on at dusk")       │
│   [ On for 1h ] [ On for 2h ] [ Off ]                                   │
├────────────────────────────────────────────────────────────────────────┤
│  BATHROOM                                                              │
│   23.4 °C    Target 21.0 °C   [−] [+]      mode: heat                  │
│   ▸ until 20:15 the setback will restore 17.0 °C                       │
│   note: your manual change will be reverted by "Bathroom setback"      │
├────────────────────────────────────────────────────────────────────────┤
│  TOILET / KITCHEN / LIVING ROOM / …      Storage: 4 sensors, 2 doors   │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

* A **thing row** shows its primary reading, its control, and (if the value was written
  recently) a *by which* suffix — clicking it opens the provenance panel.
* **On for…** menu (\`30m / 1h / 2h / 4h\`) posts \`{"state":"ON","revert_after":"2h"}\` — the
  \`revert_after\` feature the old UI only exposed as a free-text "For" box.
* **Off** posts \`{"state":"OFF"}\`; **restore now** writes the value the override would
  have restored (\`GET /api/v1/timers\` has it).
* **Waiting-for-reading** state: after a restart, values are unknown until the first MQTT
  message. Unknown readings render as "—" with "waiting for reading", never as 0 or blank.
* **Off-schedule** badge: when a thing's value differs from what its schedule says it
  should be (§6.3), the room header shows "⚠ 1 thing off-schedule" → clicking lists the
  thing, expected vs actual, and the last run that set it.
* **Schedule-will-revert note**: if another rule reacts to this value (from
  \`referenced_by\`), the control shows a one-line heads-up *before* you commit a manual
  change ("your manual change will be reverted by Bathroom setback"). You may be about to
  fight an automation; the UI says so.
* Rooms with too much to show ("Storage" has 4 temp sensors, 2 doors, 2 motion sensors)
  collapse to a one-line summary; expand in place.
* Header: version, MQTT up/down/off, dry-run badge, pending timer count, **Problems**
  popover (readiness warnings, \`rule_error\` in 24 h, \`mqtt_value_error\`), and a **search
  box** (things + schedules; plain text filter, not a command palette).

### 5.2 Schedules

The core screen, organised by **thing**, not by trigger kind.

\`\`\`
┌─ Schedules ─────────────────────────────────────────────┐
│ [ search ] [ + New schedule ]   (filter: all / off)     │
│                                                         │
│ Terrace lights                                    · · · │
│   Dusk ────────────● ON                                 │
│                    │                                    │
│   23:30 ● OFF ─────┘          "on at dusk, off 23:30,   │
│   06:00 ● ON ────┐            on 06:00, off at sunrise"│
│   Sunrise OFF ───┘             next: dusk 17:42 · 3h    │
│                                                         │
│ Bathroom                                                │
│   "revert to 17° after 3h of a manual change"           │
│    last ran yesterday 20:15 → set 17.0 °C               │
│   "target follows the outdoor curve"  last 16:58 → 21.0 │
│                                                         │
│ Toilet: night 24° 22:00 · day 15° 07:00                 │
└─────────────────────────────────────────────────────────┘
\`\`\`

* Each **thing block** lists its schedules and draws a **day strip**: a 24 h line with
  each schedule's fire time and the value it sets. This is the answer to "what does my
  terrace light do?" in one glance, and the natural home for the day-based schedules
  (dusk / 23:30 / 06:00 / sunrise).
* Block header shows the human sentence summary, the next run ("dusk ≈ 17:42, in 3h") and
  the last outcome pill.
* Tapping a schedule opens its detail: sentence (editable), enable/disable, Test, Delete,
  and a **Last runs** table (from the Activity cache, filtered by rule).
* Trigger kind (Time & sun / Reactions / Intervals) remains available as a *filter*, not
  the default grouping.
* **Test** = existing \`POST /api/v1/rules/{id}/test\`, rendered as a sentence: "would set
  Terrace lights to ON" / "conditions not met" / "waiting for a value".
* **Delete** confirms by naming the schedule and its next run.

#### The schedule builder (new / edit)

One dialog, three *sections* (not a wizard):

1. **When** — segmented choice: *At a time* / *At sun* / *When a reading changes* / *Every*.
   - At a time → time field + day chips (Mon…Sun, "every day" default) + optional offset.
   - At sun → dusk/sunrise/sunset/dawn/noon/midnight + "±" offset. The resolved time for
     the next occurrence comes from the backend's \`next_due\` after save; while editing we
     show a plain-clock preview only for *At a time* (no client solar math, §10.3).
   - When a reading changes → thing + reading picker (only attributes that exist).
   - Every → duration field.
   - Global: **One-shot** (\`once: true\`) — "delete this schedule after it runs" (the
     ad-hoc "tonight only" case, invisible in the old UI).
2. **Do** — a list of clauses: target (thing or group) → reading → value widget matching
   the attribute type (switch for enums ON/OFF, number field honouring \`limits\`, boolean
   toggle, text) + optional **"for … then restore"**. Plus optional **Only if** ("Only if
   Backyard temperature is below 0") and **"stays that way for"** (\`for\`) behind
   "+ only if…".
3. **Name & save** — name (prefilled from the sentence, editable), description, enabled.
   **Advanced** disclosure: id (immutable, auto-slugged), priority, rate limit, raw JSON.

Round-trip safety (§7.3): the builder edits a *copy of the whole rule document*, so
fields it does not understand survive the save.

### 5.3 Activity

One screen answering "what happened, and what is about to happen".

\`\`\`
┌─ Activity ─── [ Bathroom setback ▾ ] [ any outcome ▾ ] [ 24h ▾ ] ───────────────┐
│ 17:41  Ran      Terrace lights on at dusk      → Terrace lights ON (was OFF)     │
│ 17:12  Skipped  Bathroom setback               conditions not met                 │
│ 16:58  Ran      Bathroom heating curve         → target 21.0 °C (was 21.5 °C)    │
│ 16:30  Manual   Terrace lights                  OFF by me (was ON)               │
├─ Upcoming ───────────────────────────────────────────────────────────────────────┤
│ 20:15  Bathroom setback will restore 17.0 °C                                     │
│ 23:30  Terrace lights off at 23:30                                               │
│ 06:00  Terrace lights on at 06:00                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
\`\`\`

* Filters stay minimal: **schedule**, **outcome**, **recent window**. Default view is
  "everything, newest first"; a reading-noise filter hides \`state\` rows (opt-in to show).
* Rows are **Runs**, not raw events: a run groups the trigger, its \`write\`/\`publish\`
  events and its outcome into one line with an expandable detail (raw event JSON under
  *details*).
* **Outcomes**: *ran* (wrote something), *nothing to do* (all writes \`unchanged\`),
  *skipped* (reason), *failed* (reason), *manual*, *reading* (hidden by default).
* **Upcoming**: everything with a \`due_at\` (\`for\` + \`revert\` timers) plus every
  schedule's next fire from \`/api/v1/timers\`, flat and sorted with countdowns.
* **Per-schedule history** (7 days) lives on the schedule detail: one row per day × run —
  "did the bathroom setback run this week?" in one glance.
* All timestamps render in the house timezone (§10.1): absolute ("23:30") + relative
  ("in 1h 50m").

### 5.4 Advanced

Power-user / plumbing, deliberately out of the way:

* **Readings** — the old *State* tab as a filterable table over **all** attributes
  (including \`linkquality\`, battery, power), with manual set + \`revert_after\` (parity
  for anything uncurated).
* **Things & Groups** — list + raw JSON PUT edit, locked toggle, and the API's 422
  validation surfaced inline. A fancy editor is deferred: this user edits devices
  ~never (the seed generates them).
* **Schedules (raw)** — every rule as JSON with the backend "Test" button. Keeps the
  useful half of the old Rules tab for anything the builder can't express.
* **System** — \`/readyz\` payload, warnings, dry-run switch (\`POST /api/v1/dry-run\`),
  reload (\`POST /api/v1/reload\`), metrics link.

---

## 6. Detail behaviours

### 6.1 Upcoming & pending

\`GET /api/v1/timers\` → \`{timers: [...], next_due: {rule_id: iso|null}}\`, merged into one
sorted list:

| Source | Rendered as |
|---|---|
| timer \`kind=revert\` (\`device\`, \`attr\`, \`value\`, \`due_at\`) | "Terrace lights → back to OFF at 23:30 (in 1h 50m)" |
| timer \`kind=for\` (\`rule\`, \`trigger\`, \`due_at\`) | "Bathroom setback → will restore 17 °C at 20:15, if the target is still ≠ 17 °C" |
| \`next_due[rule]\` for \`at\`/\`every\` rules | "Terrace lights on at dusk — next 17:42 tomorrow" |

\`next_due\` only exists for schedules the scheduler armed (\`at\`/\`every\`), which is
exactly the set worth listing.

### 6.2 Provenance: "why is this value like this?"

The last matching \`write\` or \`state\` event gives \`{ts, value, previous, source, rule}\`:

* \`source: manual\` → "**You** set it at 16:30 (was ON)" + *set back* (writes \`previous\`).
* \`source: rule:<id>\` → "**Bathroom heating curve** at 16:58 (was 21.5 °C)" + link.
* \`source: mqtt\` → "Reported by the device at 17:01".
* nothing in the window → "Unknown (older than the event log)".

"Set back" is a plain manual set to the previous value — it is *not* an undo (a schedule
may well write the value again), and the label says so.

### 6.3 Expected-now: "is the house as the schedules say it should be?"

For each thing's controllable reading, derive the value its schedules *would* have set at
the last relevant fire, and compare with the current value. A mismatch after a recent run
→ "off-schedule" flag (Home badge, thing row, Problems popover).

Deliberately heuristic and non-alarming: only for readings with a \`write\` spec and a
\`state\`/\`write\` event to compare against; a flag is "this looks off", never "the house
is broken". Toggleable, and every flag links to the runs involved.

### 6.4 Feedback & rollback on actions

* Manual controls are **optimistic** (the switch flips immediately), then reconciled by
  the next state poll or the \`POST\` response's \`write.status\`.
* \`applied\` → quiet; \`unchanged\` → "already ON"; \`skipped\`/\`error\` → the switch
  snaps back with a toast carrying the human reason (§9). A failed publish must never
  leave a control showing the wrong state.
* When MQTT is down (\`readyz.mqtt_connected: false\`), write controls are dimmed with a
  one-line explanation — clicking still works (the backend will error or queue) but the
  user isn't surprised.

---

## 7. The translation layer (the heart of it)

### 7.1 Schedule sentence ↔ rule document

| UI control | rule document |
|---|---|
| Schedule name / notes | \`name\` / \`description\` |
| Enabled toggle | \`enabled\` |
| "One-shot, delete after it runs" | \`once: true\` |
| *At a time* | \`when.at = "HH:MM"\` |
| *At sun* | \`when.at ∈ sunrise, sunset, dusk, dawn, noon, midnight\` |
| "± 30 min" | \`when.offset = "-30m"\` (solar only) |
| Day chips | \`when.days = ["Mon", …]\` (only valid with \`at\`) |
| *When a reading changes* | \`when.device + when.attr + changed: true\` |
| *When a reading is reported* | same without \`changed\` |
| *Every N* | \`when.every = "15m"\` |
| "only if …" | \`if: {all: [{attr: [device, attr], op, value}]}\` |
| "…stays like that for 3h" | \`for: "3h"\` |
| "Do: X → on/17/…" | \`then[i].set = {device \| group, attr, value}\` |
| "for 4h, then restore" | \`then[i].set.revert_after = "4h"\` |
| "Do: follow the heating curve" | \`then[i].set_curve = {…, x: {device, attr}, points}\` |
| Advanced: priority / rate limit | \`priority\` / \`rate_limit\` |

Builder-side hints mirror the backend validation (models.py) so the builder cannot
produce a document the API rejects: \`days\` needs \`at\`; \`offset\` needs a solar \`at\`;
\`changed\` needs a device trigger; exactly one of device/attr, at, every; \`if\` has exactly
one of \`all\`/\`any\`; a group action needs the attribute on every member (checkable from
the devices payload).

### 7.2 Value widgets come from the attribute

\`type\` → widget; \`enum\` → switch/select (ON/OFF becomes a real switch); \`unit\` → suffix;
\`limits\` → number input min/max + slider; no \`write\` spec → read-only ("sensor only");
\`device.locked\` → disabled with "device is locked". \`scale\`/\`offset\` are the backend's
business; the UI shows values rounded with units.

### 7.3 Round-trip guarantee

The editor holds the **full original document** and applies a *patch* produced by the
sentence builder. Consequences:

* unknown/advanced fields survive an edit;
* a document the builder cannot represent (\`if.any\`, \`ValueRef\` comparisons, \`publish\`
  actions, mixed \`then\` kinds, more than the supported shapes) opens in **raw mode** with
  the banner "This schedule uses features the builder doesn't show yet";
* a unit test asserts: for each of the 9 seed rules, \`parse(rule) → build() → deepEqual(rule)\`
  or \`unrepresentable(rule) === true\`.

---

## 8. Home model (curation)

The backend knows nothing about rooms. The UI owns a small hand-maintained map —
\`src/home/model.ts\` — plus heuristics so a newly seeded device still shows up sensibly.

\`\`\`ts
export const rooms = [
  { id: 'terrace',   name: 'Terrace',   order: 1 },
  { id: 'bathroom',  name: 'Bathroom',  order: 2 },
  { id: 'toilet',    name: 'Toilet',    order: 3 },
  // …
] as const;

export const things: Record<string, ThingMeta> = {
  'thermostat-bathroom': {
    room: 'bathroom', kind: 'thermostat', name: 'Bathroom thermostat',
    primary: ['temperature', 'setpoint'],
    controls: [{ attr: 'setpoint', label: 'Target', kind: 'temperature', step: 0.5 }],
  },
  'powerplug-terrace': {
    room: 'terrace', kind: 'light', name: 'Terrace lights',
    primary: ['state'],
    controls: [{ attr: 'state', kind: 'switch', on: 'ON', off: 'OFF' }],
  },
  // ~15 curated entries cover everything you touch; the rest are auto-derived
};
\`\`\`

Fallbacks (curation is optional, never blocking):

* room from the id: \`temperature-9-bathroom\` → Bathroom if the suffix matches a known
  room; \`thermostat-toilet\` → Toilet; unknown → **Other**.
* kind from the prefix: \`powerplug\` → plug, \`thermostat\` → thermostat, \`temperature\` →
  sensor, \`motion\` → motion, \`door\` → contact, \`button\` → button, \`siren\` → siren.
* primary reading = first of a preference list present on the device (\`temperature\`,
  \`state\`, \`contact\`, \`occupancy\`, …).
* noisy attributes hidden by default in curated views: \`linkquality\`, \`voltage\`,
  \`battery\`, \`battery-low\`, \`power-outage-count\`, \`trigger-count\`, \`*-ep0\`, \`status\`,
  \`device-temperature\` — visible under *All readings* in Advanced.

A plain TS module ⇒ changing the UI's mental model of the house needs no backend change.

---

## 9. Human reasons (translation tables)

Every backend enum gets one sentence. Nothing else in the UI shows a raw code.

**Event type → row kind**

| \`type\` | Row |
|---|---|
| \`rule_fire\` | Ran (with \`writes\`/\`publishes\` counts) |
| \`rule_skip\` (\`reason\`) | Skipped — reason |
| \`rule_error\` (\`error\`) | Failed — error |
| \`rule_once\` (\`action: consumed\`) | One-shot consumed, schedule deleted |
| \`write\` (\`status\`) | Action / Manual: applied, unchanged, dry-run, skipped, error |
| \`state\` | Reading changed (MQTT) — hidden by default |
| \`timer\` (\`status\`, \`kind\`) | Pending: armed / fired / cancelled / dropped / refused |
| \`schedule\` (\`action: catch_up\`) | Caught up a missed run (late by N) |
| \`conflict\` | Two schedules wanted the same value — one won by priority |
| \`publish\` / \`mqtt\` / \`boot\` / \`config\` / others | System line (collapsed) |
| \`mqtt_value_error\`, \`rule_depth_limit\` | Problem (feeds the Problems popover) |

**\`rule_skip.reason\` → sentence**

| reason | sentence |
|---|---|
| \`condition_false\` | "conditions were not met" (+ which term, from \`unknown\`/\`terms\`) |
| \`unknown_value\` | "waiting for a reading from <device.attr>" |
| \`rate_limited\` | "ran again too soon (limit N s)" |
| \`no_curve_input\` | "<device.attr> is not known, cannot follow the curve" |

**\`write.status\` → sentence**

| status/reason | sentence |
|---|---|
| \`applied\` | "set to X (was Y)" |
| \`unchanged\` | "already X, nothing to do" |
| \`dry-run\` | "would set to X (dry run)" |
| \`skipped\`/\`device_locked\` | "device is locked" |
| \`error\`/\`publish_failed\` | "couldn't reach the device" |
| \`error\`/\`outside limits\` / \`not one of\` | the value problem in words |

**Trigger → sentence**: \`{kind: at, ts}\` → "tonight at 23:30"; \`{kind: state, device, attr,
value, changed}\` → "Backyard temperature changed to −4.0 °C"; \`{kind: timer}\` → "3 h after
the change"; \`{kind: every}\` → "15-minute check"; \`{kind: resync}\` → "after reconnect".

---

## 10. Data layer

### 10.1 Time & timezone (a correctness rule, stated once)

The API returns ISO-8601 UTC with millisecond precision. **Every timestamp is rendered in
the house timezone** — taken from \`GET /readyz\` (\`timezone\`), not the browser's zone —
as absolute ("23:30") plus relative ("in 1h 50m"), via \`Intl\`. Never show a raw UTC wall
time; a phone abroad must still see "17:42", not "15:42".

### 10.2 Endpoints used (no backend change needed)

| Purpose | Call | Cadence |
|---|---|---|
| Health, warnings, counts, timezone | \`GET /readyz\` | 5 s |
| Room/thing state | \`GET /api/v1/state\` (one call, all values) | 2 s |
| Things + which rules touch them | \`GET /api/v1/devices\` (\`state\` + \`referenced_by\`) | 60 s / on focus / after edit |
| Groups | \`GET /api/v1/groups\` | 60 s |
| Schedules | \`GET /api/v1/rules\` | 30 s + after edit |
| Upcoming / pending | \`GET /api/v1/timers\` | 5 s |
| Activity | \`GET /api/v1/events?limit=2000\` then \`?since=<lastTs>\` deltas | 2 s |
| Control | \`POST /devices/{id}/set\`, \`POST /groups/{id}/set\`, \`POST /rules/{id}/enable\|disable\|test\`, \`PUT /rules/{id}\` | on action |

Client cache keeps the newest 2000 events (the server caps \`limit\` at 2000 and trims
\`events.jsonl\`, so this is a rolling window). \`since\` is **inclusive** in the backend and
timestamps have ms precision, so a delta re-fetches the last millisecond's events —
de-duplicate by a composite key \`ts|type|rule|device|attr|status\`.

If polling ever hurts, the next step is a backend SSE endpoint (§16) — the client is
written against a single \`useEvents()\` hook, so that swap is local.

### 10.3 Next-occurrence (authoritative, not duplicated)

The backend is the authority on next fire times: \`GET /api/v1/timers\` → \`next_due\` covers
\`at\` and \`every\` rules. The UI does **not** re-implement \`scheduler.py\` (days, offsets,
solar depression, catch-up) — that logic would drift. While *editing* an *At a time*
schedule, show a trivial clock/days preview ("next: today 17:42, tomorrow 17:42"); for
solar triggers show no time until saved, then read \`next_due\`. No client solar library.

### 10.4 Derived indices (client-side)

* \`rulesByTarget: (device|group) → rule[]\` — from \`then\`, for the "used by" badge and the
  schedule-will-revert note.
* \`nextFire: rule → {iso, timer?}\` — \`next_due\` + timers merged.
* \`runs: Run[]\` — events grouped by schedule (§9) with small time windows.
* \`lastOutcome: rule → Run\` — for the list pills.
* \`provenance: (device, attr) → Event\` — last \`write\`/\`state\`.
* \`expected: (device, attr) → {value, run}\` — §6.3.

---

## 11. Design system & styling (StyleX)

* \`@stylexjs/stylex\` for styles, \`@stylexjs/unplugin\` for Vite.
* \`src/theme/tokens.stylex.ts\` — \`defineVars\`: color (bg, surface, surface-raised, border,
  text, text-muted, accent, ok, warn, bad), space 1–8, radius, font sizes, line heights,
  shadow.
* Dark mode: tokens defined for light plus a \`stylex.createTheme(tokens, dark)\` class
  applied on \`<html>\` from a \`prefers-color-scheme\` listener (manual override in the
  header). Dark is the primary target (evening use).
* Dynamic values go through CSS custom properties: a class references \`var(--dial)\`, the
  component sets \`style={{ '--dial': … }}\` — used for temperature hue, day-strip marks,
  any value-derived colour.
* Primitives built as needed, starting from ~8: \`Stack\`/\`Row\`, \`Card\`, \`Button\`,
  \`Toggle\`, \`Badge\`, \`Field\` (+ \`NumberField\`/\`TimeField\`/\`DurationField\`), \`Dialog\`/
  \`Sheet\`, \`Sentence\`, \`Timeline\`. No component library.
* Typography: system font stack, tabular numerals for readings; the \`Sentence\` component
  renders selectable "chips" for the editable slots, so editing a schedule looks like
  editing the sentence you just read.
* Breakpoints: 0 / 640 / 1024. Phone gets a bottom tab bar; desktop a left rail.

---

## 12. Tech stack & layout

Runtime: Node 26 (installed), **pnpm 12** (preferred over npm).

| Concern | Choice | Why |
|---|---|---|
| Build | **Vite 8** (\`@vitejs/plugin-react\`) | asked for; fast HMR |
| UI | **React 19** + TypeScript (strict) | |
| Styling | **StyleX** (\`stylex\`, \`unplugin\`) | asked for; no runtime CSS-in-JS cost, typed tokens |
| Routing | **react-router 7** (declarative) | 4 destinations, no SSR |
| Server state | **@tanstack/react-query 5** | polling, caching, optimistic control updates |
| Validation | **zod** for API responses | catches backend drift early, typed fixtures |
| Lint + format | **Biome** (\`@biomejs/biome\`, single \`biome.json\`) | fast, one tool for both; replaces eslint + prettier |
| Tests | **vitest** + \`@testing-library/react\` + **MSW** for the fake backend | |

Note on StyleX linting: \`@stylexjs/eslint-plugin\` doesn't apply under Biome, so StyleX
correctness relies on the TypeScript types plus the unplugin's dev warnings. Acceptable.

\`\`\`
home-webui/
  PLAN.md
  package.json  pnpm-lock.yaml  tsconfig.json  vite.config.ts  biome.json  index.html
  .env.development            # VITE_API_BASE=/api-proxy
  src/
    main.tsx  App.tsx  routes.tsx
    api/         client.ts types.ts queries.ts        # endpoints + zod schemas
    home/        model.ts (rooms, things, noisy attrs) derive.ts
    lib/         schedule.ts (parse/build/preview) runs.ts reasons.ts format.ts
    theme/       tokens.stylex.ts global.stylex.ts
    components/  primitives/… Sentence.tsx Timeline.tsx StatusHeader.tsx
    features/
      home/      HomeScreen.tsx RoomCard.tsx ThingRow.tsx Control.tsx Upcoming.tsx
      schedules/ ScheduleList.tsx ScheduleDetail.tsx ScheduleBuilder.tsx History.tsx
      activity/  ActivityScreen.tsx RunRow.tsx Provenance.tsx
      advanced/  ReadingsTable.tsx RawDocuments.tsx System.tsx
    mocks/       handlers.ts (MSW) fixtures/*.json (copied from home-automator/seed)
  tests/         schedule.roundtrip.test.ts reasons.test.ts runs.test.ts …
\`\`\`

---

## 13. Dev workflow

1. **Fake backend for pure UI work**: MSW handlers replay the copied seed fixtures
   (\`devices.json\`, \`groups.json\`, \`rules.json\`) plus a scripted event log (a firing
   dusk run, a skipped setback, an override) — covers every screen with no broker, no
   Python.
2. **Real backend locally**:
   \`\`\`bash
   # in ~/hobby/home-automator
   uv run python seed/install.py /tmp/automator
   DATA_DIR=/tmp/automator PORT=8099 MQTT_URL=none DRY_RUN=true TZ=Europe/Helsinki \
     LAT=60.17 LON=24.94 uv run python -m automator
   # in ~/hobby/home-webui
   pnpm dev               # Vite proxy /api-proxy → http://localhost:8099
   \`\`\`
   \`DRY_RUN=true\` means controls are safe to click: writes are planned, logged and visible
   in Activity without touching anything.
3. **Against the real house** (read-mostly): point \`VITE_API_BASE\` at
   \`https://automator.home.protonode.fi\` (Cloudflare Access cookies apply).

---

## 14. Testing

Tests cover the two places where this UI can actually hurt the user — losing rule fields,
and showing a wrong or unexplained state:

* \`schedule.roundtrip.test.ts\` — every seed rule: parse → sentence → build → deep equal,
  or flagged unrepresentable (§7.3). This is the critical "no data loss" guarantee.
* \`reasons.test.ts\` — the reason/status tables produce a sentence, and a
  table-completeness check fails loudly when a new backend code appears blank.
* \`runs.test.ts\` — event fixtures → run grouping, outcomes, skip reasons, provenance.
* Component test for the builder: type a schedule, assert the produced document; and for
  Home controls: assert the \`POST\` body (including \`revert_after\`).
* No exhaustive scheduler-parity tests (the UI does not re-implement the scheduler, §10.3).

---

## 15. Build & deploy

* \`pnpm build\` → \`dist/\` (static, no server).

* **Primary (v1): a small static container in front of the API.**
  Caddy/nginx serves \`dist/\` **and reverse-proxies \`/api/*\` → \`automator:80\`**. Same
  origin ⇒ no CORS, no backend change, and the UI can be rolled back without touching
  Python. A new tunnel route points at this container (Cloudflare Access as before).

* **Later: serve \`dist/\` from the \`home-automator\` image.** Needs a small backend change
  (\`GET /ui/*\` → serve a directory, §16.4). One fewer container, same origin and access
  policy as today.

Both work because all calls go through \`VITE_API_BASE\`.

---

## 16. Backend asks (optional, small, none required for v1)

1. \`GET /api/v1/rules\` — include \`last_fired\` (\`store.get_last_fired\` exists). Removes
   deriving "last run" by scanning events.
2. \`GET /readyz\` — include \`latitude\`, \`longitude\`, \`elevation\`, \`events_max_limit\`.
   Removes hard-coded limits; (no longer needed for solar preview, which we cut).
3. \`GET /api/v1/snapshot\` — devices+state+groups+rules+timers in one response (fewer
   polls, atomic view of a tick).
4. \`GET /ui/*\` — serve the built UI directory (or honour a \`UI_DIR\` env).
5. \`POST /api/v1/rules/{id}/run\` — "run this schedule now" (the \`test\` endpoint is a dry
   run; users will expect a real one).
6. Later: \`GET /api/v1/stream\` (SSE of the event log) — replaces 2 s polling.

---

## 17. Roadmap

Each phase ends in something usable, verified against the fake backend plus a local
\`DRY_RUN\` automator.

| # | Phase | Deliverable | Verified by |
|---|---|---|---|
| 0 | Scaffold | pnpm + Vite+React+TS+StyleX, Biome, tokens, app shell + nav, API client + zod types, MSW fixtures from seed, dev proxy | \`pnpm dev\` shows rooms/things with fake data; \`pnpm build\` clean |
| 1 | Home (Now) | room cards, thing rows, controls (switch / target temp / on-for / off) with optimistic rollback + toasts, header status + Problems, Upcoming strip, waiting-for-reading state | against \`DRY_RUN\` automator: toggling produces a \`write\` event; override appears in \`/timers\` |
| 2 | Schedules | thing-centric list + day strip, builder (create/edit) with round-trip, enable/disable, one-shot, Test, raw escape hatch, schedule-will-revert note | building the 4 parity schedules from scratch reproduces \`seed/rules.json\` (round-trip test); API 422s surfaced inline |
| 3 | Activity | timeline with filters, run grouping, human reasons, upcoming section, provenance panel, per-schedule 7-day history | seeded dusk/setback/build events render as "Ran / Skipped / Pending" in words, not codes |
| 4 | Overrides | full pending/override view, restore-now, hold (\`for\`) explanation | an override set in Home shows countdown, disappears after restore |
| 5 | Polish | off-schedule flags (§6.3), search, mobile tab bar, empty/error/dry-run states, rare-event collapse | phone + desktop pass; "terrace still on at 23:35" is visible at a glance |
| 6 | Deploy | static container + tunnel route (or in-image if §16.4 lands), Playwright smoke | UI reachable at the tunnel host; controls work in dry-run then live |

### Acceptance criteria (what "much more usable" means, testably)

1. From Home, in ≤ 2 taps: turn the terrace lights on **for 2 hours**, and see the
   automatic restore listed with a countdown.
2. Create "terrace lights on at dusk" **without seeing a single line of JSON**.
3. Answer *"what does my terrace light do?"* on one screen (day strip + next run).
4. Answer *"when did the bathroom setback last run and what did it do?"* on one screen.
5. Answer *"why did nothing happen?"* for any schedule with a human sentence, not a code.
6. Every existing rule (including hand-written ones with features the builder lacks) is
   displayed as a sentence or flagged raw, and is editable **without losing fields**.
7. No attribute id, event type or rule field name appears in a default view.

### Non-goals

* No historical charts/dashboards (no time-series backend; \`home-metrics\`/Grafana owns that).
* No auth, no multi-user, no mobile app, no offline mode.
* No editing of MQTT topic bindings in the fancy builder (Advanced → raw JSON).
* No new automation semantics: the UI writes the same rule documents the backend accepts.
* No client re-implementation of the scheduler (next-run times come from the backend).

---

## 18. Open questions

1. Rooms: curated TS map (fast, code change) vs. a UI-side JSON editable in Advanced?
   *(Plan assumes TS first; a JSON loader is a small refactor.)*
2. \`set_curve\` and \`publish\` in the builder, or raw mode only? *(Plan: raw mode for
   \`publish\`, a dedicated "heating curve" builder later.)*
3. Groups as first-class Home targets ("all plugs off"), or schedules-only? *(Plan:
   schedules first.)*
4. Deploy as its own static container (v1) vs. in-image (§15)?
5. Event retention is 2 MB / newest half — is the 7-day history view still useful, or
   should the UI keep its own rolling history in \`localStorage\`? *(Plan: rely on the log;
   add local persistence only if it proves too short.)*
6. The "off-schedule" heuristic (§6.3) can produce false positives (e.g. a schedule fired
   but a *newer* schedule legitimately changed the value). Decide the default sensitivity
   during phase 5: only flag the primary control reading, only within 24 h, and always
   link to the runs.
