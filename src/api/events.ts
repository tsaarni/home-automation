/**
 * A rolling client-side window over the audit log (§10.2). We fetch the newest slice once
 * and then only deltas; `since` is inclusive, so the boundary millisecond is re-fetched
 * and de-duplicated by key.
 */
import { api } from "./client";
import type { Event } from "./types";

export const MAX_EVENTS = 2000;

/** Composite key used to de-duplicate the inclusive `since` overlap. */
export function eventKey(event: Event): string {
  return [
    event.ts,
    event.type,
    event.rule ?? "",
    event.device ?? "",
    event.attr ?? "",
    event.status ?? "",
    event.kind ?? "",
  ].join("|");
}

let buffer: Event[] = [];
let lastTs: string | null = null;
let primed = false;

export function resetEventBuffer(): void {
  buffer = [];
  lastTs = null;
  primed = false;
}

export function bufferedEvents(): Event[] {
  return buffer;
}

function mergeEvents(existing: Event[], incoming: Event[]): Event[] {
  const seen = new Set(existing.map(eventKey));
  const added: Event[] = [];
  for (const event of incoming) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(event);
  }
  const merged = [...existing, ...added].sort((a, b) => a.ts.localeCompare(b.ts));
  return merged.slice(-MAX_EVENTS);
}

/** Fetch new events and return the whole window, newest first. */
export async function pollEvents(): Promise<Event[]> {
  if (!primed) {
    const batch = await api.events({ limit: MAX_EVENTS });
    buffer = mergeEvents([], batch);
    primed = true;
  } else if (lastTs) {
    const delta = await api.events({ since: lastTs, limit: MAX_EVENTS });
    buffer = mergeEvents(buffer, delta);
  }
  const newest = buffer.length ? buffer[buffer.length - 1] : undefined;
  if (newest) lastTs = newest.ts;
  return [...buffer].reverse();
}
