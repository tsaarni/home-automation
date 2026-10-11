/**
 * Every backend code gets one human sentence here — nowhere else in the UI do raw
 * codes appear. A table-completeness test fails loudly when the backend grows a new one.
 */
import type { Event, Timer, WriteResult } from "@/api/types";
import type { Names } from "@/home/names";

/** What a row in the activity list is. */
export type Outcome =
  | "ran"
  | "nothing"
  | "skipped"
  | "failed"
  | "manual"
  | "reading"
  | "pending"
  | "consumed"
  | "conflict"
  | "problem"
  | "system";

export const SKIP_REASONS = ["condition_false", "unknown_value", "rate_limited", "no_curve_input"] as const;
export const WRITE_STATUSES = ["applied", "unchanged", "dry-run", "skipped", "error"] as const;
export const WRITE_REASONS = [
  "device_locked",
  "no_value_to_restore",
  "no_curve_input",
  "unknown_device",
  "unknown_attribute",
  "publish_failed",
  "outside limits",
  "not one of",
] as const;
export const TIMER_STATUSES = ["armed", "fired", "cancelled", "dropped", "refused"] as const;

/** `event.type` -> row kind (see PLAN §9). */
export function rowOf(event: Event): Outcome {
  switch (event.type) {
    case "rule_fire":
      return "ran";
    case "rule_skip":
      return "skipped";
    case "rule_error":
      return "failed";
    case "rule_once":
      return "consumed";
    case "write":
      return event.rule ? "ran" : "manual";
    case "state":
      return "reading";
    case "timer":
      return "pending";
    case "schedule":
      return "ran";
    case "conflict":
      return "conflict";
    case "mqtt_value_error":
    case "rule_depth_limit":
      return "problem";
    default:
      return "system";
  }
}

export function outcomeLabel(outcome: Outcome): string {
  switch (outcome) {
    case "ran":
      return "Auto";
    case "nothing":
      return "Unchanged";
    case "skipped":
      return "Skipped";
    case "failed":
      return "Failed";
    case "manual":
      return "Manual";
    case "reading":
      return "Reading";
    case "pending":
      return "Pending";
    case "consumed":
      return "One-shot done";
    case "conflict":
      return "Conflict";
    case "problem":
      return "Problem";
    default:
      return "System";
  }
}

/** `rule_skip.reason` -> a sentence. */
export function skipSentence(event: Event): string {
  const reason = event.reason ?? "";
  if (reason === "condition_false") {
    const unknown = event.unknown ?? [];
    if (unknown.length) {
      const first = String(unknown[0]);
      return `no value yet for ${first.replace(".", " ")}`;
    }
    return "the conditions were not met";
  }
  if (reason === "unknown_value") {
    return `waiting for a reading from ${String(event.value_from ?? "a device").replace(".", " ")}`;
  }
  if (reason === "rate_limited") {
    const limit = Number(event.rate_limit ?? 0);
    return `ran again too soon (limit ${limit}s)`;
  }
  if (reason === "no_curve_input") {
    return `${String(event.value_from ?? "the reference value").replace(".", " ")} is not known, cannot follow the curve`;
  }
  return reason ? humanizeWords(reason) : "nothing to do";
}

export function reasonFromEvent(event: Event): string | null {
  if (event.type === "rule_skip") return event.reason ?? "condition_false";
  if (event.type === "rule_error") return event.error ?? "error";
  if (event.type === "timer") return event.reason ?? event.status ?? null;
  if (event.type === "schedule") return "catch_up";
  return event.reason ?? null;
}

/** A switch-like write reads better without repeating the attribute name. */
export function isSwitchValue(value: unknown): boolean {
  return value === "ON" || value === "OFF" || typeof value === "boolean";
}

/** `write.status` (+ reason) -> a sentence. */
export function writeSentence(result: WriteResult, names: Names): string {
  const thing = names.device(result.device);
  const switchy = isSwitchValue(result.value);
  const target = switchy ? thing : `${thing} ${names.attr(result.device, result.attr).toLowerCase()}`;
  const after = names.value(result.device, result.attr, result.value);
  const before = names.value(result.device, result.attr, result.previous);
  const was = result.previous === undefined || result.previous === null ? "" : ` (was ${before})`;
  switch (result.status) {
    case "applied":
      return switchy ? `turned ${target} ${after}${was}` : `${target} set to ${after}${was}`;
    case "unchanged":
      return `${target} already ${after}`;
    case "dry-run":
      return switchy
        ? `would turn ${target} ${after} (dry run)`
        : `would set ${target} to ${after} (dry run)`;
    case "skipped":
      return result.reason === "device_locked"
        ? `${thing} is locked`
        : `${target} skipped: ${humanizeWords(result.reason ?? "")}`;
    default: {
      const reason = result.reason ?? "";
      if (reason.startsWith("publish_failed")) return `couldn't reach ${thing}`;
      return `${target}: ${reason || "could not be written"}`;
    }
  }
}

