import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { useEvents, useHome, useReady, useRules, useStateSnapshot, useTime, useTimers } from "@/api/queries";
import { humanizeWords } from "@/lib/reasons";
import { buildRuns, expectedNow } from "@/lib/runs";
import { setSearch, useSearchQuery } from "@/lib/search";
import { useTheme } from "@/theme/theme";
import { tokens } from "@/theme/tokens.stylex";
import { Badge, Button, Dialog, Muted, Row, TextField } from "./primitives";

const styles = stylex.create({
  bar: {
    position: "sticky",
    top: 0,
    zIndex: 30,
    backgroundColor: tokens.surface,
    borderBottomColor: tokens.border,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    paddingBlock: tokens.space2,
    paddingInline: tokens.space4,
    marginBottom: tokens.space4,
    display: "flex",
    flexDirection: "column",
    gap: tokens.space2,
  },
  row: { display: "flex", alignItems: "center", gap: tokens.space2, flexWrap: "wrap" },
  dot: { width: "9px", height: "9px", borderRadius: "50%", flexShrink: 0 },
  live: { backgroundColor: tokens.ok },
  stale: { backgroundColor: tokens.warn },
  dead: { backgroundColor: tokens.bad },
  search: { flexGrow: 1, minWidth: "140px" },
});

/** The header: is the house live, is anything wrong, and the one search box (§5.1). */
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
  const dot = ready.isError ? styles.dead : freshness < 12000 ? styles.live : styles.stale;

  const problems = useMemo(() => {
    const found: string[] = [...(state?.warnings ?? []).map(humanizeWords)];
    if (events.isError) found.push("the activity log could not be read");
    const recent = (events.data ?? []).filter(
      (event) => Date.now() - new Date(event.ts).getTime() < 24 * 3600 * 1000,
    );
    for (const event of recent) {
      if (event.type === "rule_error")
        found.push(`${event.rule ?? "a schedule"} failed: ${event.error ?? "error"}`);
      if (event.type === "mqtt_value_error")
        found.push(`a device sent something unreadable (${event.device ?? "?"}.${event.attr ?? "?"})`);
      if (event.type === "rule_depth_limit") found.push("a loop of schedules was stopped (depth limit)");
    }
    const runs = buildRuns(recent.filter((event) => event.type !== "state"));
    for (const flag of expectedNow(runs, snapshot.data ?? {}, home)) {
      const thing = home.byDevice.get(flag.device)?.name ?? flag.device;
      found.push(
        `${thing} is off-schedule: it is ${String(flag.actual)} but ${flag.run.rule} expected ${String(flag.expected)}`,
      );
    }
    return [...new Set(found)];
  }, [state?.warnings, events.data, events.isError, home, snapshot.data]);

  const overrides = timers.data?.timers.filter((timer) => timer.kind === "revert").length ?? 0;

  return (
    <div {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.row)}>
        <span
          {...stylex.props(styles.dot, dot)}
          title={ready.isError ? "the backend is unreachable" : "live"}
        />
        <strong style={{ fontSize: 16 }}>Home</strong>
        <Badge tone={state?.mqtt_connected ? "ok" : state?.mqtt_enabled ? "bad" : "muted"}>
          {state?.mqtt_connected ? "mqtt up" : state?.mqtt_enabled ? "mqtt down" : "mqtt off"}
        </Badge>
        {state?.dry_run ? <Badge tone="warn">dry run</Badge> : null}
        {overrides ? (
          <Badge tone="accent">
            {overrides} override{overrides === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {problems.length ? (
          <Button size="small" variant="ghost" onClick={() => setProblemsOpen(true)}>
            ⚠ {problems.length} problem{problems.length === 1 ? "" : "s"}
          </Button>
        ) : (
          <Badge tone="ok">no problems</Badge>
        )}
        <Button
          size="small"
          variant="ghost"
          title="left/right: light, dark, system"
          onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}
        >
          {theme === "system" ? "auto" : theme}
        </Button>
      </div>
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.search)}>
          <TextField value={query} onChange={setSearch} placeholder="search things and schedules…" />
        </div>
        <Muted>
          {state?.devices ?? 0} things · {rules.data?.length ?? 0} schedules · {time.zone}
        </Muted>
      </div>

      {problemsOpen ? (
        <Dialog title="Problems" onClose={() => setProblemsOpen(false)}>
          {problems.length ? (
            problems.map((problem) => <div key={problem}>· {problem}</div>)
          ) : (
            <Muted>nothing is wrong</Muted>
          )}
          <Row gap={2}>
            <Button size="small" onClick={() => setProblemsOpen(false)}>
              close
            </Button>
          </Row>
        </Dialog>
      ) : null}
    </div>
  );
}
