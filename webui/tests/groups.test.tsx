// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { deviceSchema, type Group } from "@/api/types";
import { GroupEditor } from "@/features/groups/GroupsScreen";
import { makeNames } from "@/home/names";

const state = vi.hoisted(() => ({ mutate: vi.fn(), remove: vi.fn(), deleteError: null as Error | null }));
const devices = ["one", "two"].map((id) => deviceSchema.parse({ id, name: id, attributes: {} }));
vi.mock("@/api/queries", () => ({
  useDevices: () => ({ data: devices }),
  useGroups: () => ({ data: [{ id: "existing" }] }),
  useNames: () => makeNames(devices, [], []),
  useDeleteGroup: () => ({ mutate: state.remove, isPending: false, error: state.deleteError }),
  useSaveGroup: () => ({ mutate: state.mutate, isPending: false }),
}));
afterEach(() => {
  cleanup();
  state.mutate.mockReset();
  state.remove.mockReset();
  state.deleteError = null;
});
function mount(group: Group | null) {
  return render(
    <RouterProvider
      router={createMemoryRouter([{ path: "/", element: <GroupEditor group={group} onClose={vi.fn()} /> }])}
    />,
  );
}
it("requires members and preserves the identity and unknown fields of an edited group", () => {
  mount({
    id: "existing",
    name: "Existing",
    members: [],
    referenced_by: [],
    future: true,
  });
  fireEvent.click(screen.getByText("Save changes"));
  expect(screen.getByText("Choose at least one device.")).toBeTruthy();
  expect(state.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "one" }));
  fireEvent.click(screen.getByText("Save changes"));
  expect(state.mutate.mock.calls[0][0]).toMatchObject({ id: "existing", members: ["one"], future: true });
});

it("keeps device order stable while selecting and supports selected-only filtering", () => {
  mount({ id: "existing", name: "Existing", members: ["two"], referenced_by: [] });
  expect(screen.getAllByRole("checkbox").map((item) => item.parentElement?.textContent)).toEqual([
    "Selected only",
    "one",
    "two",
  ]);
  fireEvent.click(screen.getByRole("checkbox", { name: "one" }));
  expect(screen.getAllByRole("checkbox").map((item) => item.parentElement?.textContent)).toEqual([
    "Selected only",
    "one",
    "two",
  ]);
  fireEvent.click(screen.getByRole("checkbox", { name: "one" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Selected only" }));
  expect(screen.queryByRole("checkbox", { name: "one" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "two" })).toBeTruthy();
});

it("shows affected schedules and prevents deletion when the group is referenced", () => {
  const { container } = mount({
    id: "existing",
    name: "Existing",
    members: ["one"],
    referenced_by: ["night", "morning"],
  });
  expect(screen.getByText("Membership changes affect these 2 schedules.")).toBeTruthy();
  expect(container.querySelector("md-text-button[disabled]")?.textContent).toContain("Delete group");
  expect(screen.queryByText("Delete permanently")).toBeNull();
  expect(state.remove).not.toHaveBeenCalled();
});

it("requires explicit deletion confirmation and keeps server errors visible", () => {
  state.deleteError = new Error("Group is now used by a schedule");
  mount({ id: "existing", name: "Existing", members: ["one"], referenced_by: [] });
  fireEvent.click(screen.getByText("Delete group"));
  expect(state.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Delete permanently"));
  expect(state.remove.mock.calls[0][0]).toBe("existing");
  expect(screen.getByRole("alert").textContent).toContain("Group is now used by a schedule");
});
it("does not overwrite an existing group when creating a same-named group", () => {
  const { container } = mount({ id: "", name: "Existing", members: ["two"], referenced_by: [] });
  expect(container.querySelector('[label="Group name"]')).toBeTruthy();
  expect(state.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save group"));
  expect(state.mutate.mock.calls[0][0].id).toMatch(/^existing-[0-9a-f-]{36}$/);
  fireEvent.click(screen.getByText("Save group"));
  expect(state.mutate.mock.calls[1][0].id).toBe(state.mutate.mock.calls[0][0].id);
});
