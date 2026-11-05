// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceSchema, type Group, type Rule } from "@/api/types";
import { ScheduleBuilder } from "@/features/schedules/ScheduleBuilder";
import { makeNames } from "@/home/names";

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  saveGroup: vi.fn(),
  groups: [] as Group[],
  error: null as Error | null,
}));
const devices = [
  deviceSchema.parse({
    id: "light",
    name: "Light",
    attributes: { state: { type: "string", enum: ["ON", "OFF"], write: { topic: "set" } } },
  }),
];
vi.mock("@/api/queries", () => ({
  useDevices: () => ({ data: devices }),
  useGroups: () => ({ data: state.groups }),
  useRules: () => ({ data: [{ id: "same-name" }] }),
  useNames: () => makeNames(devices, [], state.groups),
  useSaveGroup: () => ({ mutate: state.saveGroup, isPending: false }),
  useDeleteGroup: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveRule: () => ({ mutate: state.mutate, error: state.error, isPending: false }),
}));
afterEach(() => {
  cleanup();
  state.mutate.mockReset();
  state.error = null;
  state.groups = [];
  state.saveGroup.mockReset();
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
  it.each(["Cancel", "Save changes"])("preserves the schedule draft after group editing via %s", (action) => {
    state.groups = [{ id: "lights", name: "Lights", members: ["light"], referenced_by: [] }];
    state.saveGroup.mockImplementation((_group, options) => options.onSuccess());
    const { container } = mount();
    input(container, "Name (optional)", "My unsaved schedule");
    input(container, "Time", "02:15");
    choose(container, "Device or group", "group:lights");
    choose(container, "Set to", "OFF");
    fireEvent.click(screen.getByText("View/edit group"));
    expect(screen.getByText("Edit group")).toBeTruthy();
    fireEvent.click(screen.getByText(action));
    expect(container.querySelector('[label="Name (optional)"]')?.getAttribute("value")).toBe(
      "My unsaved schedule",
    );
    expect(container.querySelector('[label="Time"]')?.getAttribute("value")).toBe("02:15");
    fireEvent.click(screen.getByText("Create schedule"));
    expect(state.mutate.mock.calls[0][0]).toMatchObject({
      name: "My unsaved schedule",
      then: [{ set: { group: "lights", value: "OFF" } }],
    });
  });
  it("keeps untouched errors quiet, validates on submit and retains server errors", () => {
    state.error = new Error("Save rejected");
    mount();
    expect(screen.queryByText("Choose a device or group and control.")).toBeNull();
    fireEvent.click(screen.getByText("Create schedule"));
    expect(screen.getByText("Choose a device or group and control.")).toBeTruthy();
    expect(screen.getByText(/Save rejected/)).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("creates a one-shot action with a unique ID while preserving the chosen value", () => {
    const { container } = mount();
    choose(container, "Device or group", "device:light");
    choose(container, "Set to", "OFF");
    input(container, "Time", "01:00");
    input(container, "Name (optional)", "Same name");
    fireEvent.click(screen.getByText("Create schedule"));
    const doc = state.mutate.mock.calls[0][0] as Rule;
    expect(doc.id).toMatch(/^same-name-[0-9a-f-]{36}$/);
    expect(doc.when.at).toBe("01:00");
    expect(doc.once).toBe(true);
    expect(doc.when.days).toBeUndefined();
    expect(doc.then[0].set?.value).toBe("OFF");
    fireEvent.click(screen.getByText("Create schedule"));
    expect(state.mutate.mock.calls[1][0].id).toBe(doc.id);
  });
  it("leaves generated summaries out of the optional name", () => {
    const { container } = mount();
    choose(container, "Device or group", "device:light");
    expect(container.querySelector('[label="Repeat"]')).toBeNull();
    fireEvent.click(screen.getByText("Create schedule"));
    expect(state.mutate.mock.calls[0][0].name).toBeNull();
    expect(state.mutate.mock.calls[0][0].when.days).toBeUndefined();
  });
  it("preserves per-trigger drafts and rejects custom days with no selection", () => {
    const { container } = mount();
    choose(container, "Trigger", "every");
    input(container, "Interval", "37");
    choose(container, "Trigger", "at");
    choose(container, "Trigger", "every");
    expect(container.querySelector('[label="Interval"]')?.getAttribute("value")).toBe("37");
    choose(container, "Trigger", "at");
    choose(container, "Run", "repeat");
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
