import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deviceSchema, eventSchema, groupSchema, readySchema, ruleSchema, timersSchema } from "@/api/types";
import devicesFixture from "@/mocks/fixtures/devices.json";
import eventsFixture from "@/mocks/fixtures/events.json";
import groupsFixture from "@/mocks/fixtures/groups.json";
import readyFixture from "@/mocks/fixtures/readyz.json";
import rulesFixture from "@/mocks/fixtures/rules.json";
import timersFixture from "@/mocks/fixtures/timers.json";

/** The zod schemas are the contract with the backend; real payloads must satisfy them. */
describe("the schemas accept the real payloads", () => {
  it("parses readyz", () => {
    expect(() => readySchema.parse(readyFixture)).not.toThrow();
  });

  it("parses devices, groups, rules", () => {
    expect(() => z.array(deviceSchema).parse(devicesFixture)).not.toThrow();
    expect(() => z.array(groupSchema).parse(groupsFixture)).not.toThrow();
    expect(() => z.array(ruleSchema).parse(rulesFixture)).not.toThrow();
  });

  it("parses events and timers", () => {
    expect(() => z.array(eventSchema).parse(eventsFixture)).not.toThrow();
    expect(() => timersSchema.parse(timersFixture)).not.toThrow();
  });
});
