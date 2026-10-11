/** Time and value formatting. Every instant is rendered in the *house* timezone. */

export type TimeHelpers = ReturnType<typeof makeTime>;

function formatIn(zone: string, options: Intl.DateTimeFormatOptions, date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", options).format(date);
  }
}

function partsIn(zone: string, date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/** Formatting helpers bound to one timezone (from `GET /readyz`). */
export function makeTime(zone: string) {
  const clock = (iso: string | Date): string =>
    formatIn(zone, { hour: "2-digit", minute: "2-digit", hour12: false }, toDate(iso));

  const weekday = (iso: string | Date): string => formatIn(zone, { weekday: "short" }, toDate(iso));

  const date = (iso: string | Date): string =>
    formatIn(zone, { day: "numeric", month: "short" }, toDate(iso));

  /** "17:42" plus, when it is not today, "yesterday 20:15" / "Mon 06:00" / "11 Oct 23:30". */
  const stamp = (iso: string | Date, now: Date = new Date()): string => {
    const target = toDate(iso);
    const dayDelta = dayDifference(zone, target, now);
    if (dayDelta === 0) return clock(target);
    if (dayDelta === -1) return `yesterday ${clock(target)}`;
    if (dayDelta === 1) return `tomorrow ${clock(target)}`;
    if (Math.abs(dayDelta) < 7) return `${weekday(target)} ${clock(target)}`;
    return `${date(target)} ${clock(target)}`;
  };

  /** "in 1h 50m" / "3m ago" / "now". */
  const rel = (iso: string | Date | null | undefined, now: Date = new Date()): string => {
    if (!iso) return "";
    const seconds = (toDate(iso).getTime() - now.getTime()) / 1000;
    if (Math.abs(seconds) < 30) return "now";
    const text = duration(Math.abs(seconds));
    return seconds > 0 ? `in ${text}` : `${text} ago`;
  };

  const full = (iso: string | Date): string => `${date(iso)} ${clock(toDate(iso))}`;

  return {
    zone,
    clock,
    weekday,
    date,
    stamp,
    rel,
    full,
    dayDifference: (a: string | Date, b?: Date) => dayDifference(zone, toDate(a), b ?? new Date()),
  };
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Whole-day difference between two instants as seen in `zone`. */
function dayDifference(zone: string, target: Date, now: Date): number {
  const one = partsIn(zone, target);
  const two = partsIn(zone, now);
  const asNumber = (p: Record<string, string>) =>
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  return Math.round((asNumber(one) - asNumber(two)) / 86400000);
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** Parse "3h", "1h30m", "90s" (mirrors the backend's parse_duration). */
export function parseDuration(input: string): number | null {
  const text = input.trim().replace(/^\+/, "");
  if (!text) return null;
  const token = /(-?)(\d+(?:\.\d+)?)\s*([smhdw])/gi;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(token)) {
    consumed += match[0].length;
    total += Number(match[2]) * UNIT_SECONDS[match[3].toLowerCase()] * (match[1] === "-" ? -1 : 1);
  }
  if (consumed !== text.replace(/\s/g, "").length) return null;
  if (!Number.isFinite(total)) return null;
  return total;
}

/** Format seconds as "2h", "45m", "1h 30m". */
export function duration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const chunks: string[] = [];
  if (days) chunks.push(`${days}d`);
  if (hours) chunks.push(`${hours}h`);
  if (minutes && !days) chunks.push(`${minutes}m`);
  return chunks.join(" ") || "0s";
}

/** Human duration for a backend duration string ("3h" -> "3 hours"). */
export function durationWords(value: string): string {
  const seconds = parseDuration(value);
  if (seconds === null) return value;
  const hours = seconds / 3600;
  if (seconds % 3600 === 0) return hours === 1 ? "an hour" : `${hours} hours`;
  const minutes = seconds / 60;
  if (seconds % 60 === 0 && minutes < 90) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  if (seconds < 60) return `${seconds} seconds`;
  return duration(seconds);
}

/** Round for display without trailing noise: 21.0, 20.35, 0.01. */
export function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(Math.abs(value) < 1 ? 2 : digits));
  return String(rounded);
}

/** A reading as text: value + unit, switches as ON/OFF, unknowns as "—". */
export function formatValue(value: unknown, unit?: string | null): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
  return String(value);
}

/** Backend units in the words the UI shows: "C" -> "°C". */
export function displayUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  if (unit === "C") return "°C";
  return unit;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
