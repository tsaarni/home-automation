// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ruleSchema } from "@/api/types";
import { ScheduleDetailScreen } from "@/features/schedules/ScheduleDetail";
import { makeNames } from "@/home/names";
import { makeTime } from "@/lib/format";

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
const rule = ruleSchema.parse({
  id: "test",
  name: "Test schedule",
  enabled: true,
  when: { at: "23:30" },
  then: [{ set: { device: "light", attr: "state", value: "OFF" } }],
});
vi.mock("@/components/StatusHeader", () => ({ StatusHeader: () => <h1>Schedule</h1> }));
vi.mock("@/api/queries", () => ({
  useRules: () => ({ data: [rule] }),
  useEvents: () => ({ data: [] }),
  useTimers: () => ({}),
  useNames: () => makeNames([], [rule], []),
  useTime: () => makeTime("Europe/Helsinki"),
  useToggleRule: () => ({ mutate: vi.fn() }),
  useDeleteRule: () => ({ mutate: remove, error: new Error("Server refused deletion"), isPending: false }),
  useTestRule: () => ({ mutate: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  remove.mockReset();
});
it("keeps the confirmation and error visible after a failed delete", () => {
  const router = createMemoryRouter(
    [
      { path: "/schedules/:id", element: <ScheduleDetailScreen /> },
      { path: "/schedules", element: <div>Schedule list</div> },
    ],
    { initialEntries: ["/schedules/test"] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByText("Delete schedule"));
  fireEvent.click(screen.getByText("Delete Permanently"));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Delete Schedule?")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Server refused deletion");
  expect(router.state.location.pathname).toBe("/schedules/test");
});
