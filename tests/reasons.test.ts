import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deviceSchema, type Event, groupSchema, type Rule, ruleSchema } from "@/api/types";
import { makeNames } from "@/home/names";
import {
  outcomeLabel,
  rowOf,
  SKIP_REASONS,
  skipSentence,
  timerSentence,
  triggerSentence,
  WRITE_STATUSES,
  writeSentence,
} from "@/lib/reasons";
import devicesFixture from "@/mocks/fixtures/devices.json";
import groupsFixture from "@/mocks/fixtures/groups.json";
import rulesFixture from "@/mocks/fixtures/rules.json";

const names = makeNames(
  z.array(deviceSchema).parse(devicesFixture),
  z.array(ruleSchema).parse(rulesFixture) as Rule[],
  z.array(groupSchema).parse(groupsFixture),
);

const event = (extra: Partial<Event>): Event =>
  ({ ts: "2026-10-11T12:00:00.000+00:00", type: "x", ...extra }) as Event;

/** Every backend code must produce words, not a code (§9). */
describe("human reasons", () => {
  it("maps every event type to a row kind with a label", () => {
    const types = [
      "rule_fire",
      "rule_skip",
      "rule_error",
      "rule_once",
      "write",
      "state",
      "timer",
      "schedule",
      "conflict",
      "publish",
      "mqtt",
      "boot",
      "config",
      "mqtt_value_error",
      "rule_depth_limit",
    ];
    for (const type of types) {
      expect(outcomeLabel(rowOf(event({ type })))).not.toBe("");
    }
    expect(rowOf(event({ type: "rule_fire" }))).toBe("ran");
    expect(rowOf(event({ type: "rule_skip" }))).toBe("skipped");
    expect(rowOf(event({ type: "rule_error" }))).toBe("failed");
    expect(rowOf(event({ type: "rule_once" }))).toBe("consumed");
    expect(rowOf(event({ type: "write", rule: null }))).toBe("manual");
    expect(rowOf(event({ type: "write", rule: "terrace-dusk" }))).toBe("ran");
    expect(rowOf(event({ type: "mqtt_value_error" }))).toBe("problem");
  });

  it("turns every skip reason into a sentence", () => {
    const samples: Record<string, Partial<Event>> = {
      condition_false: { unknown: ["thermostat-bathroom.setpoint"] },
      unknown_value: { value_from: "temperature-backyard.temperature" },
      rate_limited: { rate_limit: 5 },
      no_curve_input: { value_from: "temperature-backyard.temperature" },
    };
    for (const reason of SKIP_REASONS) {
      const sentence = skipSentence(event({ type: "rule_skip", reason, ...(samples[reason] ?? {}) }));
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toBe(reason);
      expect(sentence.includes("_")).toBe(false);
    }
  });

  it("turns every write status into a sentence", () => {
    for (const status of WRITE_STATUSES) {
      const sentence = writeSentence(
        { device: "powerplug-terrace", attr: "state", status, value: "ON", previous: "OFF" } as never,
        names,
      );
      expect(sentence).toContain("Terrace lights");
      expect(sentence.includes("_")).toBe(false);
    }
    expect(
      writeSentence(
        {
          device: "powerplug-terrace",
          attr: "state",
          status: "applied",
          value: "ON",
          previous: "OFF",
        } as never,
        names,
      ),
    ).toBe("turned Terrace lights on (was off)");
    expect(
      writeSentence(
        { device: "powerplug-terrace", attr: "state", status: "skipped", reason: "device_locked" } as never,
        names,
      ),
    ).toContain("locked");
  });

  it("writes trigger sentences in the house's words", () => {
    expect(
      triggerSentence(
        event({
          type: "rule_fire",
          trigger: {
            kind: "state",
            device: "temperature-backyard",
            attr: "temperature",
            value: -4,
            changed: true,
          },
        }),
        names,
      ),
    ).toBe("Backyard temperature temperature changed to -4 °C");
    expect(triggerSentence(event({ type: "rule_fire", trigger: { kind: "at" } }), names)).toBe(
      "its scheduled time",
    );
  });

  it("writes timer sentences", () => {
    expect(
      timerSentence(
        {
          id: "revert:x:y",
          kind: "revert",
          status: "armed",
          device: "powerplug-terrace",
          attr: "state",
          value: "OFF",
        },
        names,
        "at 23:30",
      ),
    ).toBe("Terrace lights power goes back to off at 23:30");
  });
});
