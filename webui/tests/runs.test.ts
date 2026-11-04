import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Device, deviceSchema, type Event, type Rule, ruleSchema } from "@/api/types";
import { buildHome } from "@/home/derive";
import { buildRuns, expectedNow, lastRunPerRule, provenanceIndex, upcomingItems } from "@/lib/runs";
import devicesFixture from "@/mocks/fixtures/devices.json";
import rulesFixture from "@/mocks/fixtures/rules.json";

const devices = z.array(deviceSchema).parse(devicesFixture) as Device[];
const rules = z.array(ruleSchema).parse(rulesFixture) as Rule[];

const at = (seconds: number) =>
  new Date(Date.parse("2026-10-11T19:15:00.000Z") + seconds * 1000).toISOString();
const event = (extra: Partial<Event>): Event => ({ ts: at(0), type: "x", ...extra }) as Event;

describe("runs", () => {
  it("groups a fire with the writes it produced", () => {
    const events = [
      event({ type: "rule_fire", rule: "terrace-dusk", trigger: { kind: "at" } }),
      event({
        ts: at(0.2),
        type: "write",
        rule: "terrace-dusk",
        device: "powerplug-terrace",
        attr: "state",
        value: "ON",
        previous: "OFF",
        status: "applied",
      }),
      event({
        ts: at(1),
        type: "state",
        device: "powerplug-terrace",
        attr: "state",
        value: "ON",
        source: "rule:terrace-dusk",
      }),
    ];
    const runs = buildRuns(events);
    expect(runs).toHaveLength(2);
    const fired = runs.find((run) => run.outcome === "ran");
    expect(fired?.writes).toHaveLength(1);
    expect(fired?.rule).toBe("terrace-dusk");
    expect(runs[0]?.outcome).toBe("reading");
  });

  it("says nothing to do when every write was unchanged", () => {
    const events = [
      event({ type: "rule_fire", rule: "terrace-dusk" }),
      event({
        ts: at(0.1),
        type: "write",
        rule: "terrace-dusk",
        device: "powerplug-terrace",
        attr: "state",
        value: "ON",
        previous: "ON",
        status: "unchanged",
      }),
    ];
    expect(buildRuns(events)[0]?.outcome).toBe("nothing");
  });

  it("keeps skips, failures, manual writes and timers as separate rows", () => {
    const events = [
      event({ type: "rule_skip", rule: "bathroom-setback", reason: "condition_false" }),
      event({ ts: at(10), type: "rule_error", rule: "bathroom-curve", error: "boom" }),
      event({
        ts: at(20),
        type: "write",
        rule: null,
        device: "powerplug-terrace",
        attr: "state",
        value: "OFF",
        previous: "ON",
        status: "applied",
        source: "manual",
      }),
      event({
        ts: at(30),
        type: "timer",
        status: "armed",
        kind: "revert",
        device: "powerplug-terrace",
        attr: "state",
        value: "ON",
      }),
    ];
    const runs = buildRuns(events);
    expect(runs.map((run) => run.outcome)).toEqual(["pending", "manual", "failed", "skipped"]);
  });

  it("does not attach a write from a different tick", () => {
    const events = [
      event({ type: "rule_fire", rule: "terrace-dusk" }),
      event({
        ts: at(30),
        type: "write",
        rule: "terrace-dusk",
        device: "powerplug-terrace",
        attr: "state",
        value: "OFF",
        status: "applied",
      }),
    ];
    expect(buildRuns(events)).toHaveLength(2);
  });

  it("keeps the last run per schedule", () => {
    const events = [
      event({ type: "rule_skip", rule: "terrace-dusk", reason: "condition_false" }),
      event({ ts: at(5), type: "rule_fire", rule: "terrace-dusk" }),
    ];
    expect(lastRunPerRule(buildRuns(events)).get("terrace-dusk")?.outcome).toBe("ran");
  });

  it("finds the newest writer per reading", () => {
    const events = [
      event({ type: "state", device: "powerplug-terrace", attr: "state", value: "OFF", source: "mqtt" }),
      event({
        ts: at(-60),
        type: "state",
        device: "powerplug-terrace",
        attr: "state",
        value: "ON",
        source: "mqtt",
      }),
    ];
    expect(provenanceIndex(events).get("powerplug-terrace\u0000state")?.value).toBe("OFF");
  });

  it("flags a reading that differs from what a schedule set", () => {
    const home = buildHome(devices, rules, []);
    const events = [
      event({ type: "rule_fire", rule: "terrace-dusk" }),
      event({
        ts: at(0.2),
        type: "write",
        rule: "terrace-dusk",
        device: "powerplug-terrace",
        attr: "state",
        value: "ON",
        previous: "OFF",
        status: "applied",
      }),
    ];
    const now = Date.parse("2026-10-11T19:16:00.000Z");
    const runs = buildRuns(events);
    const flagged = expectedNow(
      runs,
      { "powerplug-terrace": { state: { value: "OFF", ts: at(30), source: "manual" } } },
      home,
      now,
    );
    expect(flagged).toHaveLength(1);
    const quiet = expectedNow(
      runs,
      { "powerplug-terrace": { state: { value: "ON", ts: at(30), source: "state" } } },
      home,
      now,
    );
    expect(quiet).toHaveLength(0);
  });

  it("merges pending timers and next fires into one sorted list", () => {
    const items = upcomingItems(
      [
        {
          id: "revert:powerplug-terrace:state",
          kind: "revert",
          device: "powerplug-terrace",
          attr: "state",
          value: "OFF",
          due_at: at(3600),
        },
        { id: "for:bathroom-setback", kind: "for", rule: "bathroom-setback", due_at: at(7200) },
      ],
      { "terrace-dusk": at(600) },
      rules,
    );
    expect(items.map((item) => item.kind)).toEqual(["schedule", "revert", "for"]);
  });
});

