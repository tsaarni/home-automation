import type { DayMark } from "@/lib/schedule";

export function DayStrip({ marks, label }: { marks: DayMark[]; label: string }) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px 0" }}>
      <div style={{ position: "relative", height: "46px" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: "3px",
            borderRadius: "9999px",
            backgroundColor: "var(--md-sys-color-surface-container-highest)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "25%",
            width: "2px",
            height: "50%",
            backgroundColor: "var(--md-sys-color-primary)",
            left: pct(nowMinutes),
            zIndex: 2,
          }}
          title={`Now: ${label}`}
        />
        {marks.map((mark) => (
          <div
            key={`${mark.ruleId}-${mark.label}`}
            style={{
              position: "absolute",
              top: "50%",
              left: pct(mark.minutes),
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              zIndex: 3,
            }}
            title={`${mark.label} → ${mark.value}`}
          >
            <div
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "9999px",
                backgroundColor: mark.solar ? "var(--md-sys-color-warning)" : "var(--md-sys-color-primary)",
                border: "2px solid var(--md-sys-color-surface-container)",
              }}
            />
            <span
              style={{
                position: "absolute",
                top: "12px",
                fontSize: "10px",
                fontWeight: 500,
                color: "var(--md-sys-color-on-surface-variant)",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {mark.solar ? "≈" : ""}
              {mark.label}
              {mark.value ? ` · ${mark.value === "ON" ? "on" : mark.value === "OFF" ? "off" : mark.value}` : ""}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "10px",
          color: "var(--md-sys-color-on-surface-variant)",
          fontFamily: "Roboto Mono, monospace",
        }}
      >
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}
