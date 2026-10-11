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

export function ActivityScreen() {
  const events = useEvents().data ?? [];
  const rules = useRules().data ?? [];
  const [ruleFilter, setRuleFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [window, setWindow] = useState("24h");
  const [showNoise, setShowNoise] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [displayLimit, setDisplayLimit] = useState(100);

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
      <Stack gap={20}>
        <Card variant="filled">
          <Row gap={12} wrap>
            <Select
              value={ruleFilter}
              onChange={setRuleFilter}
              options={[
                { value: "", label: "All schedules" },
                ...rules.map((rule) => ({ value: rule.id, label: rule.name ?? rule.id })),
              ]}
            />
            <Select
              value={outcomeFilter}
              onChange={setOutcomeFilter}
              options={[
                { value: "", label: "Any outcome" },
                { value: "ran", label: "Auto (schedules)" },
                { value: "manual", label: "Manual (you)" },
                { value: "nothing", label: "Unchanged" },
                { value: "skipped", label: "Skipped" },
                { value: "failed", label: "Failed" },
              ]}
            />
            <Select
              value={window}
              onChange={setWindow}
              options={[
                { value: "1h", label: "Past 1 hour" },
                { value: "6h", label: "Past 6 hours" },
                { value: "24h", label: "Past 24 hours" },
                { value: "168h", label: "Past 7 days" },
              ]}
            />
            <Toggle checked={showNoise} onChange={setShowNoise} label="Include telemetry & timers" />
          </Row>
        </Card>

        <Card variant="elevated">
          <Stack gap={0}>
            {runs.slice(0, displayLimit).map((run) => (
              <RunRow
                key={run.id}
                run={run}
                open={open === run.id}
                onToggle={() => setOpen(open === run.id ? null : run.id)}
              />
            ))}
            {runs.length === 0 ? <Empty>No events recorded in this time range.</Empty> : null}
            {runs.length > displayLimit ? (
              <Row justify="center" style={{ paddingTop: "16px" }}>
                <Button variant="tonal" onClick={() => setDisplayLimit((n) => n + 100)}>
                  Show 100 more events ({runs.length - displayLimit} remaining)
                </Button>
              </Row>
            ) : null}
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
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "14px",
        padding: "14px 0",
        borderBottom: "1px solid var(--md-sys-color-outline-variant)",
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontFamily: "Roboto Mono, monospace",
          fontSize: "13px",
          color: "var(--md-sys-color-on-surface-variant)",
          width: "60px",
          flexShrink: 0,
        }}
      >
        {time.stamp(run.ts)}
      </span>
      <div style={{ width: "88px", display: "flex", justifyContent: "flex-start", flexShrink: 0 }}>
        <Badge tone={tone}>{outcomeLabel(run.outcome)}</Badge>
      </div>
      <div style={{ flex: 1, minWidth: "260px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {run.rule ? (
            <Link
              to={`/schedules/${encodeURIComponent(run.rule)}`}
              style={{ fontWeight: 600, color: "var(--md-sys-color-primary)" }}
            >
              {names.rule(run.rule)}
            </Link>
          ) : (
            <strong>{run.outcome === "manual" ? "User Action" : "System Core"}</strong>
          )}
          <span style={{ color: "var(--md-sys-color-on-surface)", fontSize: "14px" }}>
            {summary(run, names)}
          </span>
          <button
            type="button"
            onClick={onToggle}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--md-sys-color-primary)",
              fontWeight: 500,
              fontSize: "13px",
              cursor: "pointer",
              padding: "4px 8px",
              borderRadius: "4px",
            }}
          >
            {open ? "Hide details" : "Details"}
          </button>
        </div>

        {open ? (
          <div
            style={{
              marginTop: "4px",
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "var(--md-sys-color-surface-container)",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              fontSize: "13px",
            }}
          >
            {triggerSentence(run.event, names) ? (
              <Muted>Trigger: {triggerSentence(run.event, names)}</Muted>
            ) : null}
            {run.writes.map((write, index) => (
              <div key={`${write.ts}-${index}`}>
                •{" "}
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
              <Muted key={`${publish.ts}-${index}`}>• Published to MQTT topic {publish.topic}</Muted>
            ))}
            <details>
              <summary style={{ cursor: "pointer", fontSize: "12px", marginTop: "4px" }}>
                Raw telemetry payloads
              </summary>
              <pre
                style={{
                  fontFamily: "Roboto Mono, monospace",
                  fontSize: "11px",
                  maxHeight: "240px",
                  overflowX: "auto",
                  padding: "8px",
                  borderRadius: "8px",
                  backgroundColor: "var(--md-sys-color-surface-container-lowest)",
                }}
              >
                {JSON.stringify([run.event, ...run.writes, ...run.publishes], null, 2)}
              </pre>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function summary(run: Run, names: ReturnType<typeof useNames>): string {
  switch (run.outcome) {
    case "ran":
    case "manual": {
      if (!run.writes.length) return run.publishes.length ? "sent message" : "values already satisfied";
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
          if (
            ["pending", "accepted", "confirmed", "reported", "failed", "unconfirmed"].includes(
              write.status ?? "",
            )
          ) {
            return writeSentence(
              {
                device: write.device ?? "",
                attr: write.attr ?? "",
                value: write.value,
                status: write.status ?? "pending",
                reason: write.reason,
              },
              names,
            );
          }
          if (write.status === "unchanged") return `${thing}${label} already ${value}`;
          if (write.status === "dry-run")
            return switchy
              ? `would set ${thing} ${value} (dry run)`
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
      return "one-shot schedule deleted after execution";
    case "conflict":
      return "priority arbitration between concurrent schedules";
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
