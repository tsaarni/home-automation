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
import { History } from "./History";
import { ScheduleBuilder } from "./ScheduleBuilder";

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
          <Empty>This schedule does not exist or has been deleted.</Empty>
          <Link to="/schedules">
            <Button variant="tonal" icon="arrow_back">
              Back to schedules
            </Button>
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
            <Button size="small" variant="text" icon="arrow_back">
              All schedules
            </Button>
          </Link>
        </Row>

        <Card variant="elevated">
          <Stack gap={3}>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--md-sys-color-on-surface)" }}>
              {parsed?.ok ? describeSchedule(parsed.schedule, names).sentence : (rule.name ?? rule.id)}
            </div>
            <Row gap={2} wrap>
              <Switch
                checked={rule.enabled}
                label={`${rule.enabled ? "Disable" : "Enable"} this schedule`}
                onChange={(next) => toggle.mutate({ id: rule.id, enabled: next })}
              />
              <Muted>{rule.enabled ? "Enabled" : "Disabled"}</Muted>
              {rule.once ? <Badge tone="accent">one-shot</Badge> : null}
              <Badge tone="muted">
                {rule.when.at ? "Time & Solar" : rule.when.every ? "Interval" : "Event Reaction"}
              </Badge>
              {rule.priority ? <Badge tone="muted">Priority {rule.priority}</Badge> : null}
              {nextDue ? (
                <Badge tone="ok">
                  Next execution: {time.stamp(nextDue)} ({time.rel(nextDue)})
                </Badge>
              ) : (
                <Badge tone="muted">Not armed</Badge>
              )}
            </Row>

            {rule.description ? <Muted>{rule.description}</Muted> : null}
            {reasons.length > 0 ? (
              <Badge tone="warn">Visual builder cannot show {reasons.join(", ")} — edit as raw JSON.</Badge>
            ) : null}

            <Row gap={2} wrap>
              <Button variant="filled" icon="edit" onClick={() => setEditing(true)}>
                Edit Schedule
              </Button>
              <Button
                variant="tonal"
                icon="play_arrow"
                onClick={() => test.mutate(rule.id)}
                disabled={test.isPending}
                title="Evaluate conditions and plan writes without applying them"
              >
                Test Now
              </Button>
              <Button variant="danger" icon="delete" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            </Row>

            {test.data ? (
              <Row gap={2} wrap>
                <Badge tone={test.data.writes.length ? "accent" : "muted"}>Simulation Result</Badge>
                <span>{describeTestReport(test.data, names)}</span>
              </Row>
            ) : null}
            {test.error ? <Muted>{String(test.error)}</Muted> : null}
          </Stack>
        </Card>

        {pending.length > 0 ? (
          <Card variant="filled">
            <Stack gap={2}>
              <strong>Pending Condition Holds</strong>
              {pending.map((timer) => (
                <Row key={timer.id} gap={2} wrap>
                  <Badge tone="warn">{timer.kind === "revert" ? "Override" : "Hold"}</Badge>
                  <span>
                    {timer.kind === "revert"
                      ? `${names.device(timer.device)} ${names.attr(timer.device ?? "", timer.attr ?? "").toLowerCase()} goes back to ${names.value(timer.device, timer.attr, timer.value)}`
                      : "Condition is holding; will act when hold duration completes"}
                  </span>
                  <Muted>
                    at {time.stamp(timer.due_at ?? "")} ({time.rel(timer.due_at)})
                  </Muted>
                </Row>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card variant="outlined">
          <Stack gap={3}>
            <strong>Weekly Execution History</strong>
            <History runs={runs} />
          </Stack>
        </Card>

        <Card variant="outlined">
          <Stack gap={2}>
            <strong>Recent Executions</strong>
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
            {runs.length === 0 ? <Muted>No runs recorded in current log window.</Muted> : null}
          </Stack>
        </Card>

        <Card variant="filled">
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 500 }}>Inspect Raw JSON Document</summary>
            <pre style={{ overflowX: "auto", fontSize: 12, marginTop: 8 }}>
              {JSON.stringify(rule, null, 2)}
            </pre>
          </details>
        </Card>
      </Stack>

      {editing ? <ScheduleBuilder rule={rule as Rule} onClose={() => setEditing(false)} /> : null}

      {confirming ? (
        <Dialog
          title="Delete Schedule?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="text" onClick={() => setConfirming(false)}>
                Keep Schedule
              </Button>
              <Button
                variant="danger"
                icon="delete"
                onClick={() => {
                  remove.mutate(rule.id);
                  setConfirming(false);
                }}
              >
                Delete Permanently
              </Button>
            </>
          }
        >
          <div>{rule.name ?? rule.id}</div>
          <Muted>{nextDue ? `Next scheduled execution was ${time.stamp(nextDue)}` : "Schedule is currently idle"}</Muted>
          {rule.once ? <Muted>This is a one-shot schedule that deletes itself on run.</Muted> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
