import type { WriteResult } from "@/api/types";
import type { Reading } from "@/home/derive";

/** Bridge the HTTP response and the next poll so the same draft cannot be sent twice. */
export function commandBusy(
  pending: boolean,
  results: WriteResult[] | undefined,
  readings: Reading[],
): boolean {
  if (pending || readings.some((r) => r.pending)) return true;
  return (results ?? []).some((result) => {
    if (!["pending", "accepted"].includes(result.status) || typeof result.request_id !== "string")
      return false;
    const reading = readings.find((r) => r.attr === result.attr);
    return (
      reading?.result?.request_id !== result.request_id ||
      !["confirmed", "reported", "failed", "unconfirmed"].includes(reading.outcome ?? "")
    );
  });
}
