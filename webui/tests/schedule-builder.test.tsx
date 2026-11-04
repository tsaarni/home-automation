// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceSchema, type Rule } from "@/api/types";
import { ScheduleBuilder } from "@/features/schedules/ScheduleBuilder";
import { makeNames } from "@/home/names";

const state = vi.hoisted(() => ({ mutate: vi.fn(), error: null as Error | null }));
const devices = [
  deviceSchema.parse({
    id: "light",
    name: "Light",
    attributes: { state: { type: "string", enum: ["ON", "OFF"], write: { topic: "set" } } },
  }),
];
vi.mock("@/api/queries", () => ({
  useDevices: () => ({ data: devices }),
  useGroups: () => ({ data: [] }),
  useRules: () => ({ data: [{ id: "same-name" }] }),
  useNames: () => makeNames(devices, [], []),
  useSaveRule: () => ({ mutate: state.mutate, error: state.error, isPending: false }),
}));
afterEach(() => {
  cleanup();
  state.mutate.mockReset();
  state.error = null;
});
function mount(rule: Rule | null = null, onClose = vi.fn()) {
  const router = createMemoryRouter([
    { path: "/", element: <ScheduleBuilder rule={rule} onClose={onClose} /> },
  ]);
  return render(<RouterProvider router={router} />);
}
function choose(container: HTMLElement, label: string, value: string) {
  const input = container.querySelector(`[label="${label}"]`) as HTMLElement & { value: string };
  input.value = value;
  fireEvent.change(input);
}
function input(container: HTMLElement, label: string, value: string) {
  const field = container.querySelector(`[label="${label}"]`) as HTMLElement & { value: string };
  field.value = value;
  fireEvent.input(field);
}
describe("schedule editor", () => {
  it("keeps untouched errors quiet, validates on submit and retains server errors", () => {
    state.error = new Error("Save rejected");
    mount();
    expect(screen.queryByText("Choose a device or group and control.")).toBeNull();
    fireEvent.click(screen.getByText("Create schedule"));
    expect(screen.getByText("Choose a device or group and control.")).toBeTruthy();
    expect(screen.getByText(/Save rejected/)).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("creates a daily action with a unique ID while preserving the chosen value", () => {
    const { container } = mount();
    choose(container, "Device or group", "device:light");
    choose(container, "Set to", "OFF");
    input(container, "Name (optional)", "Same name");
    fireEvent.click(screen.getByText("Create schedule"));
    const doc = state.mutate.mock.calls[0][0] as Rule;
    expect(doc.id).toMatch(/^same-name-[0-9a-f-]{36}$/);
    expect(doc.when.at).toBe("23:30");
    expect(doc.when.days).toBeUndefined();
    expect(doc.then[0].set?.value).toBe("OFF");
    fireEvent.click(screen.getByText("Create schedule"));
    expect(state.mutate.mock.calls[1][0].id).toBe(doc.id);
  });
  it("preserves per-trigger drafts and rejects custom days with no selection", () => {
    const { container } = mount();
    choose(container, "Trigger", "every");
    input(container, "Interval", "37");
    choose(container, "Trigger", "at");
    choose(container, "Trigger", "every");
    expect(container.querySelector('[label="Interval"]')?.getAttribute("value")).toBe("37");
    choose(container, "Trigger", "at");
    choose(container, "Repeat", "custom");
    fireEvent.click(screen.getByText("Create schedule"));
    expect(screen.getByText("Choose at least one custom day.")).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
  });
});

it("confirms an accepted dirty Escape dismissal only once", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const onClose = vi.fn();
  const { container } = mount(null, onClose);
  input(container, "Name (optional)", "Unsaved draft");
  const dialog = container.querySelector("md-dialog")!;
  expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(true);
  fireEvent(dialog, new Event("close"));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
});
it("keeps the dirty draft when discard is rejected", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const onClose = vi.fn();
  const { container } = mount(null, onClose);
  input(container, "Name (optional)", "Unsaved draft");
  expect(fireEvent(container.querySelector("md-dialog")!, new Event("cancel", { cancelable: true }))).toBe(
    false,
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(
    (container.querySelector('[label="Name (optional)"]') as HTMLElement & { value: string }).value,
  ).toBe("Unsaved draft");
  confirm.mockRestore();
});
