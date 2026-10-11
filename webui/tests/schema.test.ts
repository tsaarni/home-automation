import { describe, expect, it } from "vitest";
import { z } from "zod";
import { eventSchema, readySchema, timersSchema } from "@/api/types";
import eventsFixture from "@/mocks/fixtures/events.json";
import readyFixture from "@/mocks/fixtures/readyz.json";
import timersFixture from "@/mocks/fixtures/timers.json";

/** The zod schemas are the contract with the backend; real payloads must satisfy them. */
describe("the schemas accept the real payloads", () => {
  it("parses readyz", () => {
    expect(() => readySchema.parse(readyFixture)).not.toThrow();
  });

  it("parses events and timers", () => {
    expect(() => z.array(eventSchema).parse(eventsFixture)).not.toThrow();
    expect(() => timersSchema.parse(timersFixture)).not.toThrow();
  });
});
