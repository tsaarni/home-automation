import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useEvents, useNames, useRules, useTime } from "@/api/queries";
import { Badge, Button, Card, Empty, Muted, Row, Select, Stack, Toggle } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { UpcomingSection } from "@/features/home/HomeScreen";
import {
  humanizeWords,
  isSwitchValue,
  outcomeLabel,
  skipSentence,
  triggerSentence,
  writeSentence,
} from "@/lib/reasons";
import { buildRuns, type Run } from "@/lib/runs";
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  row: {
    display: "flex",
    gap: tokens.space3,
    alignItems: "baseline",
    paddingBlock: tokens.space2,
    borderBottomColor: tokens.border,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  time: { fontVariantNumeric: "tabular-nums", color: tokens.textMuted, minWidth: "72px" },
  body: { flexGrow: 1, minWidth: 0 },
  pre: { overflowX: "auto", fontSize: 12, maxHeight: "260px" },
});

/** What happened, and what is about to happen (§5.3). */
export function ActivityScreen() {
  const events = useEvents().data ?? [];
  const rules = useRules().data ?? [];
  const [ruleFilter, setRuleFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [window, setWindow] = useState("24h");
  const [showNoise, setShowNoise] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const allRuns = useMemo(() => buildRuns(events), [events]);

  const runs = useMemo(() => {
    const hours = window === "1h" ? 1 : window === "6h" ? 6 : window === "24h" ? 24 : 168;
    const since = Date.now() - hours * 3600 * 1000;
    return allRuns.filter((run) => {
      if (new Date(run.ts).getTime() < since) return false;
      if (ruleFilter && run.rule !== ruleFilter) return false;
      if (outcomeFilter && run.outcome !== outcomeFilter) return false;
      if (!showNoise && (run.outcome === "reading" || run.outcome === "system" || run.outcome === "pending"))
        return false;
      return true;
    });
  }, [allRuns, window, ruleFilter, outcomeFilter, showNoise]);

  return (
    <div>
      <StatusHeader />
      <Stack gap={4}>
        <Card>
          <Row gap={2} wrap>
            <Select
              value={ruleFilter}
              onChange={setRuleFilter}
              options={[
                { value: "", label: "every schedule" },
                ...rules.map((rule) => ({ value: rule.id, label: rule.name ?? rule.id })),
              ]}
            />
            <Select
              value={outcomeFilter}
              onChange={setOutcomeFilter}
              options={[
                { value: "", label: "any outcome" },
                { value: "ran", label: "ran" },
                { value: "nothing", label: "nothing to do" },
                { value: "skipped", label: "skipped" },
                { value: "failed", label: "failed" },
                { value: "manual", label: "manual" },
              ]}
            />
            <Select
              value={window}
              onChange={setWindow}
              options={[
                { value: "1h", label: "last hour" },
                { value: "6h", label: "last 6 hours" },
                { value: "24h", label: "last 24 hours" },
                { value: "168h", label: "last 7 days" },
              ]}
            />
            <Toggle checked={showNoise} onChange={setShowNoise} label="readings & timers" />
          </Row>
        </Card>

        <Card>
          <Stack gap={1}>
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                open={open === run.id}
                onToggle={() => setOpen(open === run.id ? null : run.id)}
              />
            ))}
            {runs.length === 0 ? <Empty>nothing happened in this window</Empty> : null}
          </Stack>
        </Card>

        <UpcomingSection />
      </Stack>
    </div>
  );
}

function RunRow({ run, open, onToggle }: { run: Run; open: boolean; onToggle: () => void }) {
  const names = useNames();
  const time = useTime();
  const tone =
    run.outcome === "ran"
      ? "ok"
      : run.outcome === "failed"
        ? "bad"
        : run.outcome === "reading"
          ? "muted"
          : "warn";

  return (
    <div {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.time)}>{time.stamp(run.ts)}</span>
      <Badge tone={tone}>{outcomeLabel(run.outcome)}</Badge>
      <div {...stylex.props(styles.body)}>
        <Row gap={2} wrap>
          {run.rule ? (
            <Link to={`/schedules/${encodeURIComponent(run.rule)}`} style={{ fontWeight: 600 }}>
              {names.rule(run.rule)}
            </Link>
          ) : (
            <strong>{run.outcome === "manual" ? "You" : "System"}</strong>
          )}
          <span>{summary(run, names)}</span>
          <Button size="small" variant="ghost" onClick={onToggle} title="details">
            {open ? "hide" : "details"}
          </Button>
        </Row>
        {open ? (
          <Stack gap={2} style={{ marginTop: 8 }}>
            {triggerSentence(run.event, names) ? (
              <Muted>triggered by {triggerSentence(run.event, names)}</Muted>
            ) : null}
            {run.writes.map((write, index) => (
              <div key={`${write.ts}-${index}`}>
                ·{" "}
                {writeSentence(
                  {
                    device: write.device ?? "",
                    attr: write.attr ?? "",
                    status: write.status ?? "applied",
                    reason: write.reason,
                    value: write.value,
                    previous: write.previous,
                  },
                  names,
                )}
              </div>
            ))}
            {run.publishes.map((publish, index) => (
              <Muted key={`${publish.ts}-${index}`}>· sent a message to {publish.topic}</Muted>
            ))}
            <details>
              <summary>raw events</summary>
              <pre {...stylex.props(styles.pre)}>
                {JSON.stringify([run.event, ...run.writes, ...run.publishes], null, 2)}
              </pre>
            </details>
          </Stack>
        ) : null}
      </div>
    </div>
  );
}

function summary(run: Run, names: ReturnType<typeof useNames>): string {
  switch (run.outcome) {
    case "ran":
    case "manual": {
      if (!run.writes.length)
        return run.publishes.length ? "sent a message" : "nothing to do — the values were already right";
      return run.writes
        .map((write) => {
          const thing = names.device(write.device);
          const value = names.value(write.device, write.attr, write.value);
          const switchy = isSwitchValue(write.value);
          const label = switchy ? "" : ` ${names.attr(write.device ?? "", write.attr ?? "").toLowerCase()}`;
          const was =
            write.previous === null || write.previous === undefined
              ? ""
              : ` (was ${names.value(write.device, write.attr, write.previous)})`;
          if (write.status === "unchanged") return `${thing}${label} already ${value}`;
          if (write.status === "dry-run")
            return switchy
              ? `would turn ${thing} ${value} (dry run)`
              : `would set ${thing}${label} to ${value} (dry run)`;
          return `${thing}${label} → ${value}${was}`;
        })
        .join(", ");
    }
    case "skipped":
      return skipSentence(run.event);
    case "failed":
      return `${humanizeWords(run.error ?? "failed")}`;
    case "nothing":
      return "nothing to do";
    case "consumed":
      return "one-shot schedule deleted after running";
    case "conflict":
      return "two schedules wanted the same value; one won by priority";
    case "reading":
      return `${names.device(run.event.device)} ${names.attr(run.event.device ?? "", run.event.attr ?? "").toLowerCase()} = ${names.value(run.event.device, run.event.attr, run.event.value)}`;
    case "pending":
      return run.event.kind === "revert"
        ? `override on ${names.device(run.event.device)} ${humanizeWords(String(run.event.status))}`
        : `${humanizeWords(String(run.event.status))} — waiting on ${names.rule(run.event.rule)}`;
    case "problem":
      return humanizeWords(run.event.error ?? run.event.type);
    default:
      return humanizeWords(run.event.type);
  }
}
