// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deviceSchema } from "@/api/types";
import { ClimatePatch } from "@/components/ClimatePatch";
import { buildHome } from "@/home/derive";
import { makeNames } from "@/home/names";
import { writeSentence } from "@/lib/reasons";
import { buildRuns } from "@/lib/runs";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/api/queries", () => ({ useSetValue: () => ({ mutate, isPending: false }) }));

const device = deviceSchema.parse({
  id: "new-pump",
  name: "New pump",
  command: { topic: "home/pump/set", state_topic: "home/pump/state", result_topic: "home/pump/result" },
  attributes: {
    mode: { type: "string", enum: ["heat", "cool"], write: { topic: "home/pump/set" } },
    setpoint: { type: "number", unit: "C", limits: [10, 31], write: { topic: "home/pump/set" } },
  },
  state: {
    mode: { value: "heat", ts: "2026-10-11T12:00:00Z", source: "melcloud" },
    setpoint: { value: 21, ts: "2026-10-11T12:00:00Z", source: "melcloud" },
  },
  pending: { mode: { request_id: "new", value: "cool", status: "accepted" } },
  availability: { available: false },
});

describe("gateway controls", () => {
  it("discovers new controls and keeps reported values separate from intent", () => {
    const thing = buildHome([device], [], []).things[0];
    expect(thing.controls.map((r) => r.attr).sort()).toEqual(["mode", "setpoint"]);
    expect(thing.controls.find((r) => r.attr === "mode")?.value).toBe("heat");
    expect(thing.controls.find((r) => r.attr === "mode")?.pending?.value).toBe("cool");
    expect(thing.available).toBe(false);
    expect(makeNames([device], [], []).value(device.id, "mode", "cool")).toBe("cool");
  });

  it("submits edited mode and setpoint as one request", () => {
    const thing = buildHome([device], [], []).things[0];
    const { container } = render(<ClimatePatch thing={thing} />);
    const select = container.querySelector("md-outlined-select") as HTMLElement & { value: string };
    select.value = "cool";
    fireEvent.change(select);
    const input = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
    input.value = "20.5";
    fireEvent.input(input);
    fireEvent.click(screen.getByText("Apply mode and temperature"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      target: { kind: "device", id: device.id },
      body: { mode: "cool", setpoint: 20.5 },
    });
  });

  it("shows asynchronous results in audit with accurate cloud wording", () => {
    const runs = buildRuns([
      {
        ts: "2026-10-11T12:00:00Z",
        type: "command_result",
        device: device.id,
        attr: "mode",
        value: "cool",
        status: "reported",
      },
    ]);
    expect(runs[0].writes).toHaveLength(1);
    expect(
      writeSentence(
        { device: device.id, attr: "mode", value: "cool", status: "reported" },
        makeNames([device], [], []),
      ),
    ).toContain("reported by MELCloud");
  });
});
