import type { Device, Event, WriteResult } from "@/api/types";
import { durationSeconds } from "@/lib/duration";

export type GatewayScenario = "confirmed" | "reported" | "failed" | "unconfirmed" | "partial" | "delayed";
export const gatewayDevices: Device[] = (
  ["confirmed", "reported", "failed", "unconfirmed", "partial", "delayed"] as GatewayScenario[]
).map((scenario) => ({
  id: `demo-gateway-${scenario}`,
  name: `Gateway demo: ${scenario}`,
  locked: false,
  referenced_by: [],
  command: { topic: "demo/set", state_topic: "demo/state", result_topic: "demo/result" },
  attributes: {
    mode: { type: "string", enum: ["heat", "cool", "auto"], write: { topic: "demo/set" } },
    setpoint: { type: "number", unit: "C", limits: [10, 30], step: 0.5, write: { topic: "demo/set" } },
  },
  state: {
    mode: { value: "heat", source: "gateway", ts: new Date().toISOString() },
    setpoint: { value: 21, source: "gateway", ts: new Date().toISOString() },
  },
  availability: {
    available: scenario !== "failed",
    reason: scenario === "failed" ? "demo unavailable" : null,
  },
  mock_scenario: scenario,
}));

gatewayDevices.push({
  ...structuredClone(gatewayDevices[0]),
  id: "demo-gateway-stale",
  name: "Gateway demo: stale observations",
  state: {},
  availability: { available: false, reason: "stale" },
  mock_scenario: "failed",
});

export function durationMs(duration: string): number {
  const seconds = durationSeconds(duration);
  if (seconds === null || seconds < 0) throw new Error("Invalid duration");
  return seconds * 1000;
}

/** Emits delayed request stages without ever replacing observations with pending intent. */
export function simulateGateway(
  device: Device,
  body: Record<string, unknown>,
  record: (event: Event) => void,
  scenario: GatewayScenario,
): WriteResult[] {
  const request = crypto.randomUUID();
  const attrs = Object.keys(body).filter((a) => a !== "revert_after");
  const results = attrs.map((attr) => ({
    device: device.id,
    attr,
    value: body[attr],
    status: "pending",
    request_id: request,
    source: "manual",
  }));
  device.pending ??= {};
  for (const result of results) {
    device.pending[result.attr] = { request_id: request, value: result.value, status: "pending" };
    record({ ts: new Date().toISOString(), type: "write", ...result });
  }
  const stage = (terminal: boolean) =>
    results.forEach((result, index) => {
      const status = !terminal
        ? "accepted"
        : scenario === "partial"
          ? index === 0
            ? "confirmed"
            : "failed"
          : scenario === "delayed"
            ? "confirmed"
            : scenario;
      const reason =
        status === "failed" ? "demo_device_rejected" : status === "unconfirmed" ? "demo_timeout" : null;
      record({ ts: new Date().toISOString(), type: "command_result", ...result, status, reason });
      if (device.pending?.[result.attr]?.request_id !== request) return;
      if (!terminal) {
        device.pending[result.attr].status = status;
        return;
      }
      delete device.pending[result.attr];
      device.command_results ??= {};
      device.command_results[result.attr] = { ...result, status, reason };
      if (status === "confirmed" || status === "reported") {
        record({
          type: "state",
          ts: new Date().toISOString(),
          device: device.id,
          attr: result.attr,
          value: result.value,
          source: status === "reported" ? "melcloud" : "gateway",
        });
        device.state[result.attr] = {
          value: result.value,
          source: status === "reported" ? "melcloud" : "gateway",
          ts: new Date().toISOString(),
        };
      }
    });
  setTimeout(() => stage(false), 300);
  setTimeout(() => stage(true), scenario === "delayed" ? 15000 : 2500);
  return results;
}
