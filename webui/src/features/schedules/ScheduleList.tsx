import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  useDevices,
  useEvents,
  useGroups,
  useHome,
  useNames,
  useRules,
  useTime,
  useTimers,
  useToggleRule,
} from "@/api/queries";
import type { Rule } from "@/api/types";
import { Badge, Button, Card, Empty, Icon, Muted, Row, Select, Stack, Switch } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { outcomeLabel } from "@/lib/reasons";
import { buildRuns, lastRunPerRule } from "@/lib/runs";
import { describeSchedule, parseRule } from "@/lib/schedule";
import { groupByNext, nextTime } from "@/lib/schedule-list";
import { clearSearch, matches, useSearchQuery } from "@/lib/search";
import { ScheduleBuilder } from "./ScheduleBuilder";
import "./ScheduleList.css";

export function ScheduleListScreen() {
  const rulesQuery = useRules();
  const rules = rulesQuery.data ?? [];
  const timersQuery = useTimers();
  const timers = timersQuery.data;
  const events = useEvents().data ?? [];
  const names = useNames();
  const time = useTime();
  const home = useHome();
  const devices = useDevices().data ?? [];
  const groups = useGroups().data ?? [];
  const navigate = useNavigate();
  const toggle = useToggleRule();
  const query = useSearchQuery();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const view = params.get("view") === "device" ? "device" : "next";
  const target = params.get("target") ?? "all";
  const setFilter = (key: string, value: string) =>
    setParams((p) => {
      p.set(key, value);
      return p;
    });
  const restored = useRef(false);
  useEffect(() => {
    try {
      if (!restored.current) {
        restored.current = true;
        const saved = sessionStorage.getItem("schedule-list-filters");
        if (!params.size && saved) {
          setParams(new URLSearchParams(saved), { replace: true });
          return;
        }
      }
      const saved = new URLSearchParams(params);
      saved.delete("new");
      sessionStorage.setItem("schedule-list-filters", saved.toString());
    } catch {
      // Browsing still works when session storage is unavailable.
    }
  }, [params, setParams]);
  const [building, setBuilding] = useState<Rule | null | undefined>(() =>
    params.get("new") === "1" ? null : undefined,
  );

  const runs = useMemo(() => buildRuns(events), [events]);
  const lastRuns = useMemo(() => lastRunPerRule(runs), [runs]);

  const visible = rules.filter(
    (rule) =>
      (target === "all" ||
        rule.then.some((action) => {
          const set = action.set ?? action.set_curve;
          return (
            set &&
            (target === `device:${set.device}` ||
              target === `group:${set.group}` ||
              (target.startsWith("device:") &&
                groups.find((group) => group.id === set.group)?.members.includes(target.slice(7))))
          );
        })) &&
      (status === "all" || (status === "enabled" ? rule.enabled : !rule.enabled)) &&
      matches(
        query,
        rule.name,
        rule.id,
        describeRuleText(rule, names),
        rule.then.map((action) => action.set?.device ?? action.set?.group).join(" "),
      ),
  );

  const blocks =
    view === "device" ? groupByTarget(visible, names) : groupByNext(visible, timers?.next_due ?? {}, time);

  return (
    <div>
      <StatusHeader />
      <Stack gap={20}>
        <Row gap={12} wrap justify="space-between">
          <Muted>{visible.length} schedules</Muted>
          <Row gap={16} wrap>
            <Button variant="filled" icon="add" onClick={() => setBuilding(null)}>
              New schedule
            </Button>
          </Row>
        </Row>
        <div className="schedule-filters" role="group" aria-label="Schedule view and filters">
          <div>
            <Select
              label="View"
              value={view}
              onChange={(value) => setFilter("view", value)}
              options={[
                { value: "next", label: "Next scheduled" },
                { value: "device", label: "By device" },
              ]}
            />
          </div>
          <div>
            <Select
              label="Device or group"
              value={target}
              onChange={(value) => setFilter("target", value)}
              options={[
                { value: "all", label: "All devices and groups" },
                ...devices.map((device) => ({
                  value: `device:${device.id}`,
                  label: names.device(device.id),
                })),
                ...groups.map((group) => ({
                  value: `group:${group.id}`,
                  label: `Group: ${names.group(group.id)}`,
                })),
              ]}
            />
          </div>
          <div>
            <Select
              label="Status"
              value={status}
              onChange={(value) => setFilter("status", value)}
              options={[
                { value: "all", label: "All schedules" },
                { value: "enabled", label: "Enabled" },
                { value: "disabled", label: "Disabled" },
              ]}
            />
          </div>
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
                setParams((p) => {
                  p.set("status", "all");
                  p.set("target", "all");
                  p.delete("q");
                  return p;
                });
              }}
            >
              Clear filters
            </Button>
          </Empty>
        ) : null}

        {timersQuery.isError ? (
          <Muted>
            Next scheduled times could not be refreshed.{" "}
            <Button onClick={() => timersQuery.refetch()}>Retry</Button>
          </Muted>
        ) : null}
        <Muted>Times shown in {time.zone}. Conditions are checked at the scheduled time.</Muted>

        {blocks.map((block) => {
          const blockRules = block.rules;
          return (
            <Card key={block.id} variant="elevated">
              <Stack gap={14}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Icon name={view === "device" ? "device_hub" : "schedule"} />
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
                    const nextDue = nextTime(timers?.next_due?.[rule.id]);
                    const last = lastRuns.get(rule.id);
                    return (
                      <div
                        key={rule.id}
                        className="schedule-row"
                        style={{
                          display: "flex",
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
                            label={`${rule.enabled ? "Disable" : "Enable"} ${names.rule(rule.id)}`}
                            disabled={toggle.isPending}
                            onChange={(next) => toggle.mutate({ id: rule.id, enabled: next })}
                          />
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <strong style={{ color: "var(--md-sys-color-primary)", fontSize: "16px" }}>
                              {!rule.enabled
                                ? "Disabled"
                                : rule.when.device
                                  ? "On change / event"
                                  : nextDue
                                    ? `${time.stamp(nextDue)} · ${time.rel(nextDue)}`
                                    : timersQuery.isPending
                                      ? "Loading next time…"
                                      : "Next time unavailable"}
                            </strong>
                            <Link
                              to={`/schedules/${encodeURIComponent(rule.id)}`}
                              style={{
                                fontWeight: 600,
                                fontSize: "14px",
                                color: "var(--md-sys-color-on-surface)",
                              }}
                            >
                              {names.rule(rule.id)}
                            </Link>
                            {description && rule.name && rule.name !== description.sentence && (
                              <Muted>{description.sentence}</Muted>
                            )}
                            <Row gap={6} wrap>
                              {rule.once ? <Badge tone="accent">one-shot</Badge> : null}
                              {!parsed.ok ? <Badge tone="warn">raw JSON</Badge> : null}
                              {last?.outcome === "failed" ? (
                                <Badge tone="bad">
                                  Last: {outcomeLabel(last.outcome)} {time.stamp(last.ts)}
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
  return parsed.ok ? describeSchedule(parsed.schedule, names).sentence : names.rule(rule.id);
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