/** Outcome of a run given its individual write results. */
export function outcomeFromWrites(results: WriteResult[]): Outcome {
  if (!results.length) return "ran";
  if (results.some((result) => result.status === "error")) return "failed";
  if (results.every((result) => result.status === "unchanged")) return "nothing";
  if (results.every((result) => result.status === "dry-run")) return "nothing";
  return "ran";
}

/** `trigger` -> a sentence fragment ("tonight at 23:30", "Backyard temperature changed to −4.0 °C"). */
export function triggerSentence(event: Event, names: Names): string | null {
  const trigger = event.trigger as
    | { kind?: string; device?: string; attr?: string; value?: unknown; changed?: boolean }
    | null
    | undefined;
  if (!trigger?.kind) return null;
  switch (trigger.kind) {
    case "state": {
      const thing = names.device(trigger.device);
      const label = names.attr(trigger.device ?? "", trigger.attr ?? "").toLowerCase();
      const value = names.value(trigger.device, trigger.attr, trigger.value);
      return trigger.changed
        ? `${thing} ${label} changed to ${value}`
        : `${thing} ${label} reported ${value}`;
    }
    case "at":
      return "its scheduled time";
    case "every":
      return "its interval";
    case "resync":
      return "after reconnecting";
    case "timer":
      return "after the hold period";
    default:
      return null;
  }
}

/** `timer` kind/status -> a sentence. */
export function timerSentence(timer: Timer, names: Names, when: string): string {
  const kind = timer.kind;
  if (kind === "revert") {
    const thing = names.device(timer.device);
    const label = names.attr(timer.device ?? "", timer.attr ?? "").toLowerCase();
    const value = names.value(timer.device, timer.attr, timer.value);
    switch (timer.status) {
      case "armed":
        return `${thing} ${label} goes back to ${value} ${when}`;
      case "fired":
        return `${thing} ${label} restored to ${value}`;
      case "refused":
        return `no previous ${thing} ${label} value to restore`;
      default:
        return `${thing} ${label} override dropped`;
    }
  }
  const rule = names.rule(timer.rule);
  switch (timer.status) {
    case "armed":
      return `${rule} will run ${when} if the conditions still hold`;
    case "fired":
      return `${rule} passed its hold period`;
    case "cancelled":
      return `${rule} hold cancelled (${humanizeWords(String(timer.reason ?? "condition changed"))})`;
    default:
      return `${rule} timer ${timer.status ?? "dropped"}`;
  }
}

export function humanizeWords(code: string): string {
  return code.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || code;
}

/** The Provenance sentence (§6.2): why a value is what it is. */
export function provenanceSentence(
  event: Event | undefined,
  device: string,
  attr: string,
  names: Names,
  time: { stamp: (iso: string) => string },
): { title: string; detail: string; kind: "manual" | "rule" | "device" | "unknown"; rule?: string } {
  if (!event) {
    return { title: "Unknown", detail: "older than the event log", kind: "unknown" };
  }
  const at = time.stamp(event.ts);
  const value = names.value(device, attr, event.value);
  const was =
    event.previous === null || event.previous === undefined
      ? null
      : names.value(device, attr, event.previous);
  const wasText = was ? ` (was ${was})` : "";
  if (event.source === "manual") {
    return { title: "You", detail: `set it to ${value}${wasText} at ${at}`, kind: "manual" };
  }
  if (event.source?.startsWith("revert")) {
    return {
      title: "Automatic restore",
      detail: `${value}${wasText} at ${at}`,
      kind: "rule",
      rule: event.rule ?? undefined,
    };
  }
  if (event.rule) {
    return {
      title: names.rule(event.rule),
      detail: `set it to ${value}${wasText} at ${at}`,
      kind: "rule",
      rule: event.rule,
    };
  }
  if (event.source === "mqtt") {
    return { title: "The device", detail: `reported ${value} at ${at}`, kind: "device" };
  }
  return { title: "Unknown source", detail: `${value} at ${at}`, kind: "unknown" };
}
