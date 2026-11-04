import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@/api/types";
import { buildRuns } from "@/lib/runs";
import { durationMs, gatewayDevices, simulateGateway } from "@/mocks/gateway";

afterEach(() => vi.useRealTimers());
describe("mock gateway", () => {
  it("parses duration units and compound durations", () => {
    expect(durationMs("30m")).toBe(1800000);
    expect(durationMs("1h30m")).toBe(5400000);
    expect(() => durationMs("30bad")).toThrow();
  });
  it.each(["confirmed", "reported", "failed", "unconfirmed", "partial"] as const)(
    "simulates %s without replacing reported state while pending",
    (scenario) => {
      vi.useFakeTimers();
      const device = structuredClone(gatewayDevices[0]);
      const events: Event[] = [];
      simulateGateway(device, { mode: "cool", setpoint: 20 }, (e) => events.push(e), scenario);
      expect(device.state.mode.value).toBe("heat");
      vi.advanceTimersByTime(300);
      expect(device.pending?.mode.status).toBe("accepted");
      vi.advanceTimersByTime(3000);
      expect(device.pending?.mode).toBeUndefined();
      expect(buildRuns(events).find((run) => run.writes.length)?.outcome).toBe(
        scenario === "unconfirmed" ? "uncertain" : scenario,
      );
    },
  );
  it("keeps late results from overwriting a newer request", () => {
    vi.useFakeTimers();
    const device = structuredClone(gatewayDevices[0]);
    const events: Event[] = [];
    simulateGateway(device, { mode: "cool" }, (e) => events.push(e), "delayed");
    vi.advanceTimersByTime(1000);
    simulateGateway(device, { mode: "auto" }, (e) => events.push(e), "confirmed");
    vi.advanceTimersByTime(20000);
    expect(device.state.mode.value).toBe("auto");
    expect(buildRuns(events).filter((run) => run.writes.length)).toHaveLength(2);
  });
});
