import type { Reading } from "@/home/derive";
import { humanizeWords } from "@/lib/reasons";
import { Muted } from "./primitives";

export function CommandFeedback({ reading }: { reading: Reading }) {
  const format = (value: unknown) => {
    const text =
      value === true || value === "ON" ? "On" : value === false || value === "OFF" ? "Off" : String(value);
    return `${text}${typeof value === "number" && reading.unit ? ` ${reading.unit}` : ""}`;
  };
  const pending = reading.pending;
  if (pending)
    return (
      <span role="status">
        Requested {reading.label.toLowerCase()}: {format(pending.value)} —{" "}
        {pending.status === "accepted"
          ? "accepted; waiting for reported state"
          : "waiting for device feedback"}
        .
      </span>
    );
  if (!reading.outcome) return null;
  const value = reading.result?.value;
  const requested = value === undefined ? "" : ` ${format(value)}`;
  const status = reading.outcome;
  const message =
    status === "reported"
      ? `Requested${requested}: request reported; device confirmation unavailable.`
      : status === "confirmed"
        ? `Requested${requested}: matching state observed on the device.`
        : status === "failed" || status === "error"
          ? `Request${requested} failed.`
          : status === "unconfirmed"
            ? `Request${requested} is uncertain. Check the reported state.`
            : null;
  return message ? (
    <span role={status === "failed" || status === "error" ? "alert" : "status"}>
      {message} {reading.result?.reason && <Muted>{humanizeWords(reading.result.reason)}</Muted>}
    </span>
  ) : null;
}
