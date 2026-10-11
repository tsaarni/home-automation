import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { useRestoreOverride, useSetValue, useTime, useTimers } from "@/api/queries";
import type { Reading } from "@/home/derive";
import { HOLD_CHOICES } from "@/lib/schedule";
import { tokens } from "@/theme/tokens.stylex";
import { Badge, Button, Muted, Row, Select, Switch, Tabular, TextField } from "./primitives";

const styles = stylex.create({
  wrap: { display: "flex", flexDirection: "column", gap: tokens.space2 },
  unit: { fontSize: tokens.fontSm, color: tokens.textMuted, marginLeft: "2px" },
  note: { fontSize: tokens.fontSm, color: tokens.textMuted },
  dim: { opacity: 0.6 },
});

type Kind = "switch" | "boolean" | "select" | "number" | "text";

function kindOf(reading: Reading): Kind {
  if (reading.options && reading.options.length === 2 && reading.options.includes("ON")) return "switch";
  if (typeof reading.value === "boolean" || reading.on === true) return "boolean";
  if (reading.options?.length) return "select";
  if (typeof reading.value === "number") return "number";
  return "text";
}

const MODE_LABELS: Record<string, string> = { "0": "off", "1": "heat", "2": "cool", "11": "auto" };

function optionLabel(reading: Reading, option: unknown): string {
  if (reading.attr === "mode") return MODE_LABELS[String(option)] ?? String(option);
  return String(option);
}

function isOn(reading: Reading): boolean {
  return reading.value === reading.on || reading.value === true;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One controllable reading. Optimistic (§6.4): the value flips immediately, then the poll or
 * the response reconciles it, and a refusal snaps it back with a toast.
 */
export function Control({ reading, heading }: { reading: Reading; heading?: string }) {
  const setValue = useSetValue();
  const restore = useRestoreOverride();
  const time = useTime();
  const timers = useTimers().data;
  const [draft, setDraft] = useState<string | null>(null);

  const override = timers?.timers.find(
    (timer) => timer.kind === "revert" && timer.device === reading.device && timer.attr === reading.attr,
  );
  const pendingHold = timers?.timers.find(
    (timer) => timer.kind === "for" && timer.device === reading.device && timer.attr === reading.attr,
  );
  const busy = setValue.isPending;
  const kind = kindOf(reading);
  const current = reading.value;
  const target = heading ?? reading.label;

  const write = (value: unknown, revertAfter?: string) => {
    setValue.mutate({
      target: { kind: "device", id: reading.device },
      body: { [reading.attr]: value as never, ...(revertAfter ? { revert_after: revertAfter } : {}) },
    });
  };

  return (
    <div {...stylex.props(styles.wrap, !reading.known && styles.dim)}>
      <Row gap={2} wrap justify="space-between">
        <Row gap={2}>
          <Muted>{reading.label}</Muted>
          {!reading.known ? (
            <Badge tone="muted" title="no value has been reported since the last restart">
              waiting for reading
            </Badge>
          ) : kind === "switch" || kind === "boolean" ? (
            <Badge tone={isOn(reading) ? "ok" : "muted"}>{isOn(reading) ? "on" : "off"}</Badge>
          ) : kind === "select" ? (
            <Badge tone="muted">{optionLabel(reading, current)}</Badge>
          ) : (
            <Tabular style={{ fontSize: "18px", fontWeight: 600 }}>
              {current === undefined ? "—" : String(round(Number(current)))}
              {reading.unit ? <span {...stylex.props(styles.unit)}>{reading.unit}</span> : null}
            </Tabular>
          )}
        </Row>

        {kind === "switch" || kind === "boolean" ? (
          <Row gap={1}>
            {HOLD_CHOICES.slice(0, 3).map((hold) => (
              <Button
                key={hold}
                size="small"
                variant="ghost"
                disabled={busy}
                title={`turn on for ${hold}`}
                onClick={() => write(reading.on, hold)}
              >
                {hold}
              </Button>
            ))}
            <Button
              size="small"
              variant="ghost"
              disabled={busy}
              title="turn off"
              onClick={() => write(reading.off)}
            >
              off
            </Button>
            <Switch
              checked={isOn(reading)}
              disabled={busy}
              label={`${target} ${isOn(reading) ? "off" : "on"}`}
              onChange={(next) => write(next ? reading.on : reading.off)}
            />
          </Row>
        ) : null}
      </Row>

      {kind === "number" ? (
        <Row gap={2} wrap>
          <Button
            size="small"
            disabled={busy || typeof current !== "number"}
            title="lower"
            onClick={() => write(round(Number(current) - (reading.step ?? 0.5)))}
          >
            −
          </Button>
          <Tabular style={{ fontSize: "22px", fontWeight: 600, minWidth: "76px", textAlign: "center" }}>
            {typeof current === "number" ? round(current) : "—"}
          </Tabular>
          <Button
            size="small"
            disabled={busy || typeof current !== "number"}
            title="raise"
            onClick={() => write(round(Number(current) + (reading.step ?? 0.5)))}
          >
            +
          </Button>
          {reading.unit === "C" &&
          reading.min !== null &&
          reading.min !== undefined &&
          reading.max !== null &&
          reading.max !== undefined ? (
            <Select
              value=""
              onChange={(value) => {
                if (value) write(Number(value));
              }}
              options={[
                { value: "", label: "set…" },
                ...temperatureChoices(reading.min, reading.max, reading.step ?? 0.5).map((value) => ({
                  value: String(value),
                  label: `${value} °C`,
                })),
              ]}
            />
          ) : null}
        </Row>
      ) : null}

      {kind === "select" ? (
        <Select
          value={String(current ?? "")}
          disabled={busy}
          onChange={(value) => write(reading.options?.find((option) => String(option) === value) ?? value)}
          options={(reading.options ?? []).map((option) => ({
            value: String(option),
            label: optionLabel(reading, option),
          }))}
        />
      ) : null}

      {kind === "text" ? (
        <TextField value={draft ?? String(current ?? "")} onChange={setDraft} placeholder="—" />
      ) : null}

      {override?.due_at ? (
        <Row gap={2} wrap>
          <Badge tone="warn">
            back to{" "}
            {override.value === undefined
              ? "its old value"
              : `${override.value}${reading.unit ? ` ${reading.unit}` : ""}`}{" "}
            {time.rel(override.due_at)}
          </Badge>
          <Button size="small" variant="ghost" onClick={() => restore(override)}>
            restore now
          </Button>
        </Row>
      ) : null}

      {pendingHold?.due_at ? (
        <div {...stylex.props(styles.note)}>
          {reading.schedules.length ? "a schedule is" : "a schedule will act"} waiting for this value to hold
          until {time.stamp(pendingHold.due_at)}
        </div>
      ) : null}

      {reading.schedules.length && !override ? (
        <div {...stylex.props(styles.note)}>
          {reading.schedules.length === 1
            ? "a schedule sets this too"
            : `${reading.schedules.length} schedules set this too`}{" "}
          — a manual change may be overwritten
        </div>
      ) : null}
    </div>
  );
}

function temperatureChoices(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value = round(value + step))
    values.push(value);
  return values.slice(0, 80);
}
