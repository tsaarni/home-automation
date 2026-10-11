import { useMemo, useState } from "react";
import { useDevices, useHome, useNames, useRules, useTime, useTimers } from "@/api/queries";
import { Badge, Button, Card, Empty, Icon, Muted, Row, Stack } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { ThingRow } from "@/components/ThingRow";
import type { RoomView } from "@/home/derive";
import { upcomingItems } from "@/lib/runs";
import { describeTrigger, parseRule } from "@/lib/schedule";
import { matches, useSearchQuery } from "@/lib/search";

export function HomeScreen() {
  const home = useHome();
  const devices = useDevices();
  const query = useSearchQuery();

  const visible = useMemo(
    () =>
      home.rooms
        .map((room) => ({
          ...room,
          things: room.things.filter((thing) => matches(query, thing.name, thing.id, room.name)),
        }))
        .filter((room) => room.things.length > 0),
    [home.rooms, query],
  );

  return (
    <div>
      <StatusHeader />
      <Stack gap={20}>
        {devices.isError ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "12px 16px",
              borderRadius: "12px",
              backgroundColor: "var(--md-sys-color-error-container)",
              color: "var(--md-sys-color-on-error-container)",
              fontWeight: 500,
            }}
          >
            <Icon name="cloud_off" />
            <span>Cannot reach the automator backend. Check port-forward or service status.</span>
          </div>
        ) : null}

        <UpcomingSection />

        {visible.length === 0 ? (
          <Empty>
            {home.rooms.length === 0 ? "Discovering devices from backend…" : `No devices match “${query}”`}
          </Empty>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
            gap: "20px",
          }}
        >
          {visible.map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      </Stack>
    </div>
  );
}

function RoomCard({ room }: { room: RoomView }) {
  const [expanded, setExpanded] = useState(false);
  const interesting = room.things.filter(
    (thing) => thing.controls.length > 0 || thing.primary.some((reading) => reading.known),
  );
  const shown = expanded || interesting.length <= 4 ? room.things : interesting.slice(0, 4);

  return (
    <Card variant="elevated">
      <Stack gap={14}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Icon name="meeting_room" />
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "var(--md-sys-color-on-surface)" }}>
              {room.name}
            </h2>
          </div>
          <Badge tone="muted">
            {room.things.length} device{room.things.length === 1 ? "" : "s"}
          </Badge>
        </div>

        <Stack gap={10}>
          {shown.map((thing) => (
            <ThingRow key={thing.id} thing={thing} />
          ))}
        </Stack>

        {shown.length < room.things.length ? (
          <Row justify="center" style={{ paddingTop: "8px", borderTop: "1px solid var(--md-sys-color-outline-variant)" }}>
            <Button
              size="small"
              variant="text"
              icon="expand_more"
              onClick={() => setExpanded(true)}
            >
              Show {room.things.length - shown.length} more in {room.name.toLowerCase()}
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Card>
  );
}

export function UpcomingSection() {
  const timers = useTimers().data;
  const rules = useRules().data ?? [];
  const names = useNames();
  const time = useTime();

  const items = useMemo(
    () => upcomingItems(timers?.timers ?? [], timers?.next_due ?? {}, rules),
    [timers, rules],
  );

  if (!items.length) return null;

  return (
    <Card variant="filled">
      <Stack gap={12}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Row gap={8}>
            <Icon name="schedule" />
            <strong style={{ fontSize: "16px" }}>Upcoming & Overrides</strong>
          </Row>
          <Badge tone="accent">{items.length} queued</Badge>
        </div>

        <Stack gap={8}>
          {items.map((item) => (
            <div
              key={`${item.kind}-${item.ts}-${item.kind === "schedule" ? item.rule.id : item.timer.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "8px 0",
                borderBottom: "1px solid var(--md-sys-color-outline-variant)",
              }}
            >
              <span
                style={{
                  fontFamily: "Roboto Mono, monospace",
                  fontWeight: 700,
                  fontSize: "13px",
                  minWidth: "52px",
                  color: "var(--md-sys-color-primary)",
                }}
              >
                {time.clock(item.ts)}
              </span>

              {item.kind === "revert" ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flex: 1, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "14px" }}>
                    {names.device(item.timer.device)} reverts to{" "}
                    <strong>{names.value(item.timer.device, item.timer.attr, item.timer.value)}</strong>
                  </span>
                  <Badge tone="warn">{time.rel(item.ts)}</Badge>
                </div>
              ) : item.kind === "for" ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flex: 1, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "14px" }}>
                    {names.rule(item.timer.rule)} acts if condition continues to hold
                  </span>
                  <Badge tone="accent">{time.rel(item.ts)}</Badge>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flex: 1, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "14px" }}>
                    <strong>{item.rule.name ?? item.rule.id}</strong>
                    <Muted>{describeTriggerFor(item.rule, names)}</Muted>
                  </div>
                  <Badge tone="muted">{time.rel(item.ts)}</Badge>
                </div>
              )}
            </div>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}

function describeTriggerFor(
  rule: Parameters<typeof parseRule>[0],
  names: Parameters<typeof describeTrigger>[1],
): string {
  const parsed = parseRule(rule);
  return parsed.ok ? describeTrigger(parsed.schedule.when, names) : "custom schedule";
}
