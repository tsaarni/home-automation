import { describe, expect, it } from "vitest";
import { deviceSchema, groupSchema } from "@/api/types";
import { clauseFor, emptySchedule } from "@/lib/schedule";
import {
  defaultValue,
  scheduleErrors,
  targetAttributes,
  validDuration,
  valueError,
} from "@/lib/schedule-fields";

const device = (id: string, limits: [number, number], values: string[] = ["heat", "cool"]) =>
  deviceSchema.parse({
    id,
    attributes: {
      setpoint: { type: "number", limits, write: { topic: "set" } },
      mode: { type: "string", enum: values, write: { topic: "set" } },
    },
  });
const group = groupSchema.parse({ id: "all", members: ["a", "b"] });

describe("schedule fields", () => {
  it("intersects group metadata, rejects incompatible ranges and missing members", () => {
    const attrs = targetAttributes(
      { kind: "group", id: "all" },
      [device("a", [10, 30]), device("b", [15, 25], ["heat"])],
      [group],
    );
    expect(attrs.setpoint.limits).toEqual([15, 25]);
    expect(attrs.mode.enum).toEqual(["heat"]);
    expect(defaultValue(attrs.setpoint)).toBe(15);
    expect(targetAttributes({ kind: "group", id: "all" }, [device("a", [10, 30])], [group])).toEqual({});
    expect(
      targetAttributes({ kind: "group", id: "all" }, [device("a", [10, 12]), device("b", [15, 25])], [group])
        .setpoint,
    ).toBeUndefined();
  });
  it("validates time, custom days, values and durations without coercing empty input", () => {
    const schedule = { ...emptySchedule(), then: [clauseFor("device", "a", "setpoint", "")] };
    schedule.when = { kind: "at", at: "25:00", solar: false, days: [], offset: null };
    const errors = scheduleErrors(schedule, [device("a", [10, 30])], [], true);
    expect(Object.keys(errors).sort()).toEqual(["action-0", "repeat", "trigger"]);
    schedule.then[0].value = 31;
    expect(scheduleErrors(schedule, [device("a", [10, 30])], [])["action-0"]).toContain("10 to 30");
    expect(validDuration("1h30m")).toBe(true);
    for (const duration of ["", "0m", "-30m", "abc"]) expect(validDuration(duration)).toBe(false);
    expect(validDuration("-30m", true)).toBe(true);
  });
});

it("filters group numeric enums by shared limits and replaces an invalid default", () => {
  const a = device("a", [10, 30]);
  a.attributes.setpoint.enum = [10, 20, 30];
  a.attributes.setpoint.default = 10;
  const b = device("b", [15, 25]);
  const shared = targetAttributes({ kind: "group", id: "all" }, [a, b], [group]).setpoint;
  expect(shared.enum).toEqual([20]);
  expect(defaultValue(shared)).toBe(20);
  a.attributes.setpoint.enum = [10, 30];
  expect(targetAttributes({ kind: "group", id: "all" }, [a, b], [group]).setpoint).toBeUndefined();
  a.attributes.setpoint.enum = null;
  expect(defaultValue(targetAttributes({ kind: "group", id: "all" }, [a, b], [group]).setpoint)).toBe(15);
});
it("validates metadata increments with floating point tolerance", () => {
  const spec = device("a", [10, 30]).attributes.setpoint;
  spec.step = 0.1;
  expect(valueError(10.25, spec)).toContain("increments");
  expect(valueError(10.1 + 0.2, spec)).toBeNull();
});
