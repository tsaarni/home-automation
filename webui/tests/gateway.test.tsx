// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceSchema } from "@/api/types";
import { ClimatePatch } from "@/components/ClimatePatch";
import { buildHome } from "@/home/derive";
import { makeNames } from "@/home/names";
import { makeTime } from "@/lib/format";
import { writeSentence } from "@/lib/reasons";
import { buildRuns } from "@/lib/runs";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/api/queries", () => ({
  useSetValue: () => ({ mutate, isPending: false }),
  useTime: () => makeTime("Europe/Helsinki"),
}));

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
    const thing = buildHome([{ ...device, pending: {} }], [], []).things[0];
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

  it("keeps an in-flight request disabled and never invents a mode", () => {
    const thing = buildHome([device], [], []).things[0];
    const { container } = render(<ClimatePatch thing={thing} />);
    expect(container.querySelector("md-filled-button")?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Requested/).textContent).toContain("cool");
    expect(mutate).not.toHaveBeenCalled();
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
        { device: device.id, attr: "mode", value: "cool", status: "reported", source: "melcloud" },
        makeNames([device], [], []),
      ),
    ).toContain("reported by MELCloud");
  });
});

it("rejects invalid temperature bounds and preserves drafts across polls", () => {
  const thing = buildHome([{ ...device, pending: {} }], [], []).things[0];
  const { container, rerender } = render(<ClimatePatch thing={thing} />);
  const field = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
  field.value = "99";
  fireEvent.input(field);
  expect(container.querySelector("md-filled-button")?.hasAttribute("disabled")).toBe(true);
  const polled = buildHome(
    [
      {
        ...device,
        pending: {},
        state: { ...device.state, setpoint: { ...device.state.setpoint, value: 22 } },
      },
    ],
    [],
    [],
  ).things[0];
  rerender(<ClimatePatch thing={polled} />);
  expect((container.querySelector("md-outlined-text-field") as HTMLElement & { value: string }).value).toBe(
    "99",
  );
  fireEvent.click(screen.getByText("Discard changes"));
  expect((container.querySelector("md-outlined-text-field") as HTMLElement & { value: string }).value).toBe(
    "22",
  );
});

it("requires a climate temperature aligned to metadata steps", () => {
  const stepped = {
    ...device,
    pending: {},
    attributes: {
      ...device.attributes,
      setpoint: { ...device.attributes.setpoint, step: 0.5 },
    },
  };
  const thing = buildHome([stepped], [], []).things[0];
  const { container } = render(<ClimatePatch thing={thing} />);
  const field = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
  field.value = "21.2";
  fireEvent.input(field);
  fireEvent.click(screen.getByText("Apply mode and temperature"));
  expect(mutate).not.toHaveBeenCalled();
  expect(field.getAttribute("error-text")).toContain("increments of 0.5");
});
