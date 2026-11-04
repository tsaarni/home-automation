// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Timer, WriteResult } from "@/api/types";
import { Control } from "@/components/Control";
import type { Reading } from "@/home/derive";
import { commandBusy } from "@/lib/command-busy";
import { makeTime } from "@/lib/format";

const { mutate, state } = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: {
    timers: [] as Timer[],
    isPending: false,
    data: undefined as WriteResult[] | undefined,
    error: null as Error | null,
  },
}));
vi.mock("@/api/queries", () => ({
  useSetValue: () => ({ mutate, isPending: state.isPending, data: state.data, error: state.error }),
  useTime: () => makeTime("Europe/Helsinki"),
  useTimers: () => ({ data: { timers: state.timers } }),
}));
afterEach(() => {
  cleanup();
  mutate.mockClear();
  state.timers = [];
  state.isPending = false;
  state.data = undefined;
  state.error = null;
});
const reading: Reading = {
  device: "test",
  attr: "name",
  label: "Name",
  value: "old",
  known: true,
  source: "mqtt",
  ts: null,
  unit: null,
  isControl: true,
  schedules: [],
  declaredType: "string",
};
it("commits text only on Apply", () => {
  const { container } = render(<Control reading={reading} />);
  const field = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
  field.value = "new";
  fireEvent.input(field);
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Apply"));
  expect(mutate).toHaveBeenCalledWith({ target: { kind: "device", id: "test" }, body: { name: "new" } });
});
it("uses explicit choices for an unknown switch", () => {
  const { container } = render(
    <Control
      reading={{ ...reading, declaredType: "boolean", value: undefined, known: false, on: true, off: false }}
    />,
  );
  expect(container.querySelector("md-switch")).toBeNull();
  expect(screen.getByText("State unknown")).toBeTruthy();
  fireEvent.click(screen.getByText("Off"));
  expect(mutate.mock.calls[0][0].body.name).toBe(false);
});
it("bounds numeric steps and keeps them local before Apply", () => {
  const { container } = render(
    <Control reading={{ ...reading, declaredType: "number", value: 10, min: 10, max: 12, step: 1 }} />,
  );
  expect(screen.getByRole("button", { name: "Decrease Name" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Increase Name" }));
  expect(mutate).not.toHaveBeenCalled();
  const field = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
  field.value = "13";
  fireEvent.input(field);
  expect(container.querySelector("md-filled-button")?.hasAttribute("disabled")).toBe(true);
});
it("bridges the pending HTTP response until its own terminal result arrives", () => {
  const response = [{ device: "test", attr: "name", status: "pending", request_id: "new" }];
  expect(commandBusy(false, response, [reading])).toBe(true);
  expect(
    commandBusy(false, response, [
      { ...reading, outcome: "failed", result: { status: "failed", request_id: "old" } },
    ]),
  ).toBe(true);
  expect(
    commandBusy(false, response, [
      { ...reading, outcome: "confirmed", result: { status: "confirmed", request_id: "new" } },
    ]),
  ).toBe(false);
});

it("discards text edits back to the latest reported value without writing", () => {
  const { container, rerender } = render(<Control reading={reading} />);
  const field = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
  field.value = "draft";
  fireEvent.input(field);
  rerender(<Control reading={{ ...reading, value: "updated" }} />);
  expect(field.value).toBe("draft");
  fireEvent.click(screen.getByText("Discard changes"));
  expect(field.value).toBe("updated");
  expect(mutate).not.toHaveBeenCalled();
});
it("rejects off-step direct entries and supports fine metadata steps", () => {
  const { container, rerender } = render(
    <Control reading={{ ...reading, declaredType: "number", value: 10, min: 10, max: 12, step: 0.5 }} />,
  );
  const field = container.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
  field.value = "10.1";
  fireEvent.input(field);
  expect(field.getAttribute("error-text")).toContain("increments of 0.5");
  fireEvent.click(screen.getByText("Apply"));
  expect(mutate).not.toHaveBeenCalled();
  field.value = "10.5";
  fireEvent.input(field);
  fireEvent.click(screen.getByText("Apply"));
  expect(mutate.mock.calls[0][0].body.name).toBe(10.5);
  fireEvent.click(screen.getByText("Discard changes"));
  rerender(<Control reading={{ ...reading, declaredType: "number", value: 0.001, step: 0.001 }} />);
  fireEvent.click(screen.getByRole("button", { name: "Increase Name" }));
  expect(field.value).toBe("0.002");
});
it("uses the same pending and error feedback for restoring as for direct writes", () => {
  state.timers = [
    {
      id: "restore",
      kind: "revert",
      device: "test",
      attr: "name",
      value: "previous",
      due_at: "2026-11-04T20:00:00Z",
    },
  ];
  const { rerender } = render(<Control reading={reading} />);
  fireEvent.click(screen.getByText("Restore now"));
  expect(mutate).toHaveBeenCalledWith({ target: { kind: "device", id: "test" }, body: { name: "previous" } });
  state.data = [{ device: "test", attr: "name", status: "pending", request_id: "restore-request" }];
  rerender(<Control reading={reading} />);
  expect(screen.getByText("Restore now").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByText("Restore now"));
  expect(mutate).toHaveBeenCalledTimes(1);
  state.data = undefined;
  state.error = new Error("Restore rejected");
  rerender(<Control reading={reading} />);
  expect(screen.getByRole("alert").textContent).toBe("Restore rejected");
  expect(screen.getByText("Restore now").hasAttribute("disabled")).toBe(false);
});
