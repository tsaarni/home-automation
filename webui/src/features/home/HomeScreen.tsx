import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { useDevices, useHome, useNames, useRules, useTime, useTimers } from "@/api/queries";
import { Badge, Button, Card, Empty, Icon, Muted, Row, Stack } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { ThingRow } from "@/components/ThingRow";
import type { RoomView } from "@/home/derive";
import { upcomingItems } from "@/lib/runs";
import { describeTrigger, parseRule } from "@/lib/schedule";
import { clearSearch, matches, useSearchQuery } from "@/lib/search";

export function HomeScreen() {
  const home = useHome();
  const devices = useDevices();
  const query = useSearchQuery();
  const { hash } = useLocation();
  const focusedTarget = useRef<string | null>(null);
  let targetId: string | undefined;
  try {
    targetId = decodeURIComponent(hash.slice(1));
  } catch {
    /* Ignore malformed fragments. */
  }
  useEffect(() => {
    if (!targetId) {
      focusedTarget.current = null;
      return;
    }
    if (focusedTarget.current === targetId) return;
    const frame = requestAnimationFrame(() => {
      const device = document.getElementById(targetId);
      if (!device) return;
      device.scrollIntoView({ block: "start" });
      device.focus({ preventScroll: true });
      focusedTarget.current = targetId;
    });
    return () => cancelAnimationFrame(frame);
  }, [targetId, devices.data]);

  const visible = useMemo(
    () =>
      home.rooms
        .map((room) => ({
          ...room,
          things: room.things.filter((thing) =>
            matches(
              query,
              thing.name,
              thing.id,
              room.name,
              ...thing.readings.map((r) => `${r.attr} ${r.label}`),
            ),
          ),
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
            <span>Devices could not be refreshed. Last known values are shown when available.</span>
            <Button variant="tonal" onClick={() => devices.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}

        <UpcomingSection compact />

        <Muted>{visible.reduce((n, r) => n + r.things.length, 0)} devices</Muted>
        {visible.length === 0 ? (
          <Empty>
            {devices.isPending ? (
              "Loading devices…"
            ) : devices.isError ? (
              "Devices could not be loaded."
            ) : home.rooms.length === 0 ? (
              "No devices configured."
            ) : (
              <>
                No devices match “{query}”{" "}
                <Button variant="text" onClick={clearSearch}>
                  Clear filters
                </Button>
              </>
            )}
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
            <RoomCard key={room.id} room={room} searching={Boolean(query.trim())} targetId={targetId} />
          ))}
        </div>
      </Stack>
    </div>
  );
}

export function RoomCard({
  room,
  searching = false,
  targetId,
}: {
  room: RoomView;
  searching?: boolean;
  targetId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const targeted = room.things.some((thing, i) => i >= 4 && `device-${thing.id}` === targetId);
  useEffect(() => {
    if (targeted) setExpanded(true);
  }, [targetId, targeted]);
  const showAll = expanded || searching;
  const shown = showAll ? room.things : room.things.slice(0, 4);

  return (
    <Card variant="elevated">
      <Stack gap={14}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Icon name="meeting_room" />
            <h2
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 700,
                color: "var(--md-sys-color-on-surface)",
              }}
            >
              {room.name}
            </h2>
          </div>
          <Badge tone="muted">
            {room.things.length} device{room.things.length === 1 ? "" : "s"}
          </Badge>
        </div>

        <div id={listId}>
          {shown.map((thing) => (
            <ThingRow key={thing.id} thing={thing} />
          ))}
        </div>

        {!searching && room.things.length > 4 ? (
          <Row
            justify="center"
            style={{ paddingTop: "8px", borderTop: "1px solid var(--md-sys-color-outline-variant)" }}
          >
            <button
              type="button"
              className="disclosure-button"
              aria-expanded={showAll}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
            >
              {showAll ? "Show fewer" : `Show all ${room.things.length} devices`}
            </button>
          </Row>
        ) : null}
      </Stack>
    </Card>
  );
}

export function UpcomingSection({ compact = false }: { compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
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
      <div id="upcoming" />
      <Stack gap={12}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Row gap={8}>
            <Icon name="schedule" />
            <strong style={{ fontSize: "16px" }}>Upcoming and temporary changes</strong>
          </Row>
          <Badge tone="accent">{items.length} queued</Badge>
        </div>

        <Stack gap={8}>
          {(compact && !expanded ? items.slice(0, 3) : items).map((item) => (
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
                  flex: "0 1 110px",
                  color: "var(--md-sys-color-primary)",
                }}
              >
                {time.dayDifference(item.ts) === 0 ? `Today ${time.clock(item.ts)}` : time.stamp(item.ts)}
              </span>

              {item.kind === "revert" ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flex: 1,
                    flexWrap: "wrap",
                  }}
                >
                  <Link
                    className="text-link"
                    to={`/?q=#${encodeURIComponent(`device-${item.timer.device}`)}`}
                  >
                    {names.device(item.timer.device)} returns to{" "}
                    <strong>{names.value(item.timer.device, item.timer.attr, item.timer.value)}</strong>
                  </Link>
                  <Badge tone="warn">{time.rel(item.ts)}</Badge>
                </div>
              ) : item.kind === "for" ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flex: 1,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <Link
                      className="text-link"
                      to={`/schedules/${encodeURIComponent(item.timer.rule ?? "")}`}
                    >
                      {names.rule(item.timer.rule)}
                    </Link>{" "}
                    checks its conditions after a wait. Another trigger may restart the wait.
                  </div>
                  <Badge tone="accent">{time.rel(item.ts)}</Badge>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flex: 1,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "14px" }}>
                    <Link className="text-link" to={`/schedules/${encodeURIComponent(item.rule.id)}`}>
                      <strong>{item.rule.name ?? item.rule.id}</strong>
                    </Link>
                    <Muted>{describeTriggerFor(item.rule, names)}</Muted>
                  </div>
                  <Badge tone="muted">{time.rel(item.ts)}</Badge>
                </div>
              )}
            </div>
          ))}
        </Stack>
        {compact && items.length > 3 && (
          <Button variant="text" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show fewer" : `Show all ${items.length} upcoming items`}
          </Button>
        )}
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
