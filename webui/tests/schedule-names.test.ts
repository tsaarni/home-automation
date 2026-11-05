import { expect, it } from "vitest";
import { deviceSchema, ruleSchema } from "@/api/types";
import { makeNames } from "@/home/names";
import { describeRule } from "@/lib/schedule";

const devices = [deviceSchema.parse({ id: "light", name: "Light", attributes: {} })];
const rule = ruleSchema.parse({
  id: "timer-uuid",
  once: true,
  when: { at: "01:00" },
  then: [{ set: { device: "light", attr: "state", value: "ON" } }],
});
it("derives unnamed schedule titles from current values", () => {
  expect(makeNames(devices, [rule], []).rule(rule.id)).toBe("Once at 01:00 turn on Light");
  const changed = { ...rule, when: { at: "02:00" } };
  expect(makeNames(devices, [changed], []).rule(rule.id)).toBe("Once at 02:00 turn on Light");
});
it("recognizes legacy generated names and keeps custom names", () => {
  const legacyName = describeRule({ ...rule, once: false }, makeNames(devices, [], []));
  expect(makeNames(devices, [{ ...rule, name: legacyName }], []).rule(rule.id)).toBe(
    "Once at 01:00 turn on Light",
  );
  expect(makeNames(devices, [{ ...rule, name: "Night light" }], []).rule(rule.id)).toBe("Night light");
});
