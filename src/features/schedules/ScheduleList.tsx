import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useEvents, useHome, useNames, useRules, useTime, useTimers, useToggleRule } from "@/api/queries";
import type { Rule } from "@/api/types";
import { Badge, Button, Card, Chip, Empty, Muted, Row, Stack, Switch } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { outcomeLabel } from "@/lib/reasons";
import { buildRuns, lastRunPerRule } from "@/lib/runs";
import { dayMarks, describeSchedule, parseRule } from "@/lib/schedule";
import { matches, useSearchQuery } from "@/lib/search";
import { tokens } from "@/theme/tokens.stylex";
import { DayStrip } from "./DayStrip";
import { ScheduleBuilder } from "./ScheduleBuilder";

const styles = stylex.create({
  block: { display: "flex", flexDirection: "column", gap: tokens.space2 },
  thingName: { fontSize: tokens.fontLg, fontWeight: 700 },
  ruleRow: {
    display: "flex",
    gap: tokens.space2,
    alignItems: "center",
    flexWrap: "wrap",
    paddingTop: tokens.space2,
    borderTopColor: tokens.border,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  sentence: { textDecoration: "none", color: tokens.text, fontWeight: 500 },
  ruleText: { flexGrow: 1, minWidth: "min(100%, 320px)" },
  dim: { opacity: 0.55 },
});

/** Schedules, grouped by what they affect, with a day strip per thing (§5.2). */
export function ScheduleListScreen() {
  const rules = useRules().data ?? [];
  const timers = useTimers().data;
  const events = useEvents().data ?? [];
  const names = useNames();
  const time = useTime();
  const home = useHome();
  const navigate = useNavigate();
  const toggle = useToggleRule();
  const query = useSearchQuery();
  const [showDisabled, setShowDisabled] = useState(true);
  const [building, setBuilding] = useState<Rule | null | undefined>(undefined);

  const runs = useMemo(() => buildRuns(events), [events]);
  const lastRuns = useMemo(() => lastRunPerRule(runs), [runs]);

  const visible = rules.filter(
    (rule) =>
      (showDisabled || rule.enabled) &&
      matches(
        query,
        rule.name,
        rule.id,
        describeRuleText(rule, names),
        rule.then.map((action) => action.set?.device ?? action.set?.group).join(" "),
      ),
  );

  const blocks = useMemo(() => groupByTarget(visible, names), [visible, names]);

  return (
    <div>
      <StatusHeader />
      <Stack gap={4}>
        <Row gap={2} wrap justify="space-between">
          <Row gap={2} wrap>
            <Chip active={showDisabled} onClick={() => setShowDisabled(true)}>
              all
            </Chip>
            <Chip active={!showDisabled} onClick={() => setShowDisabled(false)}>
              enabled only
            </Chip>
            <Muted>{visible.length} schedules</Muted>
          </Row>
          <Button variant="primary" onClick={() => setBuilding(null)}>
            + New schedule
          </Button>
        </Row>

        {visible.length === 0 ? <Empty>no schedules match</Empty> : null}

        {blocks.map((block) => {
          const blockRules = block.rules;
          const marks = dayMarks(blockRules, timers?.next_due ?? {}, time.zone);
          return (
            <Card key={block.id}>
              <div {...stylex.props(styles.block)}>
                <Row justify="space-between" wrap>
                  <span {...stylex.props(styles.thingName)}>{block.label}</span>
                  <Muted>
                    {blockRules.length} schedule{blockRules.length === 1 ? "" : "s"}
                  </Muted>
                </Row>
                {marks.length > 1 ? <DayStrip marks={marks} label={time.clock(new Date())} /> : null}
                {blockRules.map((rule) => {
                  const parsed = parseRule(rule);
                  const description = parsed.ok ? describeSchedule(parsed.schedule, names) : null;
                  const nextDue = timers?.next_due?.[rule.id];
                  const last = lastRuns.get(rule.id);
                  return (
                    <div key={rule.id} {...stylex.props(styles.ruleRow, !rule.enabled && styles.dim)}>
                      <Switch
                        checked={rule.enabled}
                        label={`${rule.enabled ? "disable" : "enable"} ${rule.name ?? rule.id}`}
                        onChange={(next) => toggle.mutate({ id: rule.id, enabled: next })}
                      />
                      <div {...stylex.props(styles.ruleText)}>
                        <Link
                          to={`/schedules/${encodeURIComponent(rule.id)}`}
                          {...stylex.props(styles.sentence)}
                        >
                          {description
                            ? description.sentence
                            : `${rule.name ?? rule.id} (uses features the builder does not show)`}
                        </Link>
                      </div>
                      {rule.once ? <Badge tone="accent">one-shot</Badge> : null}
                      {!parsed.ok ? <Badge tone="warn">raw</Badge> : null}
                      {last ? (
                        <Badge
                          tone={
                            last.outcome === "ran"
                              ? "ok"
                              : last.outcome === "nothing"
                                ? "muted"
                                : last.outcome === "failed"
                                  ? "bad"
                                  : "warn"
                          }
                        >
                          last: {outcomeLabel(last.outcome)} {time.stamp(last.ts)}
                        </Badge>
                      ) : (
                        <Badge tone="muted" title="the event log only holds the newest events">
                          no recent run
                        </Badge>
                      )}
                      {nextDue ? (
                        <Badge tone="muted">
                          next {time.stamp(nextDue)} ({time.rel(nextDue)})
                        </Badge>
                      ) : null}
                      <Row gap={1}>
                        <Button size="small" variant="ghost" onClick={() => setBuilding(rule)}>
                          edit
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => navigate(`/schedules/${encodeURIComponent(rule.id)}`)}
                        >
                          runs
                        </Button>
                      </Row>
                    </div>
                  );
                })}
                {block.id === "__unassigned__" && home.things.length ? (
                  <Muted>these schedules do not set a thing the UI knows</Muted>
                ) : null}
              </div>
            </Card>
          );
        })}
      </Stack>

      {building !== undefined ? (
        <ScheduleBuilder rule={building} onClose={() => setBuilding(undefined)} />
      ) : null}
    </div>
  );
}

function describeRuleText(rule: Rule, names: ReturnType<typeof useNames>): string {
  const parsed = parseRule(rule);
  return parsed.ok ? describeSchedule(parsed.schedule, names).sentence : (rule.name ?? rule.id);
}

interface Block {
  id: string;
  label: string;
  rules: Rule[];
}

/** Group by the thing (or group) the schedule writes — the question is "what does X do?". */
function groupByTarget(rules: Rule[], names: ReturnType<typeof useNames>): Block[] {
  const blocks = new Map<string, Block>();
  for (const rule of rules) {
    const action = rule.then[0];
    const set = action?.set;
    const device = set?.device ?? action?.set_curve?.device;
    const group = set?.group ?? action?.set_curve?.group;
    const key = device ?? group ?? "__unassigned__";
    const label = device
      ? names.device(device)
      : group
        ? `All of ${names.group(group).toLowerCase()}`
        : "Other";
    const block = blocks.get(key) ?? { id: key, label, rules: [] };
    block.rules.push(rule);
    blocks.set(key, block);
  }
  return [...blocks.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export { Stack };
