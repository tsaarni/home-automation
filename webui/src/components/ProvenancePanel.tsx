import { Link } from "react-router";
import { useDevices, useEvents, useNames, useSetValue, useTime } from "@/api/queries";
import type { Reading } from "@/home/derive";
import { commandBusy } from "@/lib/command-busy";
import { provenanceSentence } from "@/lib/reasons";
import { provenanceIndex } from "@/lib/runs";
import { valueError } from "@/lib/schedule-fields";
import { CommandFeedback } from "./CommandFeedback";
import { Badge, Button, Dialog, Muted, Row, Stack } from "./primitives";

export function ProvenancePanel({ reading, onClose }: { reading: Reading; onClose: () => void }) {
  const names = useNames();
  const time = useTime();
  const events = useEvents().data ?? [];
  const setValue = useSetValue();
  const devices = useDevices().data;
  const device = devices?.find((d) => d.id === reading.device);
  const spec = device?.attributes[reading.attr];
  const index = provenanceIndex(events);
  const indexed = index.get(`${reading.device}\u0000${reading.attr}`);
  const event =
    reading.known && reading.ts && (!indexed || reading.ts > indexed.ts || indexed.value !== reading.value)
      ? {
          type: "state",
          ts: reading.ts,
          device: reading.device,
          attr: reading.attr,
          value: reading.value,
          source: reading.source,
        }
      : indexed;
  const sentence = provenanceSentence(event, reading.device, reading.attr, names, time);
  const value = names.value(reading.device, reading.attr, reading.value);
  const canRestore = Boolean(
    reading.isControl && device && !device.locked && spec?.write && !valueError(event?.previous, spec),
  );
  const busy = commandBusy(setValue.isPending, setValue.data, [reading]);

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

        <CommandFeedback reading={reading} />
        {sentence.rule ? (
          <Link className="text-link" to={`/schedules/${encodeURIComponent(sentence.rule)}`}>
            Schedule: {names.rule(sentence.rule)}
          </Link>
        ) : null}

        {canRestore && (
          <Row gap={8} wrap>
            <Button
              size="small"
              variant="tonal"
              disabled={busy}
              onClick={() => {
                if (!busy && canRestore && event) {
                  setValue.mutate({
                    target: { kind: "device", id: reading.device },
                    body: { [reading.attr]: event.previous as never },
                  });
                }
              }}
            >
              Set back to {event ? names.value(reading.device, reading.attr, event.previous) : "—"}
            </Button>
            <Muted>Schedules may change this value again.</Muted>
          </Row>
        )}

        {setValue.error && (
          <p role="alert" className="form-error">
            {setValue.error.message}
          </p>
        )}
        {event ? (
          <details>
            <summary style={{ cursor: "pointer", fontSize: "12px" }}>Event details</summary>
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
