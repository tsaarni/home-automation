# home-webui

A web UI for [`home-automator`](../automator) built around *what you want to do* —
"turn the terrace lights on until midnight", "why didn't the bathroom setback run?" — instead
of around the stored documents.

The design and the reasoning behind every screen live in [PLAN.md](./PLAN.md). This file is
only how to run it.

## Stack

Vite 8 + React 19 + TypeScript (strict), StyleX for styling, react-router 7,
@tanstack/react-query 5 for server state, zod for API response validation, Biome for lint and
format, Vitest for tests.

## Development

```bash
pnpm install
```

### Against the real service (the deployed one)

The UI talks to `VITE_API_BASE`, which defaults to `/api-proxy` in development; Vite strips
that prefix and forwards to `VITE_API_TARGET` (default `http://localhost:8099`). So the usual
development setup is: port-forward the deployed service, then run the dev server.

```bash
# terminal 1 — the real backend, from the cluster
kubectl port-forward -n default svc/homeautomator 8099:80

# terminal 2 — the UI
pnpm dev          # http://127.0.0.1:5273
```

Both are run in the background with `runagent` during agent-driven development:

```bash
runagent run -n automator-pf -- kubectl port-forward -n default svc/homeautomator 8099:80
runagent run -n webui --cwd . --env VITE_API_TARGET=http://localhost:8099 -- pnpm dev
runagent ps                    # what is running
runagent logs webui --last 20  # the dev server output
```

Point it at something else with either variable:

```bash
VITE_API_TARGET=http://localhost:8099 pnpm dev
VITE_API_BASE=https://automator.example pnpm dev   # straight to a tunnel, cookies apply
```

Writes are real when you point at the real house. Use the dry-run switch in
*Advanced → System* (or the automator's `DRY_RUN=true`) while experimenting: the UI then plans
and logs writes without touching anything, and shows them as "would set … (dry run)".

### Without any backend

The fixtures in `src/mocks/fixtures` were captured from the real service (devices, rules,
groups, timers, 2000 events), and MSW replays them with working writes:

```bash
VITE_USE_MOCKS=true pnpm dev
```

### A local automator instead of the cluster

```bash
# in ../automator
uv run python seed/install.py /tmp/automator
DATA_DIR=/tmp/automator PORT=8099 MQTT_URL=none DRY_RUN=true TZ=Europe/Helsinki \
  LAT=60.17 LON=24.94 uv run python -m automator
```

## Checks

```bash
pnpm test        # vitest: schema, schedule round trip, reasons, runs
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome
pnpm build       # tsc --noEmit && vite build → dist/
```

`tests/schedule.roundtrip.test.ts` is the important one: for every real rule the builder must
either reproduce the document byte for byte (modulo key order) or explicitly refuse it as
unrepresentable. It fails if a rule would lose a field on save.

## Deploy

`pnpm build` produces a static `dist/` with no server side. The intended v1 deploy (PLAN §15)
is a small static container that serves `dist/` and reverse-proxies `/api/*`, `/readyz`,
`/metrics` to the automator service — same origin, no CORS, no backend change. Build with an
empty `VITE_API_BASE` in that case.

The container build is in [`infra/docker/webui/Dockerfile`](../infra/docker/webui/Dockerfile).
See the [container build instructions](../infra/docker/README.md#web-ui) for local
builds and runtime configuration.

## Layout

```
src/
  api/        client.ts (fetch + 422 problems) types.ts (zod) queries.ts (react-query) events.ts (rolling window)
  home/       model.ts (rooms, curated things, noisy attributes) derive.ts names.ts
  lib/        schedule.ts (sentence <-> rule) runs.ts (events -> runs) reasons.ts (codes -> sentences) format.ts
  components/ primitives.tsx Control.tsx ThingRow.tsx StatusHeader.tsx ProvenancePanel.tsx Toasts.tsx AppShell.tsx
  features/   home/ schedules/ activity/ advanced/
  mocks/      handlers.ts browser.ts fixtures/
  theme/      tokens.stylex.ts theme.ts global.css
tests/
```
