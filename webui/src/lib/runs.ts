/**
 * Event log -> runs. A `rule_fire` and the writes it produced become one row, so the
 * activity list answers "what happened" instead of "which events exist".
 */
import type { Event, Rule, StateSnapshot, Timer } from "@/api/types";
import type { Home } from "@/home/derive";
import { type Outcome, outcomeFromWrites, rowOf } from "./reasons";

const GROUP_WINDOW_MS = 5000;

export interface Run {
  id: string;
  ts: string;
  outcome: Outcome;
  rule: string | null;
  source: "schedule" | "manual" | "system";
  /** the event that started the row */
  event: Event;
  writes: Event[];
  publishes: Event[];
  reason: string | null;
  error: string | null;
  /** seconds late, for a catch-up row */
  lateSeconds?: number;
}

/** A `write` event already carries the fields of a WriteResult. */
function writeFromEvent(event: Event) {
  return event as unknown as Parameters<typeof outcomeFromWrites>[0][number];
}

function outcomeFor(event: Event, writes: Event[]): Outcome {
  if (writes.length) {
    const outcome = outcomeFromWrites(latestWrites(writes).map(writeFromEvent));
    return outcome === "ran" && !event.rule && event.type !== "rule_fire" ? "manual" : outcome;
  }
  return rowOf(event);
}

/** Events of any order in, newest-first runs out. */
export function buildRuns(events: Event[], windowMs = GROUP_WINDOW_MS): Run[] {
  const expanded = events.flatMap((event) => {
    if (event.type !== "command_result" || event.attr || !event.request_id) return [event];
    const attrs = new Map(
      events
        .filter((e) => e.type === "write" && e.request_id === event.request_id && e.attr)
        .map((e) => [`${e.device}|${e.attr}`, e]),
    );
    return attrs.size
      ? [...attrs.values()].map((write) => ({
          ...write,
          ...event,
          device: write.device,
          attr: write.attr,
          value: event.value ?? write.value,
          rule: event.rule ?? write.rule,
        }))
      : [event];
  });
  const ordered = expanded.sort((a, b) => a.ts.localeCompare(b.ts));
  const runs: Run[] = [];
  const openByRule = new Map<string, Run>();
  const byRequest = new Map<string, Set<Run>>();
  const rememberRequest = (id: string, run: Run) => {
    const known = byRequest.get(id) ?? new Set<Run>();
    known.add(run);
    byRequest.set(id, known);
  };

  const open = (base: { ts: string; rule: string | null; event: Event; outcome: Outcome }): Run => {
    const run: Run = {
      id: `${base.ts}|${base.rule ?? "-"}|${runs.length}`,
      ts: base.ts,
      rule: base.rule,
      source: base.rule
        ? "schedule"
        : ["write", "command_result"].includes(base.event.type)
          ? "manual"
          : "system",
      event: base.event,
      outcome: base.outcome,
      writes: [],
      publishes: [],
      reason: null,
      error: null,
    };
    runs.push(run);
    if (run.rule) openByRule.set(run.rule, run);
    return run;
  };

  const attach = (event: Event, target: "writes" | "publishes"): boolean => {
    const request = typeof event.request_id === "string" ? event.request_id : null;
    const candidates = request ? [...(byRequest.get(request) ?? [])] : [];
    const correlated =
      candidates.find((r) =>
        event.rule
          ? r.rule === event.rule
          : r.writes.some((w) => w.device === event.device && w.attr === event.attr),
      ) ?? candidates.find((r) => !r.rule && !event.rule);
    if (correlated) {
      correlated[target].push(event);
      correlated.outcome = outcomeFor(correlated.event, correlated.writes);
      return true;
    }
    // A result with an unknown request must not attach to a nearby execution.
    if (event.type === "command_result") return false;
    const ruleId = event.rule;
    if (!ruleId) return false;
    const run = openByRule.get(ruleId);
    if (run?.event.type !== "rule_fire" || run.writes.length + run.publishes.length >= 64) return false;
    const gap = new Date(event.ts).getTime() - new Date(run.ts).getTime();
    if (gap < 0 || gap > windowMs) return false;
    run[target].push(event);
    if (request) rememberRequest(request, run);
    if (target === "writes") run.outcome = outcomeFor(run.event, run.writes);
    return true;
  };

  for (const event of ordered) {
    switch (event.type) {
      case "rule_fire":
        open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "ran" });
        break;
      case "command_result":
      case "write":
        if (!attach(event, "writes")) {
          const run = open({ ts: event.ts, rule: event.rule ?? null, event, outcome: rowOf(event) });
          run.writes.push(event);
          run.outcome = outcomeFor(event, run.writes);
          if (typeof event.request_id === "string") rememberRequest(event.request_id, run);
        }
        break;
      case "publish":
        if (!attach(event, "publishes")) {
          open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "ran" }).publishes.push(event);
        }
        break;
      case "rule_skip": {
        const run = open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "skipped" });
        run.reason = event.reason ?? "condition_false";
        break;
      }
      case "rule_error": {
        const run = open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "failed" });
        run.error = event.error ?? "error";
        break;
      }
      case "rule_once":
        open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "consumed" });
        break;
      case "timer":
        open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "pending" });
        break;
      case "conflict":
        open({ ts: event.ts, rule: event.rule ?? null, event, outcome: "conflict" });
        break;
      default:
        open({ ts: event.ts, rule: event.rule ?? null, event, outcome: rowOf(event) });
    }
  }

  return runs.sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
}

