import { useState } from "react";
import { useNames, useTime } from "@/api/queries";
import type { Reading, Thing } from "@/home/derive";
import { ClimatePatch, climateCapable } from "./ClimatePatch";
import { Control } from "./Control";
import { ProvenancePanel } from "./ProvenancePanel";
import { Badge, Icon, Muted, Row, Stack, Tabular } from "./primitives";

function iconForThing(thing: Thing): string {
  switch (thing.kind) {
    case "plug":
      return "power";
    case "thermostat":
      return "thermostat";
    case "sensor":
      return "sensors";
    case "motion":
      return "motion_photos_on";
    case "contact":
      return "door_front";
    case "button":
      return "smart_button";
    case "siren":
      return "campaign";
    default:
      return "devices";
  }
}

export function ThingRow({ thing }: { thing: Thing }) {
  const time = useTime();
  const [provenance, setProvenance] = useState<Reading | null>(null);
  const climate = climateCapable(thing);
  const readings = thing.primary.filter((reading) => !reading.isControl);
  const primaryControls = thing.controls.filter(
    (r, i) =>
      thing.primary.some((p) => p.attr === r.attr) ||
      i === 0 ||
      (climate && (r.attr === "mode" || r.attr === "setpoint")),
  );
  const extraControls = thing.controls.filter((r) => !primaryControls.includes(r));
  const extraReadings = thing.readings.filter(
    (r) => !readings.some((p) => p.attr === r.attr) && !thing.controls.some((c) => c.attr === r.attr),
  );
  const availabilityReason = thing.readings.find((r) => r.availabilityReason)?.availabilityReason;
  const latest = thing.readings
    .flatMap((r) => (r.ts ? [r.ts] : []))
    .sort()
    .at(-1);
  const control = (reading: Reading) => <Control key={reading.attr} reading={reading} heading={thing.name} />;
  return (
    <section
      id={`device-${thing.id}`}
      aria-label={thing.name}
      tabIndex={-1}
      style={{
        padding: "14px 0",
        scrollMarginTop: "24px",
        borderBottom: "1px solid var(--md-sys-color-outline-variant)",
      }}
    >
      <Stack gap={10}>
        <Row gap={8} wrap>
          <Icon name={iconForThing(thing)} />
          <strong>{thing.name}</strong>
          {thing.available === false && <Badge tone="warn">Unavailable</Badge>}
          {thing.locked && <Badge tone="warn">Locked</Badge>}
          {thing.waiting && <Badge tone="muted">Waiting for device readings</Badge>}
        </Row>
        {thing.locked && <Muted>Controls are locked by the device configuration.</Muted>}
        {availabilityReason && <Muted>Availability: {availabilityReason.replace(/[_-]+/g, " ")}</Muted>}
        <Muted>
          {latest
            ? `Last device observation: ${time.stamp(latest)} (${time.rel(latest)})`
            : "No device observations yet."}
        </Muted>
        <Row gap={8} wrap>
          {readings.map((reading) => (
            <ReadingButton key={reading.attr} reading={reading} onClick={() => setProvenance(reading)} />
          ))}
        </Row>
        {climate && <ClimatePatch thing={thing} />}
        {primaryControls.filter((r) => !climate || (r.attr !== "mode" && r.attr !== "setpoint")).map(control)}
        {(extraReadings.length > 0 || extraControls.length > 0) && (
          <details>
            <summary>More readings and settings</summary>
            <Stack gap={12}>
              {extraControls.map(control)}
              {extraReadings.map((reading) => (
                <ReadingButton key={reading.attr} reading={reading} onClick={() => setProvenance(reading)} />
              ))}
            </Stack>
          </details>
        )}
        {provenance && (
          <ProvenancePanel
            reading={thing.readings.find((r) => r.attr === provenance.attr) ?? provenance}
            onClose={() => setProvenance(null)}
          />
        )}
      </Stack>
    </section>
  );
}

function ReadingButton({ reading, onClick }: { reading: Reading; onClick: () => void }) {
  const names = useNames();
  const time = useTime();
  return (
    <button
      type="button"
      className="reading-button"
      onClick={onClick}
      aria-label={`Why this value? ${reading.label}`}
    >
      <span>{reading.label}</span>
      <strong>{reading.known ? names.value(reading.device, reading.attr, reading.value) : "Unknown"}</strong>
      {reading.ts && (
        <span>
          Updated {time.stamp(reading.ts)} ({time.rel(reading.ts)})
        </span>
      )}
      <span className="reading-why">Why this value?</span>
    </button>
  );
}

export function ReadingLine({ reading }: { reading: Reading }) {
  const names = useNames();
  return (
    <Row gap={8}>
      <Muted>{reading.label}</Muted>
      <Tabular>{names.value(reading.device, reading.attr, reading.value)}</Tabular>
    </Row>
  );
}
