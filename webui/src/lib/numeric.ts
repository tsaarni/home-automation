/** Numeric metadata applies equally to typing, stepping and schedule values. */
export function numericError(
  value: number,
  { min, max, step }: { min?: number | null; max?: number | null; step?: number },
): string | null {
  if (!Number.isFinite(value)) return "Enter a valid number.";
  if (min != null && value < min) return `Enter a value of at least ${min}.`;
  if (max != null && value > max) return `Enter a value of at most ${max}.`;
  if (step != null && Number.isFinite(step) && step > 0) {
    const count = (value - (min ?? 0)) / step;
    if (Math.abs(count - Math.round(count)) > 1e-7)
      return `Use increments of ${step}${min != null ? ` starting at ${min}` : ""}.`;
  }
  return null;
}
