import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useEvents, useHome, useReady, useRules, useStateSnapshot, useTime, useTimers } from "@/api/queries";
import { humanizeWords } from "@/lib/reasons";
import { buildRuns, expectedNow } from "@/lib/runs";
import { setSearch, useSearchQuery } from "@/lib/search";
import { useTheme } from "@/theme/theme";
import { Badge, Button, Dialog, Icon, Muted, Row, Select, Stack, TextField } from "./primitives";

export function StatusHeader({ title }: { title?: string }) {
  const location = useLocation();
  const page =
    title ??
    (location.pathname.startsWith("/schedules")
      ? "Schedules"
      : location.pathname === "/activity"
        ? "Activity"
        : location.pathname === "/advanced"
          ? "Advanced"
          : "Home");
  const searchLabel =
    location.pathname === "/"
      ? "Search rooms, devices and controls"
      : location.pathname === "/schedules"
        ? "Search schedules"
        : location.pathname.startsWith("/devices")
          ? location.pathname === "/devices/groups"
            ? "Search groups"
            : "Search devices"
          : location.pathname === "/activity"
            ? "Search activity"
            : null;
  useEffect(() => {
    document.title = `${page} · Home automation`;
  }, [page]);
  const ready = useReady();
  const events = useEvents();
  const timers = useTimers();
  const rules = useRules();
  const home = useHome();
  const snapshot = useStateSnapshot();
  const time = useTime();
  const query = useSearchQuery();
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [theme, setTheme] = useTheme();

  const state = ready.data;
  const freshness = ready.dataUpdatedAt ? Date.now() - ready.dataUpdatedAt : Number.POSITIVE_INFINITY;
  const isStale = !ready.isError && freshness >= 15000;

  const problems = useMemo(() => {
    const found: string[] = [...(state?.warnings ?? []).map(humanizeWords)];
    if (events.isError) found.push("The activity log could not be read");
    const recent = (events.data ?? []).filter(
      (event) => Date.now() - new Date(event.ts).getTime() < 24 * 3600 * 1000,
    );
    for (const event of recent) {
      if (event.type === "rule_error")
        found.push(`${event.rule ?? "A schedule"} failed: ${event.error ?? "error"}`);
      if (event.type === "mqtt_value_error")
        found.push(`A device sent unreadable telemetry (${event.device ?? "?"}.${event.attr ?? "?"})`);
      if (event.type === "rule_depth_limit") found.push("A cascade of schedules was stopped (depth limit)");
    }
    const requests = new Set<string>();
    for (const thing of home.things)
      for (const reading of thing.readings) {
        if (reading.pending || !["failed", "error", "unconfirmed"].includes(reading.outcome ?? "")) continue;
        const key = String(reading.result?.request_id ?? `${thing.id}:${reading.attr}`);
        if (requests.has(key)) continue;
        requests.add(key);
        found.push(
          `${thing.name}: ${reading.outcome === "unconfirmed" ? "request outcome uncertain; check reported state" : "device request failed"}${reading.result?.reason ? ` (${humanizeWords(reading.result.reason)})` : ""}`,
        );
      }
    const runs = buildRuns(recent.filter((event) => event.type !== "state"));
    for (const flag of expectedNow(runs, snapshot.data ?? {}, home)) {
      const thing = home.byDevice.get(flag.device)?.name ?? flag.device;
      found.push(
        `${thing} is off-schedule: currently ${String(flag.actual)} but ${flag.run.rule} expected ${String(flag.expected)}`,
      );
    }
    return [...new Set(found)];
  }, [state?.warnings, events.data, events.isError, home, snapshot.data]);

  const overrides = timers.data?.timers.filter((timer) => timer.kind === "revert").length ?? 0;

  return (
    <header className="form-section" style={{ marginBottom: 24 }}>
      <Row justify="space-between" wrap>
        <h1 style={{ margin: 0, fontSize: 26 }}>{page}</h1>
        <Row wrap>
          <span role="status">
            {ready.isPending
              ? "Connecting…"
              : ready.isError
                ? "Backend unavailable"
                : isStale
                  ? "Connection stale"
                  : state?.mqtt_connected
                    ? "Connected"
                    : state?.mqtt_enabled
                      ? "Device connection unavailable"
                      : "Backend connected"}
          </span>
          {state?.dry_run && <Badge tone="warn">Dry run — device commands simulated</Badge>}
          {problems.length > 0 && (
            <Button variant="tonal" onClick={() => setProblemsOpen(true)}>
              {problems.length} issues
            </Button>
          )}
        </Row>
      </Row>
      <details>
        <summary>Connection and display settings</summary>
        <Stack gap={12}>
          <Muted>
            {state
              ? `${state.devices} devices · ${rules.data?.length ?? "…"} schedules · ${time.zone}`
              : "Waiting for system status…"}
          </Muted>
          <Muted>
            {state
              ? state.mqtt_connected
                ? "MQTT connected"
                : state.mqtt_enabled
                  ? "MQTT disconnected"
                  : "MQTT disabled"
              : "Connection unknown"}
          </Muted>
          {overrides > 0 && (
            <a className="text-link" href="/#upcoming">
              {overrides} temporary changes — view expiry times
            </a>
          )}
          <Select
            label="Theme"
            value={theme}
            onChange={(v) => setTheme(v as typeof theme)}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Stack>
      </details>
      {searchLabel && (
        <Row>
          <TextField label={searchLabel} value={query} onChange={setSearch} leadingIcon="search" />
          {query && (
            <Button variant="text" onClick={() => setSearch("")}>
              Clear
            </Button>
          )}
        </Row>
      )}

      {problemsOpen ? (
        <Dialog
          title="System Status & Diagnostics"
          onClose={() => setProblemsOpen(false)}
          footer={
            <Button variant="tonal" onClick={() => setProblemsOpen(false)}>
              Close
            </Button>
          }
        >
          <Stack gap={8}>
            <a className="text-link" href="/">
              View device controls and reported state
            </a>
            {problems.length ? (
              problems.map((p) => (
                <div
                  key={p}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    backgroundColor: "var(--md-sys-color-surface-container-high)",
                    color: "var(--md-sys-color-on-surface)",
                    fontSize: "13px",
                  }}
                >
                  <Icon name="error_outline" />
                  <span>{p}</span>
                </div>
              ))
            ) : (
              <Muted>No warnings reported.</Muted>
            )}
          </Stack>
        </Dialog>
      ) : null}
    </header>
  );
}
