/**
 * The translation layer (§7): schedule sentence <-> rule document, with a round-trip
 * guarantee. `parseRule` refuses documents the builder cannot show, and `applySchedule`
 * patches the *whole original document* so unknown fields survive a save.
 */
import type { Action, Condition, Rule, Scalar, Term, TestReport, ValueRef } from "@/api/types";
import type { Names } from "@/home/names";
import { durationWords } from "./format";
import { isSwitchValue } from "./reasons";

export const SOLAR_EVENTS = ["dawn", "sunrise", "noon", "sunset", "dusk", "midnight"] as const;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const CLOCK_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export const HOLD_CHOICES = ["30m", "1h", "2h", "3h", "4h", "5h", "8h", "12h"];
export const DURATION_CHOICES = ["15m", "30m", "1h", "2h", "3h", "4h", "6h", "12h", "1d"];

export function isSolar(at: string | null | undefined): boolean {
  return Boolean(at && (SOLAR_EVENTS as readonly string[]).includes(at));
}

export function isValueRef(value: unknown): value is ValueRef {
  return typeof value === "object" && value !== null && "device" in value && "attr" in value;
}

export interface AtTrigger {
  kind: "at";
  at: string;
  solar: boolean;
  days: string[];
  offset: string | null;
}

export interface StateTrigger {
  kind: "state";
  device: string;
  attr: string;
  changed: boolean;
}

export interface EveryTrigger {
  kind: "every";
  every: string;
}

export type Trigger = AtTrigger | StateTrigger | EveryTrigger;

export interface Clause {
  target: { kind: "device" | "group"; id: string };
  attr: string;
  value: Scalar;
  revertAfter: string | null;
}

export interface ParsedSchedule {
  when: Trigger;
  onlyIf: { terms: Term[] } | null;
  /** "stays that way for" */
  hold: string | null;
  then: Clause[];
}

export type ParseResult = { ok: true; schedule: ParsedSchedule } | { ok: false; reasons: string[] };

/** Everything the sentence builder cannot represent, in words (§7.3). */
export function unrepresentable(rule: Rule): string[] {
  const reasons: string[] = [];
  if (rule.if?.any?.length) reasons.push('an "any of" condition');
  for (const term of rule.if?.all ?? []) {
    if (isValueRef(term.value)) reasons.push("a condition comparing two readings");
  }
  for (const action of rule.then) {
    if (action.set_curve) reasons.push("a heating curve");
    if (action.publish) reasons.push("a raw MQTT publish");
    if (action.set && isValueRef(action.set.value)) reasons.push("a value copied from another reading");
    if (!action.set && !action.set_curve && !action.publish)
      reasons.push("an action the UI does not understand");
  }
  const when = rule.when;
  const kinds = [when.device !== null && when.device !== undefined, Boolean(when.at), Boolean(when.every)];
  if (kinds.filter(Boolean).length !== 1) reasons.push("a trigger the UI does not understand");
  if (when.offset && !isSolar(when.at)) reasons.push("an offset on a clock trigger");
  if (rule.then.length === 0) reasons.push("no action");
  return [...new Set(reasons)];
}

export function parseRule(rule: Rule): ParseResult {
  const reasons = unrepresentable(rule);
  if (reasons.length) return { ok: false, reasons };
  const when = rule.when;

  const trigger: Trigger = when.at
    ? { kind: "at", at: when.at, solar: isSolar(when.at), days: when.days ?? [], offset: when.offset ?? null }
    : when.device
      ? { kind: "state", device: when.device, attr: when.attr ?? "", changed: Boolean(when.changed) }
      : { kind: "every", every: when.every ?? "15m" };

  const then: Clause[] = rule.then.map((action) => {
    const set = action.set;
    if (!set) throw new Error("unrepresentable action slipped through");
    const target = set.device
      ? ({ kind: "device", id: set.device } as const)
      : ({ kind: "group", id: set.group ?? "" } as const);
    return {
      target,
      attr: set.attr,
      value: set.value as Scalar,
      revertAfter: set.revert_after ?? null,
    };
  });

  return {
    ok: true,
    schedule: {
      when: trigger,
      onlyIf: rule.if?.all?.length ? { terms: rule.if.all } : null,
      hold: rule.for ?? null,
      then,
    },
  };
}

function whenDocument(trigger: Trigger): Record<string, unknown> {
  const changed = trigger.kind === "state" ? trigger.changed : false;
  switch (trigger.kind) {
    case "at": {
      const doc: Record<string, unknown> = { changed, at: trigger.at };
      if (trigger.solar && trigger.offset) doc.offset = trigger.offset;
      if (trigger.days.length) doc.days = [...trigger.days];
      return doc;
    }
    case "state":
      return { device: trigger.device, attr: trigger.attr, changed };
    default:
      return { changed, every: trigger.every };
  }
}

