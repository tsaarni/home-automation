// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { deviceSchema, type Event, type Timer } from "@/api/types";
import { ProvenancePanel } from "@/components/ProvenancePanel";
import { HomeScreen } from "@/features/home/HomeScreen";
import { buildHome } from "@/home/derive";
import { makeNames } from "@/home/names";
import { makeTime } from "@/lib/format";

const state = vi.hoisted(() => ({
  query: "",
  events: [] as Event[],
  timers: [] as Timer[],
  mutate: vi.fn(),
}));
const devices = Array.from({ length: 6 }, (_, i) =>
  deviceSchema.parse({
    id: `office-sensor-${i}`,
    name: `Sensor ${i}`,
    locked: i === 5,
    attributes: {
      temperature: { type: "number", limits: [10, 30], enum: [15, 20, 25], write: { topic: "set" } },
      humidity: { type: "number" },
      battery: { type: "number", unit: "%" },
    },
    state: {
      temperature: { value: 20, ts: "2026-11-04T12:00:00Z", source: "mqtt" },
      humidity: { value: 40, ts: "2026-11-04T12:00:00Z", source: "mqtt" },
      battery: { value: 75, ts: "2026-11-04T12:00:00Z", source: "mqtt" },
    },
  }),
);
const home = buildHome(devices, [], []);
vi.mock("@/api/queries", () => ({
  useHome: () => home,
  useDevices: () => ({ data: devices }),
  useTimers: () => ({ data: { timers: state.timers, next_due: {} } }),
  useRules: () => ({ data: [] }),
  useNames: () => makeNames(devices, [], []),
  useTime: () => makeTime("Europe/Helsinki"),
  useSetValue: () => ({ mutate: state.mutate, isPending: false }),
  useEvents: () => ({ data: state.events }),
}));
vi.mock("@/lib/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/search")>()),
  useSearchQuery: () => state.query,
}));
vi.mock("@/components/StatusHeader", () => ({ StatusHeader: () => <h1>Home</h1> }));
afterEach(() => {
  cleanup();
  state.query = "";
  state.events = [];
  state.timers = [];
  state.mutate.mockClear();
});

it("previews four devices and supports expansion and collapse", () => {
  render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole("region")).toHaveLength(4);
  fireEvent.click(screen.getByText("Show all 6 devices"));
  expect(screen.getAllByRole("region")).toHaveLength(6);
  expect(screen.getByText("Show fewer").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByText("Show fewer"));
  expect(screen.getAllByRole("region")).toHaveLength(4);
});
it("reveals every matching device while searching, including an initially hidden device", () => {
  state.query = "Sensor";
  const { rerender } = render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole("region")).toHaveLength(6);
  expect(screen.queryByText("Show all 6 devices")).toBeNull();
  state.query = "Sensor 5";
  rerender(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(screen.getByText("Controls are locked by the device configuration.")).toBeTruthy();
});
it("keeps secondary readings in a disclosure with a visible explanation action", () => {
  const { container } = render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
  const details = container.querySelector('section[id="device-office-sensor-0"] details')!;
  expect(details.hasAttribute("open")).toBe(false);
  expect(details.textContent).toContain("Battery");
  expect(details.textContent).toContain("Why this value?");
  expect(home.things[0].controls.map((r) => r.attr)).toEqual(["temperature"]);
});
it("offers a previous value only when valid for the current metadata and links its schedule", () => {
  const reading = home.things[0].readings.find((r) => r.attr === "temperature")!;
  const event = {
    type: "write",
    ts: reading.ts!,
    device: reading.device,
    attr: reading.attr,
    value: reading.value,
    previous: 15,
    rule: "morning",
    status: "applied",
  };
  state.events = [event];
  const { rerender } = render(
    <MemoryRouter>
      <ProvenancePanel reading={reading} onClose={() => {}} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/Set back to/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /Schedule:/ }).getAttribute("href")).toBe("/schedules/morning");
  for (const previous of ["15", 35, 22]) {
    state.events = [{ ...event, previous }];
    rerender(
      <MemoryRouter>
        <ProvenancePanel reading={reading} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Set back to/)).toBeNull();
  }
  expect(state.mutate).not.toHaveBeenCalled();
});

it("links upcoming changes to their source and shows the due day", () => {
  const today = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  state.timers = [
    {
      id: "restore",
      kind: "revert",
      device: "office-sensor-0",
      attr: "temperature",
      value: 15,
      due_at: today,
    },
    { id: "delay", kind: "for", rule: "morning", due_at: tomorrow },
  ];
  render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
  expect(screen.getByRole("link", { name: /Sensor 0 returns to/ }).getAttribute("href")).toBe(
    "/?q=#device-office-sensor-0",
  );
  expect(screen.getByRole("link", { name: "Morning" }).getAttribute("href")).toBe("/schedules/morning");
  expect(screen.getByText(`Today ${makeTime("Europe/Helsinki").clock(today)}`)).toBeTruthy();
  expect(screen.getByText(makeTime("Europe/Helsinki").stamp(tomorrow))).toBeTruthy();
  expect(screen.getByText(/checks its conditions after a wait/)).toBeTruthy();
});
