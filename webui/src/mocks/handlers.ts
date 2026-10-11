/**
 * A fake backend (§13.1): the fixtures were captured from the real service, so every screen
 * renders without a broker, a port-forward or Python. Writes are applied in memory and show
 * up in the activity log, which is enough to exercise the UI end to end.
 *
 * The catch-all handler at the bottom is deliberate: with the mocks on, an endpoint the mocks
 * do not implement must fail loudly instead of reaching a real house through the dev proxy.
 */
import { HttpResponse, http } from "msw";
import devicesFixture from "./fixtures/devices.json";
import eventsFixture from "./fixtures/events.json";
import groupsFixture from "./fixtures/groups.json";
import readyFixture from "./fixtures/readyz.json";
import rulesFixture from "./fixtures/rules.json";
import timersFixture from "./fixtures/timers.json";

const base = String(import.meta.env.VITE_API_BASE ?? "/api-proxy");

type Json = Record<string, unknown>;

const devices = JSON.parse(JSON.stringify(devicesFixture)) as Json[];
const rules = JSON.parse(JSON.stringify(rulesFixture)) as Json[];
const events = [...(eventsFixture as Json[])];
const timers = JSON.parse(JSON.stringify(timersFixture)) as {
  timers: Json[];
  next_due: Record<string, string>;
};

function record(event: Json): void {
  events.push({ ts: new Date().toISOString(), ...event });
}

function deviceById(id: string): Json | undefined {
  return devices.find((device) => device.id === id);
}

function applySet(device: Json, body: Json): Json[] {
  const state = (device.state ??= {}) as Json;
  const results: Json[] = [];
  for (const [attr, value] of Object.entries(body)) {
    if (attr === "revert_after") continue;
    const previous = ((state[attr] as Json | undefined)?.value ?? null) as unknown;
    const status = previous === value ? "unchanged" : "applied";
    if (status === "applied") state[attr] = { value, ts: new Date().toISOString(), source: "manual" };
    const result = { device: device.id, attr, value, previous, status, rule: null, source: "manual" };
    if (status === "applied") {
      record({ type: "write", ...result });
      if (typeof body.revert_after === "string") {
        const hours = Number(/(\d+)/.exec(body.revert_after)?.[1] ?? 0);
        const due = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        const timer = {
          id: `revert:${device.id}:${attr}`,
          kind: "revert",
          device: device.id,
          attr,
          value: previous ?? "OFF",
          overridden_value: value,
          rule: null,
          created_at: new Date().toISOString(),
          due_at: due,
        };
        timers.timers = timers.timers.filter((item) => item.id !== timer.id);
        timers.timers.push(timer);
        record({
          type: "timer",
          status: "armed",
          kind: "revert",
          device: device.id,
          attr,
          value: timer.value,
          due_at: due,
        });
      }
    }
    results.push(result);
  }
  return results;
}

export const handlers = [
  http.get(`${base}/readyz`, () => HttpResponse.json(readyFixture)),
  http.get(`${base}/api/v1/state`, () =>
    HttpResponse.json(Object.fromEntries(devices.map((device) => [device.id, (device.state ?? {}) as Json]))),
  ),
  http.get(`${base}/api/v1/devices`, () => HttpResponse.json(devices)),
  http.get(`${base}/api/v1/groups`, () => HttpResponse.json(groupsFixture)),
  http.get(`${base}/api/v1/rules`, () => HttpResponse.json(rules)),
  http.get(`${base}/api/v1/timers`, () => HttpResponse.json(timers)),
  http.get(`${base}/api/v1/events`, ({ request }) => {
    const url = new URL(request.url);
    const since = url.searchParams.get("since");
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const matching = since ? events.filter((event) => String(event.ts) >= since) : events;
    return HttpResponse.json(matching.slice(-limit));
  }),

  http.post(`${base}/api/v1/devices/:id/set`, async ({ params, request }) => {
    const device = deviceById(String(params.id));
    if (!device) return HttpResponse.json({ detail: "unknown device" }, { status: 404 });
    return HttpResponse.json({ results: applySet(device, (await request.json()) as Json) });
  }),
  http.post(`${base}/api/v1/groups/:id/set`, () => HttpResponse.json({ results: [] })),

  http.post(`${base}/api/v1/rules/:id/enable`, ({ params }) => {
    const rule = rules.find((item) => item.id === params.id);
    if (rule) rule.enabled = true;
    return HttpResponse.json(rule);
  }),
  http.post(`${base}/api/v1/rules/:id/disable`, ({ params }) => {
    const rule = rules.find((item) => item.id === params.id);
    if (rule) rule.enabled = false;
    return HttpResponse.json(rule);
  }),
  http.post(`${base}/api/v1/rules/:id/test`, ({ params }) =>
    HttpResponse.json({
      rule: params.id,
      trigger: { kind: "at" },
      condition: { satisfied: true, unknown: [], terms: [] },
      deferred_seconds: 0,
      rate_limited: false,
      writes: [
        { device: "powerplug-terrace", attr: "state", value: "ON", previous: "OFF", status: "dry-run" },
      ],
      publishes: [],
    }),
  ),
  http.put(`${base}/api/v1/rules/:id`, async ({ params, request }) => {
    const body = (await request.json()) as Json;
    const index = rules.findIndex((item) => item.id === params.id);
    if (index >= 0) rules[index] = body;
    else rules.push(body);
    return HttpResponse.json(body);
  }),
  http.delete(`${base}/api/v1/rules/:id`, ({ params }) => {
    const index = rules.findIndex((item) => item.id === params.id);
    if (index >= 0) rules.splice(index, 1);
    return HttpResponse.json({ deleted: params.id });
  }),

  http.post(`${base}/api/v1/dry-run`, async ({ request }) => {
    const body = (await request.json()) as { enabled?: boolean };
    (readyFixture as { dry_run: boolean }).dry_run = Boolean(body.enabled);
    return HttpResponse.json({ dry_run: Boolean(body.enabled) });
  }),
  http.post(`${base}/api/v1/reload`, () => HttpResponse.json({ status: "ok" })),

  // Anything else: refuse, loudly, and never fall through to a real backend.
  http.all(`${base}/*`, ({ request }) => {
    console.error("mock backend: unhandled request", request.method, request.url);
    return HttpResponse.json(
      { detail: `the mock backend does not implement ${request.method} ${request.url}` },
      { status: 501 },
    );
  }),
];
