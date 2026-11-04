import { useEffect, useState } from "react";
import { useSetValue, useTime, useTimers } from "@/api/queries";
import type { Reading } from "@/home/derive";
import { commandBusy } from "@/lib/command-busy";
import { durationWords } from "@/lib/format";
import { numericError } from "@/lib/numeric";
import { HOLD_CHOICES } from "@/lib/schedule";
import { CommandFeedback } from "./CommandFeedback";
import { Badge, Button, Icon, Row, Select, Switch, TextField } from "./primitives";

type Kind = "switch" | "boolean" | "select" | "number" | "text";

function kindOf(reading: Reading): Kind {
  if (reading.options && reading.options.length === 2 && reading.options.includes("ON")) return "switch";
  if (reading.declaredType === "boolean" || typeof reading.value === "boolean" || reading.on === true)
    return "boolean";
  if (reading.options?.length) return "select";
  if (reading.declaredType === "number" || typeof reading.value === "number") return "number";
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
  return Number(value.toPrecision(12));
}

export function Control({ reading, heading }: { reading: Reading; heading?: string }) {
  const setValue = useSetValue();
  const time = useTime();
  const timers = useTimers().data;
  const [draft, setDraft] = useState<string | null>(null);
  const [holdDuration, setHoldDuration] = useState(HOLD_CHOICES[0]);

  useEffect(() => {
    if (draft !== null && draft === String(reading.value ?? "")) setDraft(null);
  }, [reading.value]);

  const override = timers?.timers.find(
    (timer) => timer.kind === "revert" && timer.device === reading.device && timer.attr === reading.attr,
  );
  const pendingHold = timers?.timers.find(
    (timer) => timer.kind === "for" && timer.device === reading.device && timer.attr === reading.attr,
  );
  const busy = commandBusy(setValue.isPending, setValue.data, [reading]);
  const kind = kindOf(reading);
  const current = reading.value;
  const target = heading ?? reading.label;
  const numberError =
    draft !== null && kind === "number"
      ? !draft.trim()
        ? "Enter a valid number."
        : numericError(Number(draft), reading)
      : null;
  const dirty = draft !== null && draft !== String(current ?? "");

  const write = (value: unknown, revertAfter?: string) => {
    if (busy) return;
    if (typeof value === "number" && numericError(value, reading)) return;
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
        backgroundColor: "transparent",
        padding: "4px 0",
        borderRadius: "8px",
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
            {kind !== "number" ? " · Reported" : ""}
          </span>
          {!reading.known ? (
            <Badge tone="muted" title="No telemetry received">
              State unknown
            </Badge>
          ) : kind === "switch" || kind === "boolean" ? (
            <Badge tone={isOn(reading) ? "ok" : "muted"}>{isOn(reading) ? "ON" : "OFF"}</Badge>
          ) : kind === "select" ? (
            <Badge tone="accent">{optionLabel(reading, current)}</Badge>
          ) : kind === "text" ? (
            <span>{String(current ?? "—")}</span>
          ) : null}
        </Row>

        {kind === "switch" || kind === "boolean" ? (
          <Row gap={4} wrap>
            {reading.hold && (
              <details>
                <summary>Temporary change</summary>
                <Select
                  label="Restore previous value after"
                  value={holdDuration}
                  disabled={busy}
                  onChange={setHoldDuration}
                  options={HOLD_CHOICES.map((value) => ({ value, label: durationWords(value) }))}
                />
                <Button variant="tonal" disabled={busy} onClick={() => write(reading.on, holdDuration)}>
                  Turn on temporarily
                </Button>
                <p>A schedule may change this value before it is restored.</p>
              </details>
            )}
            {reading.known ? (
              <Switch
                checked={isOn(reading)}
                disabled={busy}
                label={`${target} ${isOn(reading) ? "off" : "on"}`}
                onChange={(next) => write(next ? reading.on : reading.off)}
              />
            ) : (
              <>
                <Button variant="outlined" disabled={busy} onClick={() => write(reading.on)}>
                  On
                </Button>
                <Button variant="outlined" disabled={busy} onClick={() => write(reading.off)}>
                  Off
                </Button>
              </>
            )}
          </Row>
        ) : null}
      </div>

      {kind === "number" && (
        <div className="form-section">
          <div className="number-editor">
            <button
              type="button"
              aria-label={`Decrease ${target}`}
              disabled={
                busy ||
                !Number.isFinite(Number(draft ?? current)) ||
                (reading.min != null && Number(draft ?? current) - (reading.step ?? 1) < reading.min)
              }
              onClick={() => setDraft(String(round(Number(draft ?? current) - (reading.step ?? 1))))}
            >
              −
            </button>
            <TextField
              label={`${reading.label}${reading.unit ? ` (${reading.unit})` : ""}`}
              error={numberError ?? undefined}
              supportingText={
                dirty && reading.known
                  ? `Reported: ${current}${reading.unit ? ` ${reading.unit}` : ""}`
                  : undefined
              }
              type="number"
              value={draft ?? String(current ?? "")}
              min={reading.min ?? undefined}
              max={reading.max ?? undefined}
              step={reading.step}
              disabled={busy}
              onChange={setDraft}
            />
            <button
              type="button"
              aria-label={`Increase ${target}`}
              disabled={
                busy ||
                !Number.isFinite(Number(draft ?? current)) ||
                (reading.max != null && Number(draft ?? current) + (reading.step ?? 1) > reading.max)
              }
              onClick={() => setDraft(String(round(Number(draft ?? current) + (reading.step ?? 1))))}
            >
              +
            </button>
          </div>
          <Button
            disabled={busy || draft === null || Boolean(numberError) || Number(draft) === current}
            onClick={() => {
              if (draft?.trim() && !numberError) write(Number(draft));
            }}
          >
            Apply
          </Button>
        </div>
      )}

      {kind === "select" ? (
        <div style={{ maxWidth: "280px" }}>
          <Select
            label={reading.label}
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
        <Row wrap>
          <TextField
            label={reading.label}
            disabled={busy}
            value={draft ?? String(current ?? "")}
            onChange={setDraft}
            placeholder="Enter a value"
          />
          <Button
            disabled={busy || draft === null || draft === String(current ?? "")}
            onClick={() => {
              if (draft !== null) write(draft);
            }}
          >
            Apply
          </Button>
        </Row>
      ) : null}

      {dirty && (kind === "text" || kind === "number") && (
        <Button variant="text" disabled={busy} onClick={() => setDraft(null)}>
          Discard changes
        </Button>
      )}
      {busy && !reading.pending && <span role="status">Waiting for device feedback…</span>}
      <CommandFeedback reading={reading} />
      {setValue.error && (
        <p role="alert" className="form-error">
          {setValue.error.message}
        </p>
      )}
      {override?.due_at ? (
        <Row gap={8} wrap>
          <Badge tone="warn">
            <Icon name="timer" />
            <span>
              Restores to{" "}
              {override.value === undefined
                ? "previous setting"
                : `${override.value}${reading.unit ? ` ${reading.unit}` : ""}`}{" "}
              at {time.stamp(override.due_at)} ({time.rel(override.due_at)})
            </span>
          </Badge>
          <Button
            size="small"
            variant="text"
            disabled={
              busy ||
              override.value == null ||
              (typeof override.value === "number" && Boolean(numericError(override.value, reading)))
            }
            onClick={() => write(override.value)}
          >
            Restore now
          </Button>
        </Row>
      ) : null}

      {pendingHold?.due_at ? (
        <Row gap={4} style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
          <Icon name="hourglass_top" />
          <span>
            A schedule is waiting until {time.stamp(pendingHold.due_at)} before checking its conditions.
            Another trigger may restart the wait.
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
