import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
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
import { outcomeLabel, writeSentence } from "@/lib/reasons";
import { buildRuns, latestWrites } from "@/lib/runs";
import { describeSchedule, describeTestReport, parseRule, unrepresentable } from "@/lib/schedule";
import { ScheduleBuilder } from "./ScheduleBuilder";

export function ScheduleDetailScreen() {
  const { id = "" } = useParams();
  const rulesQuery = useRules();
  const rules = rulesQuery.data ?? [];
  const navigate = useNavigate();
  const rule = rules.find((item) => item.id === id);
  const timers = useTimers().data;
  const events = useEvents().data ?? [];
  const names = useNames();
  const time = useTime();
  const toggle = useToggleRule();
  const remove = useDeleteRule();
  const test = useTestRule();
  const [editing, setEditing] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [confirming, setConfirming] = useState(false);

  const runs = useMemo(() => buildRuns(events).filter((run) => run.rule === id), [events, id]);
  const parsed = rule ? parseRule(rule) : null;

  if (!rule) {
    return (
      <div>
        <StatusHeader />
        <Stack gap={16}>
          <Empty>
            {rulesQuery.isPending
              ? "Loading schedule…"
              : rulesQuery.isError
                ? "Schedule could not be loaded."
                : "This schedule does not exist or has been deleted."}
            {rulesQuery.isError && <Button onClick={() => rulesQuery.refetch()}>Retry</Button>}
          </Empty>
          <Link className="text-link" to="/schedules">
            Back to schedules
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
      <StatusHeader title={names.rule(rule.id)} />
      <Stack gap={20}>
        <Row>
          <Link className="text-link" to="/schedules">
            All schedules
          </Link>
        </Row>

        <Card variant="elevated">
          <Stack gap={16}>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--md-sys-color-on-surface)" }}>
              {parsed?.ok ? describeSchedule(parsed.schedule, names).sentence : names.rule(rule.id)}
            </div>
            <Row gap={12} wrap>
              <Switch
                checked={rule.enabled}
                label={`${rule.enabled ? "Disable" : "Enable"} this schedule`}
                disabled={toggle.isPending}
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
                <Badge tone="muted">
                  {!rule.enabled
                    ? "Disabled"
                    : rule.when.device
                      ? "Waiting for device updates"
                      : "Next execution unavailable"}
                </Badge>
              )}
            </Row>

            {rule.description ? <Muted>{rule.description}</Muted> : null}
            {reasons.length > 0 ? (
              <Badge tone="warn">
                This schedule uses {reasons.join(", ")}. Edit its advanced configuration.
              </Badge>
            ) : null}

            <Row gap={12} wrap>
              <Button
                variant="filled"
                icon="edit"
                onClick={() => {
                  if (reasons.length) navigate(`/advanced?tab=schedules&rule=${encodeURIComponent(rule.id)}`);
                  else setEditing(true);
                }}
              >
                {reasons.length ? "Edit advanced configuration" : "Edit schedule"}
              </Button>
              <Button
                variant="tonal"
                icon="play_arrow"
                onClick={() => test.mutate(rule.id)}
                disabled={test.isPending}
                title="Evaluate conditions and plan writes without applying them"
              >
                Simulate saved schedule
              </Button>
              <Button variant="text" icon="delete" onClick={() => setConfirming(true)}>
                Delete schedule
              </Button>
            </Row>

            <Muted>Simulation evaluates the saved schedule. No device changes.</Muted>
            {test.data ? (
              <Row gap={12} wrap>
                <Badge tone={test.data.writes.length ? "accent" : "muted"}>Simulation Result</Badge>
                <span>{describeTestReport(test.data, names)}</span>
              </Row>
            ) : null}
            {test.error ? <Muted>{String(test.error)}</Muted> : null}
          </Stack>
        </Card>

        {pending.length > 0 ? (
          <Card variant="filled">
            <Stack gap={12}>
              <strong>Pending actions</strong>
              {pending.map((timer) => (
                <Row key={timer.id} gap={12} wrap>
                  <Badge tone="warn">{timer.kind === "revert" ? "Override" : "Hold"}</Badge>
                  <span>
                    {timer.kind === "revert"
                      ? `${names.device(timer.device)} ${names.attr(timer.device ?? "", timer.attr ?? "").toLowerCase()} goes back to ${names.value(timer.device, timer.attr, timer.value)}`
                      : "Waiting before running; conditions will be checked"}
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
          <Stack gap={12}>
            <strong>Recent history</strong>
            <Muted>
              Showing {Math.min(historyLimit, runs.length)} of {runs.length} executions in the available log.
              Older events may have expired.
            </Muted>
            {runs.slice(0, historyLimit).map((run) => (
              <div key={run.id}>
                {(runs.indexOf(run) === 0 ||
                  time.date(run.ts) !== time.date(runs[runs.indexOf(run) - 1].ts)) && (
                  <h3 style={{ fontSize: 14 }}>{time.date(run.ts)}</h3>
                )}
                <Row gap={12} wrap>
                  <Muted>{time.clock(run.ts)}</Muted>
                  <Badge tone={run.outcome === "ran" ? "ok" : run.outcome === "failed" ? "bad" : "warn"}>
                    {outcomeLabel(run.outcome)}
                  </Badge>
                  <span>
                    {run.writes.length
                      ? latestWrites(run.writes)
                          .map((w) =>
                            writeSentence(
                              {
                                device: w.device ?? "",
                                attr: w.attr ?? "",
                                value: w.value,
                                status: w.status ?? "applied",
                                source: w.source,
                                reason: w.reason,
                              },
                              names,
                            ),
                          )
                          .join("; ")
                      : (run.error ?? run.reason ?? "nothing to do")}
                  </span>
                </Row>
              </div>
            ))}
            {runs.length > historyLimit && (
              <Button variant="text" onClick={() => setHistoryLimit((n) => n + 20)}>
                Load more history
              </Button>
            )}
            {runs.length === 0 ? <Muted>No runs recorded in current log window.</Muted> : null}
          </Stack>
        </Card>

        <Card variant="filled">
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 500 }}>Configuration</summary>
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
          beforeClose={() => !remove.isPending}
          onClose={() => {
            if (!remove.isPending) setConfirming(false);
          }}
          footer={
            <>
              <Button variant="text" disabled={remove.isPending} onClick={() => setConfirming(false)}>
                Keep Schedule
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                icon="delete"
                onClick={() => {
                  remove.mutate(rule.id, {
                    onSuccess: () => {
                      setConfirming(false);
                      navigate("/schedules");
                    },
                  });
                }}
              >
                Delete Permanently
              </Button>
            </>
          }
        >
          {remove.error && (
            <p role="alert" className="form-error">
              Could not delete: {remove.error.message}
            </p>
          )}
          <div>{names.rule(rule.id)}</div>
          <Muted>
            {nextDue ? `Next scheduled execution was ${time.stamp(nextDue)}` : "Schedule is currently idle"}
          </Muted>
          {rule.once ? <Muted>This is a one-shot schedule that deletes itself on run.</Muted> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