/**
 * Apply the builder's schedule onto the original document. Fields the builder does not know
 * about are preserved; `if` and `for` are set or removed explicitly.
 */
export function applySchedule(rule: Rule, schedule: ParsedSchedule, overrides: Partial<Rule> = {}): Rule {
  const { if: _if, for: _for, when: _when, then: _then, ...rest } = rule as Record<string, unknown>;
  void _if;
  void _for;
  void _when;
  void _then;
  const doc: Record<string, unknown> = {
    ...rest,
    ...(overrides as Record<string, unknown>),
    when: whenDocument(schedule.when),
    then: schedule.then.map((clause, index) => clauseDocument(clause, rule.then[index])),
  };
  if (schedule.onlyIf?.terms.length) doc.if = { all: schedule.onlyIf.terms };
  if (schedule.hold) doc.for = schedule.hold;
  return doc as Rule;
}

/**
 * One action document. When the action still points at the same reading, its original object
 * is the base, so fields the builder does not model survive the save.
 */
function clauseDocument(clause: Clause, original: Action | undefined): Record<string, unknown> {
  const previous = original?.set;
  const sameTarget =
    previous !== undefined &&
    previous !== null &&
    previous.attr === clause.attr &&
    (previous.device ?? previous.group ?? null) === clause.target.id;
  const set: Record<string, unknown> = sameTarget ? { ...previous } : {};
  delete set.device;
  delete set.group;
  set[clause.target.kind] = clause.target.id;
  set.attr = clause.attr;
  set.value = clause.value;
  if (clause.revertAfter) set.revert_after = clause.revertAfter;
  else delete set.revert_after;
  return { ...(original ?? {}), set };
}

export function emptySchedule(): ParsedSchedule {
  return {
    when: { kind: "at", at: "23:30", solar: false, days: [], offset: null },
    onlyIf: null,
    hold: null,
    then: [],
  };
}

/** Build a clause for a thing's control. */
export function clauseFor(kind: "device" | "group", id: string, attr: string, value: Scalar): Clause {
  return { target: { kind, id }, attr, value, revertAfter: null };
}

export function slugify(text: string, fallback = "schedule"): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

const OP_WORDS: Record<string, string> = {
  eq: "is",
  ne: "is not",
  gt: "is above",
  ge: "is at least",
  lt: "is below",
  le: "is at most",
};

export function describeTrigger(trigger: Trigger, names: Names): string {
  switch (trigger.kind) {
    case "at": {
      const offset = trigger.offset ? ` ${offsetLabel(trigger.offset)}` : "";
      if (trigger.solar) return `At ${solarLabel(trigger.at)}${offset}`;
      const everyDay = trigger.days.length === 0 || trigger.days.length === 7;
      return everyDay ? `Every day at ${trigger.at}` : `At ${trigger.at} on ${dayList(trigger.days)}`;
    }
    case "state": {
      const thing = names.device(trigger.device);
      const label = names.attr(trigger.device, trigger.attr).toLowerCase();
      return trigger.changed ? `When ${thing} ${label} changes` : `When ${thing} ${label} is reported`;
    }
    default:
      return `Every ${everyLabel(trigger.every)}`;
  }
}

export function solarLabel(at: string): string {
  return at;
}

export function everyLabel(every: string): string {
  return durationWords(every).replace(/^a /, "1 ").replace(/^an /, "1 ");
}

function dayList(days: string[]): string {
  return days.join(", ");
}

export function offsetLabel(offset: string): string {
  const sign = offset.trim().startsWith("-") ? "-" : "+";
  const magnitude = offset.replace(/^[+-]/, "");
  return `${sign}${magnitude}`;
}

export function describeTerm(term: Term, names: Names): string {
  const [device, attr] = term.attr;
  const thing = names.device(device);
  const label = names.attr(device, attr).toLowerCase();
  const op = OP_WORDS[term.op] ?? term.op;
  const value = isValueRef(term.value)
    ? `${names.device(term.value.device)} ${names.attr(term.value.device, term.value.attr).toLowerCase()}`
    : names.value(device, attr, term.value);
  return `${thing} ${label} ${op} ${value}`;
}

export interface ClauseDescription {
  targetKind: "device" | "group";
  targetId: string;
  targetLabel: string;
  attr: string;
  label: string;
  valueText: string;
  revert: string | null;
  /** verb for the sentence: "turn ... on" */
  verb: string;
  /** true when the widget is a switch */
  switchy: boolean;
}

