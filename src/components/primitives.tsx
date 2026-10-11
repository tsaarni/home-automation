import * as stylex from "@stylexjs/stylex";
import type { CSSProperties, ReactNode } from "react";
import { tokens } from "@/theme/tokens.stylex";

const NBSP = "\u00a0";

const styles = stylex.create({
  stack: { display: "flex", flexDirection: "column" },
  row: { display: "flex", flexDirection: "row", alignItems: "center" },
  wrap: { flexWrap: "wrap" },
  grow: { flexGrow: 1, minWidth: 0 },
  card: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: tokens.radius,
    boxShadow: tokens.shadow,
  },
  button: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.space2,
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: tokens.radiusSm,
    backgroundColor: tokens.surfaceRaised,
    color: tokens.text,
    cursor: "pointer",
    paddingBlock: tokens.space2,
    paddingInline: tokens.space3,
    fontSize: tokens.fontMd,
    fontWeight: 500,
    minHeight: "36px",
    transitionProperty: "background-color, opacity",
    transitionDuration: "120ms",
    ":hover": { backgroundColor: tokens.accentSoft },
    ":disabled": { opacity: 0.45, cursor: "not-allowed" },
  },
  primary: {
    backgroundColor: tokens.accent,
    borderColor: tokens.accent,
    color: "#ffffff",
    ":hover": { opacity: 0.9, backgroundColor: tokens.accent },
  },
  danger: {
    backgroundColor: "transparent",
    borderColor: tokens.bad,
    color: tokens.bad,
    ":hover": { backgroundColor: tokens.bad, color: "#ffffff" },
  },
  ghost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    ":hover": { backgroundColor: tokens.accentSoft },
  },
  small: {
    minHeight: "28px",
    paddingBlock: tokens.space1,
    paddingInline: tokens.space2,
    fontSize: tokens.fontSm,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.space1,
    borderRadius: "999px",
    paddingBlock: "2px",
    paddingInline: tokens.space2,
    fontSize: tokens.fontSm,
    fontWeight: 600,
    borderStyle: "solid",
    borderWidth: 1,
    whiteSpace: "nowrap",
  },
  toneMuted: { color: tokens.textMuted, borderColor: tokens.border, backgroundColor: tokens.surfaceRaised },
  toneOk: { color: tokens.ok, borderColor: tokens.ok, backgroundColor: "transparent" },
  toneWarn: { color: tokens.warn, borderColor: tokens.warn, backgroundColor: "transparent" },
  toneBad: { color: tokens.bad, borderColor: tokens.bad, backgroundColor: "transparent" },
  toneAccent: { color: tokens.accent, borderColor: tokens.accent, backgroundColor: tokens.accentSoft },
  field: {
    backgroundColor: tokens.surface,
    color: tokens.text,
    borderColor: tokens.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: tokens.radiusSm,
    paddingBlock: tokens.space2,
    paddingInline: tokens.space2,
    fontSize: tokens.fontMd,
    minWidth: 0,
    ":focus": { outlineColor: tokens.accent, outlineStyle: "solid", outlineWidth: 2 },
  },
  label: { fontSize: tokens.fontSm, color: tokens.textMuted, fontWeight: 500 },
  switch: {
    position: "relative",
    width: "46px",
    height: "26px",
    borderRadius: "999px",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surfaceRaised,
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  },
  switchOn: { backgroundColor: tokens.ok, borderColor: tokens.ok },
  knob: {
    position: "absolute",
    top: "2px",
    left: "2px",
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
    transitionProperty: "transform",
    transitionDuration: "140ms",
  },
  knobOn: { transform: "translateX(20px)" },
  dialogBackdrop: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(6, 10, 16, 0.6)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 50,
    paddingTop: tokens.space4,
  },
  dialog: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: tokens.radius,
    width: "100%",
    maxWidth: "720px",
    maxHeight: "92vh",
    overflowY: "auto",
  },
  dialogHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space3,
    padding: tokens.space4,
    borderBottomColor: tokens.border,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    position: "sticky",
    top: 0,
    backgroundColor: tokens.surface,
    zIndex: 1,
  },
  dialogBody: { padding: tokens.space4, display: "flex", flexDirection: "column", gap: tokens.space4 },
  dialogFooter: {
    display: "flex",
    gap: tokens.space2,
    justifyContent: "flex-end",
    padding: tokens.space4,
    borderTopColor: tokens.border,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    position: "sticky",
    bottom: 0,
    backgroundColor: tokens.surface,
  },
  muted: { color: tokens.textMuted },
  mono: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: tokens.fontSm,
    fontVariantNumeric: "tabular-nums",
  },
  tabular: { fontVariantNumeric: "tabular-nums" },
  mark: {
    backgroundColor: tokens.accentSoft,
    color: tokens.accent,
    borderRadius: tokens.radiusSm,
    paddingInline: tokens.space2,
    paddingBlock: "2px",
    cursor: "pointer",
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: tokens.accent,
  },
});

