// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, Navigate, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { deviceSchema } from "@/api/types";
import { DevicesLayout, DevicesScreen } from "@/features/devices/DevicesScreen";
import { GroupsScreen } from "@/features/groups/GroupsScreen";
import { makeNames } from "@/home/names";

const devices = [deviceSchema.parse({ id: "light", name: "Kitchen light", attributes: {} })];
const groups = [{ id: "lights", name: "Lights", members: ["light"], referenced_by: [] }];
vi.mock("@/components/StatusHeader", () => ({ StatusHeader: () => <h1>Devices</h1> }));
vi.mock("@/lib/search", () => ({ useSearchQuery: () => "", matches: () => true }));
vi.mock("@/api/queries", () => ({
  useDevices: () => ({ data: devices }),
  useGroups: () => ({ data: groups }),
  useNames: () => makeNames(devices, [], groups),
}));
afterEach(cleanup);
function mount(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/groups", element: <Navigate to="/devices/groups" replace /> },
      {
        path: "/devices",
        element: <DevicesLayout />,
        children: [
          { index: true, element: <DevicesScreen /> },
          { path: "groups", element: <GroupsScreen /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
it("keeps groups under device management and retains old bookmarks", async () => {
  const router = mount("/groups");
  expect(await screen.findByText("New group")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/devices/groups");
  expect(screen.getByRole("link", { name: "Groups" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText("Review thermostat group")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Devices" }));
  expect(await screen.findByText("Kitchen light")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByText("Groups: Lights")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open controls" }).getAttribute("href")).toBe("/#device-light");
});
