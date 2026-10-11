import { useMemo } from "react";
import { useNames, useTime } from "@/api/queries";
import { Badge, Muted, Stack } from "@/components/primitives";
import { outcomeLabel } from "@/lib/reasons";
import type { Run } from "@/lib/runs";

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

  if (!grouped.length) return <Muted>No runs recorded in the last {days} days.</Muted>;

  return (
    <Stack gap={12}>
      {grouped.map(([day, dayRuns]) => (
        <div
          key={day}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "10px",
            backgroundColor: "var(--md-sys-color-surface-container)",
            borderRadius: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <strong>{day}</strong>
            <Badge tone="muted">
              {dayRuns.length} run{dayRuns.length === 1 ? "" : "s"}
            </Badge>
          </div>
          <Stack gap={4}>
            {dayRuns.map((run) => (
              <div
                key={run.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "13px",
                  padding: "4px 0",
                  borderBottom: "1px solid var(--md-sys-color-outline-variant)",
                }}
              >
                <span
                  style={{
                    fontFamily: "Roboto Mono, monospace",
                    color: "var(--md-sys-color-on-surface-variant)",
                    minWidth: "46px",
                  }}
                >
                  {time.clock(run.ts)}
                </span>
                <Badge tone={run.outcome === "ran" ? "ok" : run.outcome === "failed" ? "bad" : "warn"}>
                  {outcomeLabel(run.outcome)}
                </Badge>
                <span style={{ color: "var(--md-sys-color-on-surface)" }}>
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
          </Stack>
        </div>
      ))}
    </Stack>
  );
}
