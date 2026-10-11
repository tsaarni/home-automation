import { useState } from "react";
import { useRestoreOverride, useSetValue, useTime, useTimers } from "@/api/queries";
import type { Reading } from "@/home/derive";
import { HOLD_CHOICES } from "@/lib/schedule";
import { Badge, Button, Icon, Row, Select, Switch, Tabular, TextField } from "./primitives";

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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        backgroundColor: "var(--md-sys-color-surface-container-high)",
        padding: "10px 14px",
        borderRadius: "8px",
        opacity: !reading.known ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <Row gap={8}>
          <span
            style={{ fontSize: "13px", fontWeight: 500, color: "var(--md-sys-color-on-surface-variant)" }}
          >
            {reading.label}
          </span>
          {!reading.known ? (
            <Badge tone="muted" title="No telemetry received">
              waiting
            </Badge>
          ) : kind === "switch" || kind === "boolean" ? (
            <Badge tone={isOn(reading) ? "ok" : "muted"}>{isOn(reading) ? "ON" : "OFF"}</Badge>
          ) : kind === "select" ? (
            <Badge tone="accent">{optionLabel(reading, current)}</Badge>
          ) : (
            <Tabular style={{ fontSize: "18px", fontWeight: 700, color: "var(--md-sys-color-on-surface)" }}>
              {current === undefined ? "—" : String(round(Number(current)))}
              {reading.unit ? (
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--md-sys-color-on-surface-variant)",
                    marginLeft: "2px",
                  }}
                >
                  {reading.unit}
                </span>
              ) : null}
            </Tabular>
          )}
        </Row>

        {kind === "switch" || kind === "boolean" ? (
          <Row gap={4}>
            {reading.hold ? (
              <>
                {HOLD_CHOICES.slice(0, 3).map((hold) => (
                  <Button
                    key={hold}
                    size="small"
                    variant="tonal"
                    disabled={busy}
                    title={`Turn on for ${hold}`}
                    onClick={() => write(reading.on, hold)}
                  >
                    {hold}
                  </Button>
                ))}
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  title="Turn off"
                  onClick={() => write(reading.off)}
                >
                  Off
                </Button>
              </>
            ) : null}
            <Switch
              checked={isOn(reading)}
              disabled={busy}
              label={`${target} ${isOn(reading) ? "off" : "on"}`}
              onChange={(next) => write(next ? reading.on : reading.off)}
            />
          </Row>
        ) : null}
      </div>

      {kind === "number" ? (
        <Row gap={12} wrap>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: "9999px",
              backgroundColor: "var(--md-sys-color-surface-container-highest)",
              border: "1px solid var(--md-sys-color-outline-variant)",
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              disabled={busy || typeof current !== "number"}
              title="Decrease setpoint"
              onClick={() => write(round(Number(current) - (reading.step ?? 0.5)))}
              style={{
                width: "36px",
                height: "36px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--md-sys-color-on-surface)",
              }}
            >
              <Icon name="remove" />
            </button>
            <Tabular
              style={{
                minWidth: "60px",
                textAlign: "center",
                fontSize: "16px",
                fontWeight: 700,
                padding: "0 6px",
              }}
            >
              {typeof current === "number" ? round(current) : "—"}
              {reading.unit ? (
                <span style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
                  {" "}
                  {reading.unit}
                </span>
              ) : null}
            </Tabular>
            <button
              type="button"
              disabled={busy || typeof current !== "number"}
              title="Increase setpoint"
              onClick={() => write(round(Number(current) + (reading.step ?? 0.5)))}
              style={{
                width: "36px",
                height: "36px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--md-sys-color-on-surface)",
              }}
            >
              <Icon name="add" />
            </button>
          </div>

          {reading.unit === "C" &&
          reading.min !== null &&
          reading.min !== undefined &&
          reading.max !== null &&
          reading.max !== undefined ? (
            <div style={{ minWidth: "160px" }}>
              <Select
                value=""
                onChange={(value) => {
                  if (value) write(Number(value));
                }}
                options={[
                  { value: "", label: "Preset temperature…" },
                  ...temperatureChoices(reading.min, reading.max, reading.step ?? 0.5).map((value) => ({
                    value: String(value),
                    label: `${value} °C`,
                  })),
                ]}
              />
            </div>
          ) : null}
        </Row>
      ) : null}

      {kind === "select" ? (
        <div style={{ maxWidth: "280px" }}>
          <Select
            value={String(current ?? "")}
            disabled={busy}
            onChange={(value) => write(reading.options?.find((option) => String(option) === value) ?? value)}
            options={(reading.options ?? []).map((option) => ({
              value: String(option),
              label: optionLabel(reading, option),
            }))}
          />
        </div>
      ) : null}

      {kind === "text" ? (
        <TextField value={draft ?? String(current ?? "")} onChange={setDraft} placeholder="—" />
      ) : null}

      {override?.due_at ? (
        <Row gap={8} wrap>
          <Badge tone="warn">
            <Icon name="timer" />
            <span>
              Restores to{" "}
              {override.value === undefined
                ? "previous setting"
                : `${override.value}${reading.unit ? ` ${reading.unit}` : ""}`}{" "}
              in {time.rel(override.due_at)}
            </span>
          </Badge>
          <Button size="small" variant="text" onClick={() => restore(override)}>
            Restore now
          </Button>
        </Row>
      ) : null}

      {pendingHold?.due_at ? (
        <Row gap={4} style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
          <Icon name="hourglass_top" />
          <span>
            {reading.schedules.length ? "A schedule is" : "A schedule will act"} waiting for this value to
            hold until {time.stamp(pendingHold.due_at)}
          </span>
        </Row>
      ) : null}

      {reading.schedules.length > 0 && !override ? (
        <Row gap={4} style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
          <Icon name="event_repeat" />
          <span>
            {reading.schedules.length === 1
              ? "1 schedule controls this"
              : `${reading.schedules.length} schedules control this`}
          </span>
        </Row>
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
