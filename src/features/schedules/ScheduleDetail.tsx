import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  useDeleteRule,
  useEvents,
  useNames,
  useRules,
  useTestRule,
  useTime,
  useTimers,
  useToggleRule,
} from "@/api/queries";
import type { Rule } from "@/api/types";
import { Badge, Button, Card, Dialog, Empty, Muted, Row, Stack, Switch } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { outcomeLabel } from "@/lib/reasons";
import { buildRuns } from "@/lib/runs";
import { describeSchedule, describeTestReport, parseRule, unrepresentable } from "@/lib/schedule";
import { tokens } from "@/theme/tokens.stylex";
import { History } from "./History";
import { ScheduleBuilder } from "./ScheduleBuilder";

const styles = stylex.create({
  sentence: { fontSize: tokens.fontXl, fontWeight: 600, lineHeight: 1.3 },
  pre: {
    overflowX: "auto",
    fontSize: 12,
    backgroundColor: tokens.surfaceRaised,
    padding: tokens.space3,
    borderRadius: tokens.radiusSm,
  },
});

/** One schedule: the sentence, what it will do next, and what it has done (§5.2). */
export function ScheduleDetailScreen() {
  const { id = "" } = useParams();
  const rules = useRules().data ?? [];
  const rule = rules.find((item) => item.id === id);
  const timers = useTimers().data;
  const events = useEvents().data ?? [];
  const names = useNames();
  const time = useTime();
  const toggle = useToggleRule();
  const remove = useDeleteRule();
  const test = useTestRule();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const runs = useMemo(() => buildRuns(events).filter((run) => run.rule === id), [events, id]);
  const parsed = rule ? parseRule(rule) : null;

  if (!rule) {
    return (
      <div>
        <StatusHeader />
        <Stack gap={3}>
          <Empty>that schedule no longer exists</Empty>
          <Link to="/schedules">
            <Button>back to schedules</Button>
          </Link>
        </Stack>
      </div>
    );
  }

  const nextDue = timers?.next_due?.[rule.id];
  const pending = timers?.timers.filter((timer) => timer.rule === rule.id) ?? [];
  const reasons = unrepresentable(rule);

  return (
    <div>
      <StatusHeader />
      <Stack gap={4}>
        <Row>
          <Link to="/schedules">
            <Button size="small" variant="ghost">
              ← schedules
            </Button>
          </Link>
        </Row>

        <Card>
          <Stack gap={3}>
            <div {...stylex.props(styles.sentence)}>
              {parsed?.ok ? describeSchedule(parsed.schedule, names).sentence : (rule.name ?? rule.id)}
            </div>
            <Row gap={2} wrap>
              <Switch
                checked={rule.enabled}
                label={`${rule.enabled ? "disable" : "enable"} this schedule`}
                onChange={(next) => toggle.mutate({ id: rule.id, enabled: next })}
              />
              <Muted>{rule.enabled ? "enabled" : "disabled"}</Muted>
              {rule.once ? <Badge tone="accent">one-shot</Badge> : null}
              <Badge tone="muted">
                {rule.when.at ? "time & sun" : rule.when.every ? "interval" : "reaction"}
              </Badge>
              {rule.priority ? <Badge tone="muted">priority {rule.priority}</Badge> : null}
              {nextDue ? (
                <Badge tone="ok">
                  next {time.stamp(nextDue)} ({time.rel(nextDue)})
                </Badge>
              ) : (
                <Badge tone="muted">not armed</Badge>
              )}
            </Row>
            {rule.description ? <Muted>{rule.description}</Muted> : null}
            {reasons.length ? (
              <Badge tone="warn">the builder cannot show {reasons.join(", ")} — edit as raw JSON</Badge>
            ) : null}
            <Row gap={2} wrap>
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <Button
                onClick={() => test.mutate(rule.id)}
                disabled={test.isPending}
                title="run the conditions and plan without touching anything"
              >
                Test now
              </Button>
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            </Row>
            {test.data ? (
              <Row gap={2} wrap>
                <Badge tone={test.data.writes.length ? "accent" : "muted"}>test</Badge>
                <span>{describeTestReport(test.data, names)}</span>
              </Row>
            ) : null}
            {test.error ? <Muted>{String(test.error)}</Muted> : null}
          </Stack>
        </Card>

        {pending.length ? (
          <Card>
            <Stack gap={2}>
              <strong>Waiting</strong>
              {pending.map((timer) => (
                <Row key={timer.id} gap={2} wrap>
                  <Badge tone="warn">{timer.kind === "revert" ? "override" : "hold"}</Badge>
                  <span>
                    {timer.kind === "revert"
                      ? `${names.device(timer.device)} ${names.attr(timer.device ?? "", timer.attr ?? "").toLowerCase()} goes back to ${names.value(timer.device, timer.attr, timer.value)}`
                      : "the conditions are holding; it will act when they have held long enough"}
                  </span>
                  <Muted>
                    at {time.stamp(timer.due_at ?? "")} ({time.rel(timer.due_at)})
                  </Muted>
                </Row>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card>
          <Stack gap={3}>
            <strong>This week</strong>
            <History runs={runs} />
          </Stack>
        </Card>

        <Card>
          <Stack gap={2}>
            <strong>Recent runs</strong>
            {runs.slice(0, 20).map((run) => (
              <div key={run.id}>
                <Row gap={2} wrap>
                  <Muted>{time.stamp(run.ts)}</Muted>
                  <Badge tone={run.outcome === "ran" ? "ok" : run.outcome === "failed" ? "bad" : "warn"}>
                    {outcomeLabel(run.outcome)}
                  </Badge>
                  <span>
                    {run.writes.length
                      ? run.writes
                          .map(
                            (write) =>
                              `${names.device(write.device)} ${names.attr(write.device ?? "", write.attr ?? "").toLowerCase()} → ${names.value(write.device, write.attr, write.value)}`,
                          )
                          .join(", ")
                      : (run.error ?? run.reason ?? "nothing to do")}
                  </span>
                </Row>
              </div>
            ))}
            {runs.length === 0 ? <Muted>no runs in the event window</Muted> : null}
          </Stack>
        </Card>

        <Card>
          <details>
            <summary>raw document</summary>
            <pre {...stylex.props(styles.pre)}>{JSON.stringify(rule, null, 2)}</pre>
          </details>
        </Card>
      </Stack>

      {editing ? <ScheduleBuilder rule={rule as Rule} onClose={() => setEditing(false)} /> : null}
      {confirming ? (
        <Dialog
          title="Delete this schedule?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                keep it
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  remove.mutate(rule.id);
                  setConfirming(false);
                }}
              >
                delete
              </Button>
            </>
          }
        >
          <div>{rule.name ?? rule.id}</div>
          <Muted>{nextDue ? `it would have run next ${time.stamp(nextDue)}` : "it is not armed"}</Muted>
          {rule.once ? <Muted>it is a one-shot schedule and would delete itself after running</Muted> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
