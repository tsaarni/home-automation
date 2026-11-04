import type { Attribute, Device, Group, Scalar } from "@/api/types";
import { durationSeconds } from "./duration";
import { numericError } from "./numeric";
import type { Clause, ParsedSchedule } from "./schedule";
import { CLOCK_RE, SOLAR_EVENTS } from "./schedule";

export function defaultValue(spec?: Attribute): Scalar {
  if (spec && valueError(spec.default, spec) === null) return spec?.default as Scalar;
  if (spec?.enum?.length) return spec.enum[0] as Scalar;
  if (spec?.type === "boolean") return true;
  if (spec?.type === "number") return spec.limits?.[0] ?? 0;
  return "";
}

/** Shared writable controls only, intersecting enum values and numeric bounds. */
export function targetAttributes(
  target: Clause["target"],
  devices: Device[],
  groups: Group[],
): Record<string, Attribute> {
  if (target.kind === "device") {
    const device = devices.find((d) => d.id === target.id);
    return device?.locked
      ? {}
      : Object.fromEntries(Object.entries(device?.attributes ?? {}).filter(([, s]) => s.write));
  }
  const members = groups.find((g) => g.id === target.id)?.members ?? [];
  const resolved = members.map((id) => devices.find((d) => d.id === id));
  if (!members.length || resolved.some((d) => !d || d.locked)) return {};
  const result: Record<string, Attribute> = {};
  for (const [attr, first] of Object.entries(resolved[0]?.attributes ?? {})) {
    const specs = resolved.map((d) => d?.attributes[attr]);
    if (specs.some((s) => !s?.write || s.type !== first.type || s.unit !== first.unit)) continue;
    const enums = specs.filter((s) => s?.enum?.length).map((s) => s?.enum ?? []);
    const options = enums.length ? enums[0].filter((v) => enums.every((e) => e.includes(v))) : null;
    if (options && !options.length) continue;
    const lows = specs.flatMap((s) => (s?.limits ? [s.limits[0]] : []));
    const highs = specs.flatMap((s) => (s?.limits ? [s.limits[1]] : []));
    const limits: [number, number] | null = lows.length ? [Math.max(...lows), Math.min(...highs)] : null;
    if (limits && limits[0] > limits[1]) continue;
    const boundedOptions =
      options?.filter(
        (value) =>
          typeof value === first.type &&
          (typeof value !== "number" || !limits || (value >= limits[0] && value <= limits[1])),
      ) ?? null;
    if (boundedOptions && !boundedOptions.length) continue;
    const shared = { ...first, enum: boundedOptions, limits };
    if (valueError(shared.default, shared)) delete shared.default;
    result[attr] = shared;
  }
  return result;
}

export function valueError(value: unknown, spec?: Attribute): string | null {
  if (!spec) return "Choose an available reading or control.";
  if (typeof value !== spec.type || (spec.type === "number" && !Number.isFinite(value)))
    return `Enter a valid ${spec.type === "number" ? "number" : spec.type} value.`;
  if (spec.enum?.length && !spec.enum.includes(value)) return "Choose one of the available values.";
  if (typeof value === "number" && spec.limits && (value < spec.limits[0] || value > spec.limits[1]))
    return `Enter a value from ${spec.limits[0]} to ${spec.limits[1]}.`;
  if (typeof value === "number")
    return numericError(value, {
      min: spec.limits?.[0],
      max: spec.limits?.[1],
      step: typeof spec.step === "number" ? spec.step : undefined,
    });
  return null;
}

export function validDuration(value: string, signed = false): boolean {
  const seconds = durationSeconds(value);
  return seconds !== null && (signed || seconds > 0);
}

export function scheduleErrors(
  schedule: ParsedSchedule,
  devices: Device[],
  groups: Group[],
  customDays = false,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const trigger = schedule.when;
  if (trigger.kind === "at") {
    if (
      trigger.solar ? !(SOLAR_EVENTS as readonly string[]).includes(trigger.at) : !CLOCK_RE.test(trigger.at)
    )
      errors.trigger = "Choose a valid time or solar event.";
    if (customDays && !trigger.days.length) errors.repeat = "Choose at least one custom day.";
    if (trigger.solar && trigger.offset !== null && !validDuration(trigger.offset, true))
      errors.offset = "Enter a positive offset and choose Before or After.";
  } else if (trigger.kind === "every") {
    if (!validDuration(trigger.every)) errors.trigger = "Enter a positive interval and unit.";
  } else if (!devices.find((d) => d.id === trigger.device)?.attributes[trigger.attr])
    errors.trigger = "Choose a device and reading.";
  if (!schedule.then.length) errors.actions = "Add at least one action.";
  schedule.then.forEach((c, i) => {
    if (!c.target.id || !c.attr) errors[`action-${i}`] = "Choose a device or group and control.";
    else {
      const problem = valueError(c.value, targetAttributes(c.target, devices, groups)[c.attr]);
      if (problem) errors[`action-${i}`] = problem;
    }
    if (c.revertAfter && !validDuration(c.revertAfter))
      errors[`action-${i}`] = "Enter a positive restore duration.";
  });
  schedule.onlyIf?.terms.forEach((t, i) => {
    const spec = devices.find((d) => d.id === t.attr[0])?.attributes[t.attr[1]];
    const problem = valueError(t.value, spec);
    if (problem) errors[`condition-${i}`] = problem;
    if (spec && spec.type !== "number" && !["eq", "ne"].includes(t.op))
      errors[`condition-${i}`] = "Use is or is not for this reading.";
  });
  if (schedule.hold && !validDuration(schedule.hold)) errors.hold = "Enter a positive delay.";
  return errors;
}
