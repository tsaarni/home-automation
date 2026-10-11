import * as stylex from "@stylexjs/stylex";
import type { DayMark } from "@/lib/schedule";
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  wrap: { position: "relative", height: "76px", marginTop: tokens.space2, marginBottom: tokens.space2 },
  line: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: "2px",
    backgroundColor: tokens.border,
  },
  now: { position: "absolute", top: "38%", width: "1px", height: "24%", backgroundColor: tokens.accent },
  mark: {
    position: "absolute",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
  },
  dot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    borderStyle: "solid",
    borderWidth: 2,
    borderColor: tokens.surface,
    backgroundColor: tokens.accent,
    zIndex: 1,
  },
  dotSolar: { backgroundColor: tokens.warn },
  label: {
    fontSize: "10px",
    color: tokens.textMuted,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  scale: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: tokens.textMuted },
});

/**
 * A 24 h line for one thing's schedules. Clock triggers are placed at their exact time;
 * solar triggers are placed at the backend's next occurrence (never computed here, §10.3).
 */
export function DayStrip({ marks, label }: { marks: DayMark[]; label: string }) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;

  return (
    <div>
      <div {...stylex.props(styles.wrap)}>
        <div {...stylex.props(styles.line)} />
        <div {...stylex.props(styles.now)} style={{ left: pct(nowMinutes) }} title={`now ${label}`} />
        {marks.map((mark) => (
          <div
            key={`${mark.ruleId}-${mark.label}`}
            {...stylex.props(styles.mark)}
            style={{ left: pct(mark.minutes), top: "52%" }}
            title={`${mark.label} → ${mark.value}`}
          >
            <div {...stylex.props(styles.dot, mark.solar && styles.dotSolar)} />
            <span {...stylex.props(styles.label)}>
              {mark.solar ? "≈" : ""}
              {mark.label}
              {mark.value
                ? ` · ${mark.value === "ON" ? "on" : mark.value === "OFF" ? "off" : mark.value}`
                : ""}
            </span>
          </div>
        ))}
      </div>
      <div {...stylex.props(styles.scale)}>
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}