function gapStyle(gap: number): CSSProperties {
  return { gap: `${gap}px` };
}

type Gap = 1 | 2 | 3 | 4 | 5 | 6;

export function Stack({
  children,
  gap = 3,
  style,
}: {
  children: ReactNode;
  gap?: Gap;
  style?: CSSProperties;
}) {
  return (
    <div {...stylex.props(styles.stack)} style={{ ...gapStyle(gap * 4), ...style }}>
      {children}
    </div>
  );
}

export function Row({
  children,
  gap = 2,
  wrap,
  justify,
  align,
  style,
}: {
  children: ReactNode;
  gap?: Gap;
  wrap?: boolean;
  justify?: CSSProperties["justifyContent"];
  align?: CSSProperties["alignItems"];
  style?: CSSProperties;
}) {
  return (
    <div
      {...stylex.props(styles.row, wrap && styles.wrap)}
      style={{ ...gapStyle(gap * 4), justifyContent: justify, alignItems: align, ...style }}
    >
      {children}
    </div>
  );
}

export function Card({
  children,
  style,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <div {...stylex.props(styles.card)} style={{ padding: 16, ...style }} onClick={onClick}>
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  size,
  disabled,
  title,
  type = "button",
  grow,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "small";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  grow?: boolean;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      {...stylex.props(
        styles.button,
        variant === "primary" && styles.primary,
        variant === "danger" && styles.danger,
        variant === "ghost" && styles.ghost,
        size === "small" && styles.small,
        grow && styles.grow,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn" | "bad" | "accent";
  title?: string;
}) {
  const toneStyle =
    tone === "ok"
      ? styles.toneOk
      : tone === "warn"
        ? styles.toneWarn
        : tone === "bad"
          ? styles.toneBad
          : tone === "accent"
            ? styles.toneAccent
            : styles.toneMuted;
  return (
    <span title={title} {...stylex.props(styles.badge, toneStyle)}>
      {children}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...stylex.props(styles.switch, checked && styles.switchOn)}
    >
      <span {...stylex.props(styles.knob, checked && styles.knobOn)} />
    </button>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.label)}>{children}</span>;
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  label,
  min,
  max,
  step,
  list,
  style,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  list?: string;
  style?: CSSProperties;
}) {
  return (
    <label {...stylex.props(styles.stack)} style={{ gap: 4, ...style }}>
      {label ? <span {...stylex.props(styles.label)}>{label}</span> : null}
      <input
        {...stylex.props(styles.field)}
        type={type}
        value={value}
        min={min}
        max={max}
        step={step}
        list={list}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label {...stylex.props(styles.stack)} style={{ gap: 4 }}>
      {label ? <span {...stylex.props(styles.label)}>{label}</span> : null}
      <select
        {...stylex.props(styles.field)}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.muted)}>{children}</span>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.mono)}>{children}</span>;
}

export function Tabular({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span {...stylex.props(styles.tabular)} style={style}>
      {children}
    </span>
  );
}

export function Dialog({
  title,
  children,
  footer,
  onClose,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div {...stylex.props(styles.dialogBackdrop)} onClick={onClose}>
      <div
        {...stylex.props(styles.dialog)}
        style={wide ? { maxWidth: "900px" } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div {...stylex.props(styles.dialogHeader)}>
          <strong>{title}</strong>
          <Button variant="ghost" size="small" onClick={onClose} title="Close">
            ✕
          </Button>
        </div>
        <div {...stylex.props(styles.dialogBody)}>{children}</div>
        {footer ? <div {...stylex.props(styles.dialogFooter)}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function Chip({
  children,
  onClick,
  active,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      {...stylex.props(styles.button, styles.small, active ? styles.toneAccent : styles.ghost)}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <Row gap={2}>
      <Switch checked={checked} onChange={onChange} label={label} />
      <span>{label}</span>
    </Row>
  );
}

export function Spinner() {
  return <span {...stylex.props(styles.muted)}>Loading…</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div {...stylex.props(styles.muted)} style={{ padding: 24, textAlign: "center" }}>
      {children}
    </div>
  );
}

export const nbsp = NBSP;
export const primitiveStyles = styles;
