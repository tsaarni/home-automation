import { useEffect, useState } from "react";
import { useSetValue, useTime } from "@/api/queries";
import type { Thing } from "@/home/derive";
import { commandBusy } from "@/lib/command-busy";
import { numericError } from "@/lib/numeric";
import { CommandFeedback } from "./CommandFeedback";
import { Button, Muted, Select, Stack, TextField } from "./primitives";

export function climateCapable(thing: Thing): boolean {
  return Boolean(
    thing.gateway &&
      thing.controls.find((r) => r.attr === "mode")?.options?.length &&
      thing.controls.find((r) => r.attr === "setpoint")?.declaredType === "number",
  );
}

/** One explicit patch, with reported observations kept independent of the draft. */
export function ClimatePatch({ thing }: { thing: Thing }) {
  const submit = useSetValue();
  const time = useTime();
  const currentMode = thing.controls.find((r) => r.attr === "mode");
  const temperature = thing.controls.find((r) => r.attr === "setpoint");
  const [draft, setDraft] = useState<{ mode: string; temperature: string } | null>(null);
  const mode = draft?.mode ?? String(currentMode?.value ?? "");
  const value = draft?.temperature ?? String(temperature?.value ?? "");
  useEffect(() => {
    if (
      draft &&
      draft.mode === String(currentMode?.value ?? "") &&
      draft.temperature === String(temperature?.value ?? "")
    )
      setDraft(null);
  }, [currentMode?.value, temperature?.value]);
  const changed = mode !== String(currentMode?.value ?? "") || value !== String(temperature?.value ?? "");
  const options = currentMode?.options ?? [];
  const number = Number(value);
  const temperatureError = numericError(number, temperature ?? {});
  const valid = Boolean(mode && value.trim()) && options.some((o) => String(o) === mode) && !temperatureError;
  const busy = commandBusy(submit.isPending, submit.data, thing.controls);
  const edit = (patch: Partial<NonNullable<typeof draft>>) =>
    setDraft({ mode, temperature: value, ...patch });
  return (
    <Stack gap={12}>
      {draft && changed && (
        <Muted>
          Reported: {currentMode?.known ? String(currentMode.value) : "mode unknown"} ·{" "}
          {temperature?.known ? `${temperature.value} ${temperature.unit ?? ""}` : "temperature unknown"}
        </Muted>
      )}
      <Muted>
        {temperature?.ts
          ? `Updated ${time.stamp(temperature.ts)} (${time.rel(temperature.ts)})`
          : "No temperature observation yet"}
      </Muted>
      <div className="form-grid">
        <Select
          label="Mode"
          value={mode}
          disabled={busy}
          onChange={(mode) => edit({ mode })}
          options={[
            { value: "", label: "Choose a mode" },
            ...options.map((o) => ({ value: String(o), label: String(o) })),
          ]}
        />
        <TextField
          label={`Temperature${temperature?.unit ? ` (${temperature.unit})` : ""}`}
          type="number"
          value={value}
          min={temperature?.min ?? undefined}
          max={temperature?.max ?? undefined}
          step={temperature?.step}
          error={draft ? (temperatureError ?? undefined) : undefined}
          disabled={busy}
          onChange={(temperature) => edit({ temperature })}
        />
      </div>
      {draft && !valid && (
        <p className="form-error" role="alert">
          Choose an available mode and a temperature
          {temperature?.min != null && temperature?.max != null
            ? ` from ${temperature.min} to ${temperature.max}`
            : " within the device limits"}
          .
        </p>
      )}
      <Button
        disabled={busy || !valid || !changed}
        onClick={() =>
          !busy &&
          valid &&
          changed &&
          submit.mutate({
            target: { kind: "device", id: thing.id },
            body: { mode: options.find((o) => String(o) === mode) as never, setpoint: number },
          })
        }
      >
        {busy ? "Waiting for device feedback…" : "Apply mode and temperature"}
      </Button>
      {draft && (
        <Button variant="text" disabled={busy} onClick={() => setDraft(null)}>
          Discard changes
        </Button>
      )}
      {submit.error && (
        <p role="alert" className="form-error">
          {submit.error.message}
        </p>
      )}
      {thing.controls
        .filter((r) => r.attr === "mode" || r.attr === "setpoint")
        .map((r) => (
          <CommandFeedback key={r.attr} reading={r} />
        ))}
    </Stack>
  );
}
