import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { useDevices, useHome, useNames, useRules, useTime, useTimers } from "@/api/queries";
import { Badge, Button, Card, Empty, Muted, Row, Stack } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { ThingRow } from "@/components/ThingRow";
import type { RoomView } from "@/home/derive";
import { upcomingItems } from "@/lib/runs";
import { describeTrigger, parseRule } from "@/lib/schedule";
import { matches, useSearchQuery } from "@/lib/search";
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  grid: {
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "1fr",
    "@media (min-width: 900px)": { gridTemplateColumns: "1fr 1fr" },
  },
  roomHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.space2,
    marginBottom: tokens.space3,
  },
  roomName: { fontSize: tokens.fontLg, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" },
  divider: {
    borderTopColor: tokens.border,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    paddingTop: tokens.space3,
  },
  upcoming: { display: "flex", flexDirection: "column", gap: tokens.space2 },
  upcomingRow: { display: "flex", gap: tokens.space3, alignItems: "baseline" },
  clock: { fontVariantNumeric: "tabular-nums", fontWeight: 600, minWidth: "48px" },
  banner: {
    borderColor: tokens.bad,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: tokens.radiusSm,
    padding: tokens.space3,
    color: tokens.bad,
  },
});

/** Home (Now): room cards with controls, the override/pending strip and the header (§5.1). */
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
      <Stack gap={4}>
        {devices.isError ? (
          <div {...stylex.props(styles.banner)}>
            Cannot reach the backend. Check that the service is running and the dev proxy points at it.
          </div>
        ) : null}
        <UpcomingSection />
        {visible.length === 0 ? (
          <Empty>
            {home.rooms.length === 0 ? "Waiting for the first devices…" : `Nothing matches “${query}”`}
          </Empty>
        ) : null}
        <div {...stylex.props(styles.grid)}>
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
    <Card>
      <div {...stylex.props(styles.roomHeader)}>
        <span {...stylex.props(styles.roomName)}>{room.name}</span>
        <Muted>{room.things.length} things</Muted>
      </div>
      <Stack gap={4}>
        {shown.map((thing) => (
          <ThingRow key={thing.id} thing={thing} />
        ))}
      </Stack>
      {shown.length < room.things.length ? (
        <div {...stylex.props(styles.divider)} style={{ marginTop: 12 }}>
          <Button size="small" variant="ghost" onClick={() => setExpanded(true)}>
            show {room.things.length - shown.length} more in {room.name.toLowerCase()}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** Pending holds and overrides plus every armed schedule's next fire (§6.1). */
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
    <Card>
      <Row justify="space-between" style={{ marginBottom: 12 }}>
        <strong>Coming up</strong>
        <Muted>{items.length} in the queue</Muted>
      </Row>
      <div {...stylex.props(styles.upcoming)}>
        {items.map((item) => (
          <div
            key={`${item.kind}-${item.ts}-${item.kind === "schedule" ? item.rule.id : item.timer.id}`}
            {...stylex.props(styles.upcomingRow)}
          >
            <span {...stylex.props(styles.clock)}>{time.clock(item.ts)}</span>
            {item.kind === "revert" ? (
              <>
                <span>
                  {names.device(item.timer.device)} goes back to{" "}
                  <strong>{names.value(item.timer.device, item.timer.attr, item.timer.value)}</strong>
                </span>
                <Badge tone="warn">{time.rel(item.ts)}</Badge>
              </>
            ) : item.kind === "for" ? (
              <>
                <span>{names.rule(item.timer.rule)} will act, if the value still holds</span>
                <Badge tone="accent">{time.rel(item.ts)}</Badge>
              </>
            ) : (
              <>
                <span>{item.rule.name ?? item.rule.id}</span>
                <Muted>{describeTriggerFor(item.rule, names)}</Muted>
                <Badge tone="muted">{time.rel(item.ts)}</Badge>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function describeTriggerFor(
  rule: Parameters<typeof parseRule>[0],
  names: Parameters<typeof describeTrigger>[1],
): string {
  const parsed = parseRule(rule);
  return parsed.ok ? describeTrigger(parsed.schedule.when, names) : "a custom schedule";
}
