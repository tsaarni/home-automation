import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useEvents, useHome, useNames, useRules, useTime, useTimers, useToggleRule } from "@/api/queries";
import type { Rule } from "@/api/types";
import { Badge, Button, Card, Empty, Icon, Muted, Row, Select, Stack, Switch } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { outcomeLabel } from "@/lib/reasons";
import { buildRuns, lastRunPerRule } from "@/lib/runs";
import { describeSchedule, parseRule } from "@/lib/schedule";
import { clearSearch, matches, useSearchQuery } from "@/lib/search";
import { ScheduleBuilder } from "./ScheduleBuilder";

export function ScheduleListScreen() {
  const rulesQuery = useRules();
  const rules = rulesQuery.data ?? [];
  const timers = useTimers().data;
  const events = useEvents().data ?? [];
  const names = useNames();
  const time = useTime();
  const home = useHome();
  const navigate = useNavigate();
  const toggle = useToggleRule();
  const query = useSearchQuery();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const setStatus = (v: string) =>
    setParams((p) => {
      p.set("status", v);
      return p;
    });
  const [building, setBuilding] = useState<Rule | null | undefined>(undefined);

  const runs = useMemo(() => buildRuns(events), [events]);
  const lastRuns = useMemo(() => lastRunPerRule(runs), [runs]);

  const visible = rules.filter(
    (rule) =>
      (status === "all" || (status === "enabled" ? rule.enabled : !rule.enabled)) &&
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
      <Stack gap={20}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <Row gap={8} wrap>
            <Select
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "All schedules" },
                { value: "enabled", label: "Enabled" },
                { value: "disabled", label: "Disabled" },
              ]}
            />
            <Muted>{visible.length} schedules</Muted>
          </Row>
          <Button variant="filled" icon="add" onClick={() => setBuilding(null)}>
            New schedule
          </Button>
        </div>

        {rulesQuery.isPending ? (
          <Empty>Loading schedules…</Empty>
        ) : rulesQuery.isError ? (
          <Empty>
            Schedules could not be refreshed. <Button onClick={() => rulesQuery.refetch()}>Retry</Button>
          </Empty>
        ) : visible.length === 0 ? (
          <Empty>
            {rules.length ? "No schedules match your filters." : "No schedules yet."}
            <Button
              variant="text"
              onClick={() => {
                clearSearch();
                setStatus("all");
              }}
            >
              Clear filters
            </Button>
          </Empty>
        ) : null}

        {blocks.map((block) => {
          const blockRules = block.rules;
          return (
            <Card key={block.id} variant="elevated">
              <Stack gap={14}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Icon name="device_hub" />
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "17px",
                        fontWeight: 700,
                        color: "var(--md-sys-color-on-surface)",
                      }}
                    >
                      {block.label}
                    </h3>
                  </div>
                  <Badge tone="muted">
                    {blockRules.length} schedule{blockRules.length === 1 ? "" : "s"}
                  </Badge>
                </div>

                <Stack gap={10}>
                  {blockRules.map((rule) => {
                    const parsed = parseRule(rule);
                    const description = parsed.ok ? describeSchedule(parsed.schedule, names) : null;
                    const nextDue = timers?.next_due?.[rule.id];
                    const last = lastRuns.get(rule.id);
                    return (
                      <div
                        key={rule.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "14px",
                          padding: "10px 14px",
                          backgroundColor: "var(--md-sys-color-surface-container)",
                          borderRadius: "12px",
                          border: "1px solid var(--md-sys-color-outline-variant)",
                          flexWrap: "wrap",
                          opacity: !rule.enabled ? 0.6 : 1,
                        }}
                      >
                        <div
                          style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, minWidth: 0 }}
                        >
                          <Switch
                            checked={rule.enabled}
                            label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name ?? rule.id}`}
                            disabled={toggle.isPending}
                            onChange={(next) => toggle.mutate({ id: rule.id, enabled: next })}
                          />
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <Link
                              to={`/schedules/${encodeURIComponent(rule.id)}`}
                              style={{
                                fontWeight: 600,
                                fontSize: "14px",
                                color: "var(--md-sys-color-on-surface)",
                              }}
                            >
                              {rule.name ?? rule.id}
                            </Link>
                            {description && <Muted>{description.sentence}</Muted>}
                            <Row gap={6} wrap>
                              {rule.once ? <Badge tone="accent">one-shot</Badge> : null}
                              {!parsed.ok ? <Badge tone="warn">raw JSON</Badge> : null}
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
                                  Last: {outcomeLabel(last.outcome)} {time.stamp(last.ts)}
                                </Badge>
                              ) : (
                                <Badge tone="muted">No recent run</Badge>
                              )}
                              {nextDue ? (
                                <Badge tone="muted">
                                  Next {time.stamp(nextDue)} ({time.rel(nextDue)})
                                </Badge>
                              ) : null}
                            </Row>
                          </div>
                        </div>

                        <Row gap={6}>
                          <Button
                            size="small"
                            variant="tonal"
                            icon="edit"
                            onClick={() => {
                              if (parseRule(rule).ok) setBuilding(rule);
                              else navigate(`/advanced?tab=schedules&rule=${encodeURIComponent(rule.id)}`);
                            }}
                          >
                            Edit
                          </Button>
                        </Row>
                      </div>
                    );
                  })}
                </Stack>

                {block.id === "__unassigned__" && home.things.length ? (
                  <Muted>These schedules do not target an active recognized device.</Muted>
                ) : null}
              </Stack>
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

function groupByTarget(rules: Rule[], names: ReturnType<typeof useNames>): Block[] {
  const blocks = new Map<string, Block>();
  for (const rule of rules) {
    const action = rule.then[0];
    const set = action?.set;
    const device = set?.device ?? action?.set_curve?.device;
    const group = set?.group ?? action?.set_curve?.group;
    const multiple =
      new Set(
        rule.then
          .map((a) => a.set?.device ?? a.set?.group ?? a.set_curve?.device ?? a.set_curve?.group)
          .filter(Boolean),
      ).size > 1;
    const key = multiple ? "__multiple__" : (device ?? group ?? "__unassigned__");
    const label = multiple
      ? "Multiple devices"
      : device
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
