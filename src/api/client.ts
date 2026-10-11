import { z } from "zod";
import {
  type Device,
  deviceSchema,
  type Event,
  eventSchema,
  type Group,
  groupSchema,
  type Ready,
  type Rule,
  readySchema,
  ruleSchema,
  type Scalar,
  type StateSnapshot,
  stateSnapshotSchema,
  type TestReport,
  type Timers,
  testReportSchema,
  timersSchema,
  type WriteResult,
  writeResponseSchema,
} from "./types";

/** Same-origin in production; the Vite dev proxy (`/api-proxy`) in development. */
export const apiBase = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

/** An error carrying the backend's human-readable `detail` problems (422s). */
export class ApiError extends Error {
  readonly status: number;
  readonly problems: string[];

  constructor(status: number, problems: string[]) {
    super(problems.join("; ") || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.problems = problems;
  }
}

function problemsFrom(status: number, body: unknown): string[] {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return [detail];
  if (Array.isArray(detail)) {
    return detail.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  }
  if (detail !== undefined) return [JSON.stringify(detail)];
  if (status === 0) return ["the backend is unreachable"];
  return [`HTTP ${status}`];
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError(0, [`could not reach the backend: ${(cause as Error).message}`]);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) throw new ApiError(response.status, problemsFrom(response.status, body));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(response.status, [`unexpected response shape: ${parsed.error.message}`]);
  }
  return parsed.data;
}

export type WriteBody = Record<string, Scalar | null> & { revert_after?: string };

export const api = {
  base: apiBase,

  readyz: () => request("/readyz", readySchema),

  state: () => request("/api/v1/state", stateSnapshotSchema),
  devices: () => request("/api/v1/devices", z.array(deviceSchema)),
  device: (id: string) => request(`/api/v1/devices/${encodeURIComponent(id)}`, deviceSchema),
  groups: () => request("/api/v1/groups", z.array(groupSchema)),
  rules: () => request("/api/v1/rules", z.array(ruleSchema)),
  rule: (id: string) => request(`/api/v1/rules/${encodeURIComponent(id)}`, ruleSchema),
  timers: () => request("/api/v1/timers", timersSchema),

  events: (params: { since?: string; limit?: number; rule?: string; kind?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.since) query.set("since", params.since);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.rule) query.set("rule", params.rule);
    if (params.kind) query.set("kind", params.kind);
    const suffix = query.toString();
    return request(`/api/v1/events${suffix ? `?${suffix}` : ""}`, z.array(eventSchema)) as Promise<Event[]>;
  },

  setDevice: (id: string, body: WriteBody) =>
    request(`/api/v1/devices/${encodeURIComponent(id)}/set`, writeResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((it) => it.results as WriteResult[]),

  setGroup: (id: string, body: WriteBody) =>
    request(`/api/v1/groups/${encodeURIComponent(id)}/set`, writeResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((it) => it.results as WriteResult[]),

  putRule: (rule: Rule) =>
    request(`/api/v1/rules/${encodeURIComponent(rule.id)}`, ruleSchema, {
      method: "PUT",
      body: JSON.stringify(rule),
    }),

  deleteRule: (id: string) =>
    request(`/api/v1/rules/${encodeURIComponent(id)}`, z.looseObject({ deleted: z.string() }), {
      method: "DELETE",
    }),

  setRuleEnabled: (id: string, enabled: boolean) =>
    request(`/api/v1/rules/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, ruleSchema, {
      method: "POST",
    }),

  testRule: (id: string, now?: string) =>
    request(`/api/v1/rules/${encodeURIComponent(id)}/test`, testReportSchema, {
      method: "POST",
      body: JSON.stringify(now ? { now } : {}),
    }) as Promise<TestReport>,

  putDevice: (id: string, doc: unknown) =>
    request(`/api/v1/devices/${encodeURIComponent(id)}`, deviceSchema, {
      method: "PUT",
      body: JSON.stringify(doc),
    }) as Promise<Device>,

  putGroup: (id: string, doc: unknown) =>
    request(`/api/v1/groups/${encodeURIComponent(id)}`, groupSchema, {
      method: "PUT",
      body: JSON.stringify(doc),
    }) as Promise<Group>,

  dryRun: (enabled: boolean) =>
    request("/api/v1/dry-run", z.looseObject({ dry_run: z.boolean() }), {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),

  reload: () => request("/api/v1/reload", z.looseObject({ status: z.string() }), { method: "POST" }),
};

export type { Device, Event, Group, Ready, Rule, StateSnapshot, Timers, WriteResult };
