import { describe, expect, it } from "vitest";
import { type Rule, ruleSchema } from "@/api/types";
import { applySchedule, parseRule, unrepresentable } from "@/lib/schedule";
import rulesFixture from "@/mocks/fixtures/rules.json";

const rules = (rulesFixture as unknown[]).map((raw) => ruleSchema.parse(raw) as Rule);

/**
 * The critical "no data loss" guarantee (§7.3): every real rule either survives
 * parse -> build unchanged, or is explicitly flagged as unrepresentable.
 */
describe("schedule round trip", () => {
  it("has the seed rules to check", () => {
    expect(rules.length).toBeGreaterThanOrEqual(9);
  });

  for (const rule of rules) {
    it(`${rule.id}: parse -> build is lossless or flagged`, () => {
      const parsed = parseRule(rule);
      if (!parsed.ok) {
        expect(unrepresentable(rule).length).toBeGreaterThan(0);
        return;
      }
      const rebuilt = applySchedule(rule, parsed.schedule);
      expect(rebuilt).toEqual(rule);
    });
  }

  it("keeps top-level fields the builder does not model", () => {
    const rule = {
      ...(rules.find((item) => item.id === "terrace-dusk") as Rule),
      something_new: { added_later: true },
    } as Rule;
    const parsed = parseRule(rule);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rebuilt = applySchedule(rule, parsed.schedule, { name: "renamed" });
    expect(rebuilt).toMatchObject({ something_new: { added_later: true }, name: "renamed" });
    expect(rebuilt.when).toEqual(rule.when);
  });

  it("keeps unknown keys inside an action whose reading did not change", () => {
    const source = rules.find((item) => item.id === "terrace-dusk") as Rule;
    const action = source.then[0] as Rule["then"][number];
    const rule = {
      ...source,
      then: [{ ...action, set: { ...action.set, some_future_field: 7 } }],
    } as Rule;
    const parsed = parseRule(rule);
    if (!parsed.ok) throw new Error("expected a representable rule");
    const rebuilt = applySchedule(rule, parsed.schedule);
    const set = rebuilt.then[0]?.set as Record<string, unknown> | undefined;
    expect(set?.some_future_field).toBe(7);
  });

  it("flags the heating curve and other unsupported actions", () => {
    const curve = rules.find((item) => item.id === "bathroom-curve") as Rule;
    expect(unrepresentable(curve)).toContain("a heating curve");
    expect(parseRule(curve).ok).toBe(false);
  });

  it("builds a new rule from a sentence", () => {
    const parsed = parseRule(rules.find((item) => item.id === "terrace-dusk") as Rule);
    if (!parsed.ok) throw new Error("expected a representable rule");
    const draft = {
      ...parsed.schedule,
      then: [
        {
          target: { kind: "device" as const, id: "powerplug-terrace" },
          attr: "state",
          value: "OFF" as const,
          revertAfter: "2h",
        },
      ],
    };
    const fresh = applySchedule(
      {
        id: "x",
        enabled: true,
        priority: 0,
        once: false,
        rate_limit: 1,
        when: { at: "00:00" },
        then: [],
      } as unknown as Rule,
      draft,
      { name: "Test" },
    );
    expect(fresh).toMatchObject({
      id: "x",
      name: "Test",
      when: { changed: false, at: "dusk" },
      then: [{ set: { device: "powerplug-terrace", attr: "state", value: "OFF", revert_after: "2h" } }],
    });
  });
});