export function describeClause(clause: Clause, names: Names): ClauseDescription {
  const targetLabel =
    clause.target.kind === "device" ? names.device(clause.target.id) : names.group(clause.target.id);
  const label = names
    .attr(clause.target.kind === "device" ? clause.target.id : "", clause.attr)
    .toLowerCase();
  const valueText = names.value(
    clause.target.kind === "device" ? clause.target.id : null,
    clause.attr,
    clause.value,
  );
  const switchy = clause.value === "ON" || clause.value === "OFF" || typeof clause.value === "boolean";
  const verb = switchy ? (clause.value === "ON" || clause.value === true ? "turn on" : "turn off") : "set";
  return {
    targetKind: clause.target.kind,
    targetId: clause.target.id,
    targetLabel,
    attr: clause.attr,
    label,
    valueText,
    revert: clause.revertAfter,
    verb,
    switchy,
  };
}

export interface Description {
  when: string;
  onlyIf: string | null;
  hold: string | null;
  actions: ClauseDescription[];
  /** the one-line sentence used in lists */
  sentence: string;
}

export function describeSchedule(schedule: ParsedSchedule, names: Names): Description {
  const when = describeTrigger(schedule.when, names);
  const actions = schedule.then.map((clause) => describeClause(clause, names));
  const onlyIf = schedule.onlyIf?.terms.length
    ? schedule.onlyIf.terms.map((term) => describeTerm(term, names)).join(" and ")
    : null;
  const hold = schedule.hold ? durationWords(schedule.hold) : null;
  const actionText = actions
    .map((action) => {
      const tail = action.revert ? `, back after ${durationWords(action.revert)}` : "";
      return action.switchy
        ? `${action.verb} ${action.targetLabel}${tail}`
        : `set ${action.targetLabel} ${action.label} to ${action.valueText}${tail}`;
    })
    .join(", then ");
  const sentence = `${when} ${actionText}${onlyIf ? ` if ${onlyIf}` : ""}${hold ? ` and it stays like that for ${hold}` : ""}`;
  return { when, onlyIf, hold, actions, sentence };
}

export function describeRule(rule: Rule, names: Names): string {
  const parsed = parseRule(rule);
  if (!parsed.ok) return `${rule.name ?? rule.id} (uses ${parsed.reasons.join(", ")})`;
  return describeSchedule(parsed.schedule, names).sentence;
}

/** `POST /rules/{id}/test` rendered as a sentence instead of a report (§5.2). */
export function describeTestReport(report: TestReport, names: Names): string {
  const unknown = report.condition.unknown ?? [];
  if (!report.condition.satisfied) {
    return unknown.length
      ? `waiting for ${unknown.map((item) => String(item).replace(".", " ")).join(", ")}`
      : "conditions were not met";
  }
  if (report.rate_limited) return "would run, but it ran too recently";
  const plans = report.writes.filter((write) => write.status !== "unchanged");
  if (!plans.length && !report.publishes.length) return "nothing to do — the values are already right";
  const parts = plans.map((write) => {
    const thing = names.device(write.device);
    const value = names.value(write.device, write.attr, write.value);
    const suffix = write.status === "dry-run" ? " (dry run)" : "";
    return isSwitchValue(write.value)
      ? `turn ${thing} ${value}${suffix}`
      : `set ${thing} ${names.attr(write.device, write.attr).toLowerCase()} to ${value}${suffix}`;
  });
  for (const publish of report.publishes) parts.push(`publish to ${publish.topic}`);
  return `would ${parts.join(", and ")}`;
}

/** A day-strip mark: a place on a 24 h line with what happens there. */
export interface DayMark {
  at: string;
  minutes: number;
  label: string;
  value: string;
  solar: boolean;
  ruleId: string;
}

/** Clock marks are exact; solar marks come from the backend's next_due (never computed here). */
export function dayMarks(
  rules: Rule[],
  nextDue: Record<string, string | null | undefined>,
  zone: string,
): DayMark[] {
  const marks: DayMark[] = [];
  for (const rule of rules) {
    const at = rule.when.at;
    if (!at) continue;
    const action = rule.then.find((item) => item.set)?.set;
    const value = action ? String(action.value) : "";
    if (!isSolar(at) && CLOCK_RE.test(at)) {
      const [hours, minutes] = at.split(":").map(Number);
      marks.push({ at, minutes: hours * 60 + minutes, label: at, value, solar: false, ruleId: rule.id });
    } else if (nextDue[rule.id]) {
      const due = nextDue[rule.id] as string;
      const local = localMinutes(due, zone);
      marks.push({ at, minutes: local, label: at, value, solar: true, ruleId: rule.id });
    }
  }
  return marks.sort((a, b) => a.minutes - b.minutes);
}

function localMinutes(iso: string, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return (hours % 24) * 60 + minutes;
}

export type { Action, Condition };