describe("command lifecycle correlation", () => {
  it("correlates delayed and overlapping requests without attaching to a nearby fire", () => {
    const runs = buildRuns(
      [
        event({ type: "rule_fire", rule: "light" }),
        event({
          ts: at(0.1),
          type: "write",
          rule: "light",
          device: "plug",
          attr: "state",
          status: "pending",
          request_id: "old",
        }),
        event({ ts: at(1), type: "rule_fire", rule: "light" }),
        event({
          ts: at(1.1),
          type: "write",
          rule: "light",
          device: "plug",
          attr: "state",
          status: "pending",
          request_id: "new",
        }),
        event({
          ts: at(2),
          type: "command_result",
          device: "plug",
          attr: "state",
          status: "confirmed",
          request_id: "new",
        }),
        event({
          ts: at(60),
          type: "command_result",
          device: "plug",
          attr: "state",
          status: "failed",
          request_id: "old",
        }),
      ].reverse(),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].outcome).toBe("confirmed");
    expect(runs[1].outcome).toBe("failed");
    expect(runs.every((r) => r.rule === "light" && r.source === "schedule")).toBe(true);
  });
  it("groups a manual patch and preserves partial and uncertain outcomes", () => {
    const writes = [
      event({ type: "write", device: "pump", attr: "mode", status: "pending", request_id: "a" }),
      event({ type: "write", device: "pump", attr: "setpoint", status: "pending", request_id: "a" }),
      event({
        ts: at(3),
        type: "command_result",
        device: "pump",
        attr: "mode",
        status: "confirmed",
        request_id: "a",
      }),
      event({
        ts: at(5),
        type: "command_result",
        device: "pump",
        attr: "setpoint",
        status: "failed",
        request_id: "a",
      }),
    ];
    const runs = buildRuns(writes);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("partial");
    expect(runs[0].source).toBe("manual");
    expect(buildRuns([event({ type: "command_result", status: "unconfirmed" })])[0].outcome).toBe(
      "uncertain",
    );
    expect(
      provenanceIndex([event({ type: "write", device: "pump", attr: "mode", status: "pending" })]).size,
    ).toBe(0);
  });
});

it("keeps per-schedule provenance in a shared gateway patch and expands request-wide timeouts", () => {
  const runs = buildRuns([
    event({ type: "rule_fire", rule: "a" }),
    event({ type: "rule_fire", rule: "b" }),
    event({
      ts: at(1),
      type: "write",
      rule: "a",
      request_id: "shared",
      device: "pump",
      attr: "mode",
      value: "cool",
      status: "pending",
    }),
    event({
      ts: at(1),
      type: "write",
      rule: "b",
      request_id: "shared",
      device: "pump",
      attr: "setpoint",
      value: 20,
      status: "pending",
    }),
    event({
      ts: at(40),
      type: "command_result",
      request_id: "shared",
      device: "pump",
      status: "unconfirmed",
    }),
  ]);
  expect(runs).toHaveLength(2);
  expect(runs.map((r) => r.rule).sort()).toEqual(["a", "b"]);
  expect(runs.every((r) => r.outcome === "uncertain")).toBe(true);
});
