import { useState } from "react";
import { useSetValue } from "@/api/queries";
import type { Thing } from "@/home/derive";
import { Button, Row, Select, TextField } from "./primitives";

/** Explicit combined submission for mode changes needing a compatible setpoint. */
export function ClimatePatch({ thing }: { thing: Thing }) {
  const submit = useSetValue();
  const currentMode = thing.readings.find((r) => r.attr === "mode");
  const currentSetpoint = thing.readings.find((r) => r.attr === "setpoint");
  const [mode, setMode] = useState<string | null>(null);
  const [setpoint, setSetpoint] = useState<string | null>(null);
  const chosenMode = mode ?? String(currentMode?.value ?? "heat");
  const chosenTemperature = setpoint ?? String(currentSetpoint?.value ?? "");
  return (
    <Row gap={8} wrap>
      <Select
        value={chosenMode}
        onChange={setMode}
        options={[
          { value: "heat", label: "Heat" },
          { value: "cool", label: "Cool" },
        ]}
      />
      <TextField value={chosenTemperature} onChange={setSetpoint} placeholder="Setpoint °C" />
      <Button
        disabled={submit.isPending || !chosenTemperature || !Number.isFinite(Number(chosenTemperature))}
        onClick={() =>
          submit.mutate({
            target: { kind: "device", id: thing.id },
            body: { mode: chosenMode, setpoint: Number(chosenTemperature) },
          })
        }
      >
        Apply mode and temperature
      </Button>
    </Row>
  );
}
