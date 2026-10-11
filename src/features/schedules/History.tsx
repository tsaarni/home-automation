import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";
import { useNames, useTime } from "@/api/queries";
import { Badge, Muted, Row } from "@/components/primitives";
import { outcomeLabel } from "@/lib/reasons";
import type { Run } from "@/lib/runs";
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  row: {
    display: "flex",
    gap: tokens.space2,
    alignItems: "baseline",
    paddingBlock: tokens.space1,
    borderBottomColor: tokens.border,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  time: { fontVariantNumeric: "tabular-nums", minWidth: "46px", color: tokens.textMuted },
});

/** Per-day history for one schedule: "did it run this week?" in one glance (§5.3). */
export function History({ runs, days = 7 }: { runs: Run[]; days?: number }) {
  const time = useTime();
  const names = useNames();

  const grouped = useMemo(() => {
    const buckets = new Map<string, Run[]>();
    for (const run of runs) {
      const day = time.date(run.ts);
      const list = buckets.get(day) ?? [];
      list.push(run);
      buckets.set(day, list);
    }
    return [...buckets.entries()].slice(0, days);
  }, [runs, time, days]);

  if (!grouped.length) return <Muted>no runs in the last {days} days</Muted>;

  return (
    <div>
      {grouped.map(([day, dayRuns]) => (
        <div key={day}>
          <Row gap={2}>
            <strong>{day}</strong>
            <Muted>
              {dayRuns.length} run{dayRuns.length === 1 ? "" : "s"}
            </Muted>
          </Row>
          {dayRuns.map((run) => (
            <div key={run.id} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.time)}>{time.clock(run.ts)}</span>
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
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
