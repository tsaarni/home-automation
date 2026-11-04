/** Mirrors the automator's duration tokens, including weeks and mixed signed units. */
export function durationSeconds(value: string): number | null {
  const text = value.trim();
  const parts = [...text.matchAll(/([+-]?)\s*(\d+(?:\.\d+)?)\s*([smhdw])/gi)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== text) return null;
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const seconds = parts.reduce(
    (n, p) => n + (p[1] === "-" ? -1 : 1) * Number(p[2]) * units[p[3].toLowerCase()],
    0,
  );
  return Number.isFinite(seconds) ? seconds : null;
}
