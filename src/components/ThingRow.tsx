import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { useNames, useTime } from "@/api/queries";
import type { Reading, Thing } from "@/home/derive";
import { tokens } from "@/theme/tokens.stylex";
import { Control } from "./Control";
import { ProvenancePanel } from "./ProvenancePanel";
import { Badge, Button, Muted, Row, Tabular } from "./primitives";

const styles = stylex.create({
  wrap: { display: "flex", flexDirection: "column", gap: tokens.space2 },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: tokens.space2,
    flexWrap: "wrap",
  },
  name: { fontWeight: 600, fontSize: tokens.fontMd },
  value: { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
  reading: {
    backgroundColor: "transparent",
    borderStyle: "none",
    borderWidth: 0,
    padding: 0,
    cursor: "pointer",
    color: tokens.text,
    textAlign: "left",
    display: "inline-flex",
    alignItems: "baseline",
    gap: tokens.space1,
    ":hover": { textDecorationLine: "underline", textDecorationStyle: "dotted" },
  },
});

/** One thing: its readings, its controls, and the provenance of every value in one click. */
export function ThingRow({ thing }: { thing: Thing }) {
  const names = useNames();
  const time = useTime();
  const [provenance, setProvenance] = useState<Reading | null>(null);
  const readings = thing.primary.filter((reading) => !reading.isControl || typeof reading.value === "number");

  return (
    <div {...stylex.props(styles.wrap)}>
      <div {...stylex.props(styles.header)}>
        <Row gap={2}>
          <span {...stylex.props(styles.name)}>{thing.name}</span>
          {thing.locked ? <Badge tone="warn">locked</Badge> : null}
          {thing.waiting ? <Badge tone="muted">waiting for reading</Badge> : null}
        </Row>
        <Row gap={3} wrap>
          {readings.map((reading) => (
            <button
              key={reading.attr}
              type="button"
              {...stylex.props(styles.reading)}
              onClick={() => setProvenance(reading)}
              title="where does this value come from?"
            >
              <Muted>{reading.label}</Muted>
              <span {...stylex.props(styles.value)}>
                {reading.known ? names.value(reading.device, reading.attr, reading.value) : "—"}
              </span>
              {reading.ts && thing.kind !== "sensor" ? <Muted>{time.rel(reading.ts)}</Muted> : null}
            </button>
          ))}
        </Row>
      </div>

      {thing.controls.map((reading) => (
        <Control key={reading.attr} reading={reading} heading={thing.name} />
      ))}

      {thing.referencedBy.length ? (
        <Row gap={2}>
          <Muted>
            {thing.referencedBy.length} schedule{thing.referencedBy.length === 1 ? "" : "s"} touch this
          </Muted>
        </Row>
      ) : null}

      {provenance ? <ProvenancePanel reading={provenance} onClose={() => setProvenance(null)} /> : null}
    </div>
  );
}

export function ReadingLine({ reading }: { reading: Reading }) {
  const names = useNames();
  return (
    <Row gap={2}>
      <Muted>{reading.label}</Muted>
      <Tabular>{names.value(reading.device, reading.attr, reading.value)}</Tabular>
    </Row>
  );
}

export { Button as _Button };
