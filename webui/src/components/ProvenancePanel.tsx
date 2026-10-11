import { useEvents, useNames, useSetValue, useTime } from "@/api/queries";
import type { Reading } from "@/home/derive";
import { provenanceSentence } from "@/lib/reasons";
import { provenanceIndex } from "@/lib/runs";
import { Badge, Button, Dialog, Muted, Row, Stack } from "./primitives";

export function ProvenancePanel({ reading, onClose }: { reading: Reading; onClose: () => void }) {
  const names = useNames();
  const time = useTime();
  const events = useEvents().data ?? [];
  const setValue = useSetValue();
  const index = provenanceIndex(events);
  const event = index.get(`${reading.device}\u0000${reading.attr}`);
  const sentence = provenanceSentence(event, reading.device, reading.attr, names, time);
  const value = names.value(reading.device, reading.attr, reading.value);

  return (
    <Dialog
      title={`${names.device(reading.device)} · ${names.attr(reading.device, reading.attr)}`}
      onClose={onClose}
      footer={
        <Button variant="text" onClick={onClose}>
          Close
        </Button>
      }
    >
      <Stack gap={12}>
        <Row gap={8} wrap>
          <span style={{ fontSize: "18px", fontWeight: 700, color: "var(--md-sys-color-on-surface)" }}>
            {value}
          </span>
          {sentence.kind === "manual" ? <Badge tone="accent">manual</Badge> : null}
          {sentence.kind === "rule" ? <Badge tone="accent">schedule</Badge> : null}
          {sentence.kind === "device" ? <Badge tone="muted">device telemetry</Badge> : null}
          {sentence.kind === "unknown" ? <Badge tone="warn">unknown origin</Badge> : null}
        </Row>

        <div>
          <strong>{sentence.title}</strong> <Muted>{sentence.detail}</Muted>
        </div>

        {sentence.rule ? <Muted>Schedule ID: {sentence.rule}</Muted> : null}

        <Row gap={8} wrap>
          <Button
            size="small"
            variant="tonal"
            disabled={!event || event.previous === undefined || event.previous === null}
            onClick={() => {
              if (event && event.previous !== undefined && event.previous !== null) {
                setValue.mutate({
                  target: { kind: "device", id: reading.device },
                  body: { [reading.attr]: event.previous as never },
                });
              }
            }}
          >
            Revert to {event ? names.value(reading.device, reading.attr, event.previous) : "—"}
          </Button>
          <Muted>This is a standard write, not a state-machine rollback.</Muted>
        </Row>

        {event ? (
          <details>
            <summary style={{ cursor: "pointer", fontSize: "12px" }}>Raw event details</summary>
            <pre
              style={{
                fontFamily: "Roboto Mono, monospace",
                fontSize: "11px",
                overflowX: "auto",
                padding: "8px",
                borderRadius: "8px",
                backgroundColor: "var(--md-sys-color-surface-container-lowest)",
              }}
            >
              {JSON.stringify(event, null, 2)}
            </pre>
          </details>
        ) : null}
      </Stack>
    </Dialog>
  );
}
