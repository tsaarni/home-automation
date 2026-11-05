import { expect, it } from "vitest";
import { ruleSchema } from "@/api/types";
import { makeTime } from "@/lib/format";
import { groupByNext, nextTime } from "@/lib/schedule-list";

const rule = (id: string, extra = {}) =>
  ruleSchema.parse({
    id,
    enabled: true,
    when: { at: "22:00" },
    then: [{ set: { device: "light", attr: "state", value: "OFF" } }],
    ...extra,
  });

it("orders next occurrences globally and separates events, unavailable times and disabled rules", () => {
  const rules = [
    rule("late"),
    rule("early"),
    rule("disabled", { enabled: false }),
    rule("event", { when: { device: "light", attr: "state", changed: true } }),
    rule("unknown"),
    rule("invalid"),
    rule("due"),
    rule("tomorrow"),
    rule("later"),
  ];
  const due = {
    late: "2026-11-05T23:30:00+02:00",
    early: "2026-11-05T22:00:00+02:00",
    disabled: "2026-11-05T21:00:00+02:00",
    invalid: "bad date",
    due: "2026-11-05T19:59:00+02:00",
    tomorrow: "2026-11-06T06:00:00+02:00",
    later: "2026-11-07T06:00:00+02:00",
  };
  const blocks = groupByNext(rules, due, makeTime("Europe/Helsinki"), new Date("2026-11-05T20:00:00+02:00"));
  expect(blocks.map((block) => [block.label, block.rules.map((item) => item.id)])).toEqual([
    ["Due now", ["due"]],
    ["Today", ["early", "late"]],
    ["Tomorrow", ["tomorrow"]],
    ["Later", ["later"]],
    ["Next time unavailable", ["invalid", "unknown"]],
    ["On change / event", ["event"]],
    ["Disabled", ["disabled"]],
  ]);
});

it("uses the house calendar across midnight and the daylight saving transition", () => {
  const blocks = groupByNext(
    [rule("today"), rule("tomorrow")],
    {
      today: "2026-10-25T21:59:00Z",
      tomorrow: "2026-10-25T22:01:00Z",
    },
    makeTime("Europe/Helsinki"),
    new Date("2026-10-24T22:30:00Z"),
  );
  expect(blocks.map((block) => block.label)).toEqual(["Today", "Tomorrow"]);
  expect(nextTime("invalid")).toBeNull();
});
