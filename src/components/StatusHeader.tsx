import { useMemo, useState } from "react";
import { useEvents, useHome, useReady, useRules, useStateSnapshot, useTime, useTimers } from "@/api/queries";
import { humanizeWords } from "@/lib/reasons";
import { buildRuns, expectedNow } from "@/lib/runs";
import { setSearch, useSearchQuery } from "@/lib/search";
import { useTheme } from "@/theme/theme";
import { Badge, Button, Dialog, Icon, IconButton, Muted, Row, Stack, TextField } from "./primitives";

export function StatusHeader() {
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
  const isLive = !ready.isError && freshness < 15000;
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
      if (event.type === "rule_depth_limit")
        found.push("A cascade of schedules was stopped (depth limit)");
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

  const cycleTheme = () => {
    setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system");
  };

  const themeIcon = theme === "dark" ? "dark_mode" : theme === "light" ? "light_mode" : "brightness_auto";

  return (
    <header
      style={{
        backgroundColor: "var(--md-sys-color-surface-container)",
        borderRadius: "24px",
        padding: "16px 20px",
        marginBottom: "24px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "9999px",
              backgroundColor: isLive ? "var(--md-sys-color-success)" : isStale ? "var(--md-sys-color-warning)" : "var(--md-sys-color-error)",
              boxShadow: `0 0 0 3px ${isLive ? "var(--md-sys-color-success-container)" : isStale ? "var(--md-sys-color-warning-container)" : "var(--md-sys-color-error-container)"}`,
            }}
            title={ready.isError ? "Backend unreachable" : isLive ? "Live updates" : "Stale connection"}
          />
          <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 700, color: "var(--md-sys-color-on-surface)" }}>Home</h1>
        </div>

        <Row gap={8} wrap style={{ flex: 1, justifyContent: "center" }}>
          <Badge tone={state?.mqtt_connected ? "ok" : state?.mqtt_enabled ? "bad" : "muted"}>
            <Icon name={state?.mqtt_connected ? "wifi" : "wifi_off"} />
            <span>{state?.mqtt_connected ? "MQTT up" : state?.mqtt_enabled ? "MQTT down" : "MQTT off"}</span>
          </Badge>

          {state?.dry_run ? (
            <Badge tone="warn">
              <Icon name="science" />
              <span>Dry run</span>
            </Badge>
          ) : null}

          {overrides > 0 ? (
            <Badge tone="accent">
              <Icon name="timer" />
              <span>{overrides} override{overrides === 1 ? "" : "s"}</span>
            </Badge>
          ) : null}

          {problems.length > 0 ? (
            <Button size="small" variant="danger" icon="warning" onClick={() => setProblemsOpen(true)}>
              {problems.length} issue{problems.length === 1 ? "" : "s"}
            </Button>
          ) : (
            <Badge tone="ok">
              <Icon name="check_circle" />
              <span>All systems normal</span>
            </Badge>
          )}
        </Row>

        <div style={{ display: "flex", alignItems: "center" }}>
          <IconButton icon={themeIcon} onClick={cycleTheme} title={`Theme: ${theme}`} />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "240px" }}>
          <TextField
            value={query}
            onChange={setSearch}
            placeholder="Search rooms, things, controls, schedules…"
            leadingIcon="search"
          />
        </div>
        <Muted>
          {state?.devices ?? 0} devices · {rules.data?.length ?? 0} schedules · {time.zone}
        </Muted>
      </div>

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
