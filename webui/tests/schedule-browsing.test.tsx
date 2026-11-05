// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { deviceSchema, ruleSchema } from "@/api/types";
import { ScheduleListScreen } from "@/features/schedules/ScheduleList";
import { makeNames } from "@/home/names";
import { makeTime } from "@/lib/format";

const devices = ["one", "two"].map((id) => deviceSchema.parse({ id, name: id, attributes: {} }));
const rules = ["one", "two"].map((id) =>
  ruleSchema.parse({
    id,
    name: `Schedule ${id}`,
    enabled: true,
    when: { at: "22:00" },
    then: [{ set: { device: id, attr: "state", value: "OFF" } }],
  }),
);
vi.mock("@/components/StatusHeader", () => ({ StatusHeader: () => <h1>Schedules</h1> }));
vi.mock("@/lib/search", () => ({ useSearchQuery: () => "", matches: () => true, clearSearch: vi.fn() }));
vi.mock("@/api/queries", () => ({
  useDevices: () => ({ data: devices }),
  useGroups: () => ({ data: [] }),
  useRules: () => ({ data: rules }),
  useHome: () => ({ things: [] }),
  useEvents: () => ({ data: [] }),
  useTimers: () => ({ data: { next_due: { one: "2099-01-01T22:00:00Z", two: "2099-01-01T21:00:00Z" } } }),
  useNames: () => makeNames(devices, rules, []),
  useTime: () => makeTime("Europe/Helsinki"),
  useToggleRule: () => ({ mutate: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
function mount(url = "/schedules") {
  const router = createMemoryRouter([{ path: "/schedules", element: <ScheduleListScreen /> }], {
    initialEntries: [url],
  });
  return { ...render(<RouterProvider router={router} />), router };
}
it("defaults to chronological order and allows filtering by device", () => {
  const { container, router } = mount();
  expect(
    screen
      .getAllByRole("link")
      .filter((link) => link.textContent?.startsWith("Schedule "))
      .map((link) => link.textContent),
  ).toEqual(["Schedule two", "Schedule one"]);
  const select = container.querySelector('[label="Device or group"]') as HTMLElement & { value: string };
  select.value = "device:one";
  fireEvent.change(select);
  expect(screen.queryByText("Schedule two")).toBeNull();
  expect(router.state.location.search).toContain("target=device%3Aone");
});
it("restores view and filters on return, while explicit URL choices take precedence", async () => {
  sessionStorage.setItem("schedule-list-filters", "view=device&target=device%3Aone&status=enabled");
  const first = mount();
  await waitFor(() => expect(first.router.state.location.search).toContain("view=device"));
  expect(screen.queryByText("Schedule two")).toBeNull();
  first.unmount();
  mount("/schedules?view=next&target=all");
  expect(screen.getByText("Schedule two")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "one" })).toBeNull();
});
