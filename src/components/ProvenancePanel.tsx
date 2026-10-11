import * as stylex from "@stylexjs/stylex";
import { useEvents, useNames, useSetValue, useTime } from "@/api/queries";
import type { Reading } from "@/home/derive";
import { provenanceSentence } from "@/lib/reasons";
import { provenanceIndex } from "@/lib/runs";
import { Badge, Button, Dialog, Muted, Row } from "./primitives";

const styles = stylex.create({
  title: { fontSize: "16px", fontWeight: 600 },
});

/** "Why is this value what it is?" (§6.2). */
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
    >
      <Row gap={3} wrap>
        <span {...stylex.props(styles.title)}>{value}</span>
        {sentence.kind === "manual" ? <Badge tone="accent">manual</Badge> : null}
        {sentence.kind === "rule" ? <Badge tone="accent">schedule</Badge> : null}
        {sentence.kind === "device" ? <Badge tone="muted">reported by the device</Badge> : null}
        {sentence.kind === "unknown" ? <Badge tone="warn">unknown</Badge> : null}
      </Row>
      <div>
        <strong>{sentence.title}</strong> <Muted>{sentence.detail}</Muted>
      </div>
      {sentence.rule ? <Muted>schedule id: {sentence.rule}</Muted> : null}
      <Row gap={2} wrap>
        <Button
          size="small"
          disabled={!event || event.previous === undefined || event.previous === null}
          onClick={() => {
            if (event && event.previous !== undefined && event.previous !== null) {
              setValue.mutate({
                target: { kind: "device", id: reading.device },
                body: { [reading.attr]: event.previous as never },
              });
            }
          }}
          title="write the previous value back — this is not an undo, a schedule may set it again"
        >
          set back to {event ? names.value(reading.device, reading.attr, event.previous) : "—"}
        </Button>
        <Muted>this is a plain manual set, not an undo</Muted>
      </Row>
      {event ? (
        <details>
          <summary>details</summary>
          <pre style={{ overflowX: "auto", fontSize: 12 }}>{JSON.stringify(event, null, 2)}</pre>
        </details>
      ) : null}
    </Dialog>
  );
}
