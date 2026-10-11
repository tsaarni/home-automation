import { useState } from "react";
import { useNames, useTime } from "@/api/queries";
import type { Reading, Thing } from "@/home/derive";
import { Control } from "./Control";
import { ProvenancePanel } from "./ProvenancePanel";
import { Badge, Button, Icon, Muted, Row, Stack, Tabular } from "./primitives";

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
  const names = useNames();
  const time = useTime();
  const [provenance, setProvenance] = useState<Reading | null>(null);
  const readings = thing.primary.filter((reading) => !reading.isControl || typeof reading.value === "number");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "14px",
        borderRadius: "12px",
        backgroundColor: "var(--md-sys-color-surface-container)",
        border: "1px solid var(--md-sys-color-outline-variant)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "8px",
              backgroundColor: "var(--md-sys-color-surface-container-highest)",
              color: "var(--md-sys-color-on-surface-variant)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name={iconForThing(thing)} />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontWeight: 600, fontSize: "15px", color: "var(--md-sys-color-on-surface)" }}>
                {thing.name}
              </span>
              {thing.locked ? <Badge tone="warn">locked</Badge> : null}
              {thing.waiting ? <Badge tone="muted">waiting for telemetry</Badge> : null}
            </div>
            {thing.referencedBy.length > 0 ? (
              <span style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
                {thing.referencedBy.length} schedule{thing.referencedBy.length === 1 ? "" : "s"} active
              </span>
            ) : null}
          </div>
        </div>

        <Row gap={8} wrap>
          {readings.map((reading) => (
            <button
              key={reading.attr}
              type="button"
              onClick={() => setProvenance(reading)}
              title="Click to view history & provenance"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                borderRadius: "9999px",
                backgroundColor: "var(--md-sys-color-surface-container-high)",
                border: "1px solid var(--md-sys-color-outline-variant)",
                color: "var(--md-sys-color-on-surface)",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              <span style={{ fontSize: "11px", color: "var(--md-sys-color-on-surface-variant)", textTransform: "uppercase" }}>
                {reading.label}
              </span>
              <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {reading.known ? names.value(reading.device, reading.attr, reading.value) : "—"}
              </span>
              {reading.ts && thing.kind !== "sensor" ? (
                <span style={{ fontSize: "11px", color: "var(--md-sys-color-on-surface-variant)" }}>
                  {time.rel(reading.ts)}
                </span>
              ) : null}
            </button>
          ))}
        </Row>
      </div>

      {thing.controls.length > 0 ? (
        <Stack gap={8} style={{ paddingTop: "6px", borderTop: "1px dashed var(--md-sys-color-outline-variant)" }}>
          {thing.controls.map((reading) => (
            <Control key={reading.attr} reading={reading} heading={thing.name} />
          ))}
        </Stack>
      ) : null}

      {provenance ? (
        <ProvenancePanel reading={provenance} onClose={() => setProvenance(null)} />
      ) : null}
    </div>
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

export { Button as _Button };
