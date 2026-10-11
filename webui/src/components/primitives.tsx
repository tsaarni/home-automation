import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

export function Icon({ name, slot }: { name: string; slot?: string }) {
  return (
    <span className="material-symbols-outlined" slot={slot}>
      {name}
    </span>
  );
}

export function Stack({
  children,
  gap = 16,
  style,
  className = "",
}: {
  children: ReactNode;
  gap?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: `${gap}px`, ...style }}
    >
      {children}
    </div>
  );
}

export function Row({
  children,
  gap = 8,
  wrap,
  justify,
  align = "center",
  style,
  className = "",
}: {
  children: ReactNode;
  gap?: number;
  wrap?: boolean;
  justify?: CSSProperties["justifyContent"];
  align?: CSSProperties["alignItems"];
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? "wrap" : "nowrap",
        gap: `${gap}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Material Design 3 Card
 * Can be elevated, filled, or outlined.
 */
export function Card({
  children,
  variant = "elevated",
  style,
  onClick,
}: {
  children: ReactNode;
  variant?: "elevated" | "filled" | "outlined";
  style?: CSSProperties;
  onClick?: () => void;
}) {
  const bg =
    variant === "elevated"
      ? "var(--md-sys-color-surface-container-low)"
      : variant === "filled"
        ? "var(--md-sys-color-surface-container)"
        : "var(--md-sys-color-surface)";

  const border =
    variant === "outlined" ? "1px solid var(--md-sys-color-outline-variant)" : "none";

  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        backgroundColor: bg,
        borderRadius: "16px",
        padding: "16px",
        border,
        boxShadow: variant === "elevated" ? "0 1px 3px rgba(0,0,0,0.1)" : undefined,
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {variant === "elevated" ? <md-elevation /> : null}
      {children}
    </div>
  );
}

/**
 * Official Material Design 3 Buttons
 */
export function Button({
  children,
  onClick,
  variant = "filled",
  disabled,
  title,
  type = "button",
  icon,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "filled" | "tonal" | "outlined" | "text" | "elevated" | "danger";
  size?: "small" | "medium";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  icon?: string;
}) {
  const iconEl = icon ? <Icon slot="icon" name={icon} /> : null;

  if (variant === "tonal") {
    return (
      <md-filled-tonal-button disabled={disabled} title={title} type={type} onClick={onClick}>
        {iconEl}
        {children}
      </md-filled-tonal-button>
    );
  }
  if (variant === "outlined") {
    return (
      <md-outlined-button disabled={disabled} title={title} type={type} onClick={onClick}>
        {iconEl}
        {children}
      </md-outlined-button>
    );
  }
  if (variant === "text") {
    return (
      <md-text-button disabled={disabled} title={title} type={type} onClick={onClick}>
        {iconEl}
        {children}
      </md-text-button>
    );
  }
  if (variant === "elevated") {
    return (
      <md-elevated-button disabled={disabled} title={title} type={type} onClick={onClick}>
        {iconEl}
        {children}
      </md-elevated-button>
    );
  }
  if (variant === "danger") {
    return (
      <md-filled-button
        style={{
          "--md-filled-button-container-color": "var(--md-sys-color-error)",
          "--md-filled-button-label-text-color": "var(--md-sys-color-on-error)",
        } as CSSProperties}
        disabled={disabled}
        title={title}
        type={type}
        onClick={onClick}
      >
        {iconEl}
        {children}
      </md-filled-button>
    );
  }
  return (
    <md-filled-button disabled={disabled} title={title} type={type} onClick={onClick}>
      {iconEl}
      {children}
    </md-filled-button>
  );
}

export function IconButton({
  icon,
  onClick,
  title,
  disabled,
}: {
  icon: string;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <md-icon-button disabled={disabled} title={title} onClick={onClick}>
      <Icon name={icon} />
    </md-icon-button>
  );
}

/**
 * Material Design 3 Switch
 * Uses official <md-switch> web component with real M3 ripple and physics
 */
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
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleChange = () => {
      // @ts-expect-error selected exists on MdSwitch
      onChange(Boolean(el.selected));
    };
    el.addEventListener("change", handleChange);
    return () => el.removeEventListener("change", handleChange);
  }, [onChange]);

  return (
    <md-switch
      ref={ref}
      selected={checked}
      icons
      showOnlySelectedIcon
      disabled={disabled}
      aria-label={label}
    />
  );
}

/**
 * Official Material Design 3 Text Field
 */
export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  label,
  min,
  max,
  step,
  style,
  leadingIcon,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  style?: CSSProperties;
  leadingIcon?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleInput = (e: Event) => {
      // @ts-expect-error value on input
      onChange((e.target as { value: string }).value);
    };
    el.addEventListener("input", handleInput);
    return () => el.removeEventListener("input", handleInput);
  }, [onChange]);

  return (
    <md-outlined-text-field
      ref={ref}
      label={label}
      value={value}
      type={type}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      style={{ width: "100%", ...style }}
    >
      {leadingIcon ? <Icon slot="leading-icon" name={leadingIcon} /> : null}
    </md-outlined-text-field>
  );
}

/**
 * Official Material Design 3 Outlined Select
 */
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
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleChange = () => {
      // @ts-expect-error value on select
      onChange(el.value);
    };
    el.addEventListener("change", handleChange);
    return () => el.removeEventListener("change", handleChange);
  }, [onChange]);

  return (
    <md-outlined-select ref={ref} label={label} value={value} disabled={disabled}>
      {options.map((opt) => (
        <md-select-option key={opt.value} value={opt.value} headline={opt.label} selected={opt.value === value}>
          <div slot="headline">{opt.label}</div>
        </md-select-option>
      ))}
    </md-outlined-select>
  );
}

/**
 * Official Material Design 3 Filter Chip
 */
export function Chip({
  children,
  onClick,
  active,
  title,
  icon,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
  icon?: string;
}) {
  return (
    <md-filter-chip
      selected={active}
      label={typeof children === "string" ? children : undefined}
      title={title}
      onClick={onClick}
    >
      {icon ? <Icon slot="icon" name={icon} /> : null}
      {typeof children !== "string" ? children : null}
    </md-filter-chip>
  );
}

/**
 * Material Badge
 */
export function Badge({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn" | "bad" | "accent";
  title?: string;
}) {
  const bg =
    tone === "ok"
      ? "var(--md-sys-color-success-container)"
      : tone === "warn"
        ? "var(--md-sys-color-warning-container)"
        : tone === "bad"
          ? "var(--md-sys-color-error-container)"
          : tone === "accent"
            ? "var(--md-sys-color-primary-container)"
            : "var(--md-sys-color-surface-container-highest)";

  const color =
    tone === "ok"
      ? "var(--md-sys-color-on-success-container)"
      : tone === "warn"
        ? "var(--md-sys-color-on-warning-container)"
        : tone === "bad"
          ? "var(--md-sys-color-on-error-container)"
          : tone === "accent"
            ? "var(--md-sys-color-on-primary-container)"
            : "var(--md-sys-color-on-surface-variant)";

  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 10px",
        borderRadius: "9999px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor: bg,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/**
 * Official Material Design 3 Dialog
 */
export function Dialog({
  title,
  children,
  footer,
  onClose,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // @ts-expect-error open on dialog
    el.open = true;
    const handleClose = () => onClose();
    el.addEventListener("close", handleClose);
    return () => el.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <md-dialog ref={ref} open>
      <div slot="headline">{title}</div>
      <div slot="content" style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: "320px" }}>
        {children}
      </div>
      <div slot="actions">{footer}</div>
    </md-dialog>
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
    <Row gap={8}>
      <Switch checked={checked} onChange={onChange} label={label} />
      <span style={{ fontSize: "14px" }}>{label}</span>
    </Row>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)", fontWeight: 500 }}>{children}</span>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <span style={{ color: "var(--md-sys-color-on-surface-variant)", fontSize: "13px" }}>{children}</span>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: "13px" }}>{children}</span>;
}

export function Tabular({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "48px 16px", textAlign: "center", color: "var(--md-sys-color-on-surface-variant)" }}>
      {children}
    </div>
  );
}

export function Spinner() {
  return <md-circular-progress indeterminate />;
}