/** Latest stage per request and attribute, preserving each attribute's outcome. */
export function latestWrites(events: Event[]): Event[] {
  const latest = new Map<string, Event>();
  for (const event of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const key = `${event.request_id ?? "legacy"}|${event.device}|${event.attr}`;
    latest.set(key, event);
  }
  return [...latest.values()];
}

export function lastRunPerRule(runs: Run[]): Map<string, Run> {
  const map = new Map<string, Run>();
  for (const run of runs) {
    if (!run.rule) continue;
    if (!map.has(run.rule)) map.set(run.rule, run);
  }
  return map;
}

/** Last write/state event per (device, attr): the answer to "why is this value like this". */
export function provenanceIndex(events: Event[]): Map<string, Event> {
  const map = new Map<string, Event>();
  for (const event of events) {
    if (event.type !== "state" && !(event.type === "write" && event.status === "applied")) continue;
    if (!event.device || !event.attr) continue;
    const key = `${event.device}\u0000${event.attr}`;
    const existing = map.get(key);
    if (!existing || existing.ts < event.ts) map.set(key, event);
  }
  return map;
}

export interface ExpectedFlag {
  device: string;
  attr: string;
  expected: unknown;
  actual: unknown;
  run: Run;
}

/**
 * "Is the house as the schedules say?" — deliberately heuristic (§6.3): only for readings
 * with a write spec, only within 24 h, only when the schedule that wrote the value is
 * still the newest writer.
 */
export function expectedNow(
  runs: Run[],
  state: StateSnapshot,
  home: Home,
  now: number = Date.now(),
): ExpectedFlag[] {
  const flags: ExpectedFlag[] = [];
  const newestWriter = new Map<string, Run>();
  for (const run of runs) {
    if (run.outcome !== "ran") continue;
    for (const write of run.writes) {
      if (write.status !== "applied" || !write.device || !write.attr) continue;
      const key = `${write.device}\u0000${write.attr}`;
      const existing = newestWriter.get(key);
      if (!existing || existing.ts < run.ts) newestWriter.set(key, { ...run, writes: [write] });
    }
  }
  for (const [key, run] of newestWriter) {
    const [device, attr] = key.split("\u0000");
    const age = now - new Date(run.ts).getTime();
    if (age > 24 * 3600 * 1000 || age < 0) continue;
    const thing = home.byDevice.get(device);
    const reading = thing?.readings.find((item) => item.attr === attr);
    if (!reading?.isControl) continue;
    const expected = run.writes[0].value;
    const actual = state[device]?.[attr]?.value;
    if (actual === undefined || actual === null) continue;
    if (!valuesEqual(actual, expected)) {
      flags.push({ device, attr, expected, actual, run });
    }
  }
  return flags;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

export type Upcoming =
  | { kind: "revert"; ts: string; timer: Timer }
  | { kind: "for"; ts: string; timer: Timer }
  | { kind: "schedule"; ts: string; rule: Rule };

/** Everything with a due time: pending timers plus each schedule's next fire. */
export function upcomingItems(
  timers: Timer[],
  nextDue: Record<string, string | null | undefined>,
  rules: Rule[],
): Upcoming[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const items: Upcoming[] = [];
  for (const timer of timers) {
    const ts = timer.due_at;
    if (!ts) continue;
    if (timer.kind === "revert") items.push({ kind: "revert", ts, timer });
    else if (timer.kind === "for") items.push({ kind: "for", ts, timer });
  }
  for (const [ruleId, ts] of Object.entries(nextDue)) {
    const rule = byId.get(ruleId);
    if (!rule || !ts) continue;
    items.push({ kind: "schedule", ts, rule });
  }
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}
