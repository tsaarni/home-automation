import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from "react";

export function Icon({ name, slot }: { name: string; slot?: string }) {
  return (
    <span aria-hidden="true" className="material-symbols-outlined" slot={slot}>
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

  const border = variant === "outlined" ? "1px solid var(--md-sys-color-outline-variant)" : "none";

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
  size = "medium",
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
  const buttonClass = size === "small" ? "button-small" : undefined;
  const iconEl = icon ? <Icon slot="icon" name={icon} /> : null;

  if (variant === "tonal") {
    return (
      <md-filled-tonal-button
        className={buttonClass}
        disabled={disabled}
        title={title}
        type={type}
        onClick={onClick}
      >
        {iconEl}
        {children}
      </md-filled-tonal-button>
    );
  }
  if (variant === "outlined") {
    return (
      <md-outlined-button
        className={buttonClass}
        disabled={disabled}
        title={title}
        type={type}
        onClick={onClick}
      >
        {iconEl}
        {children}
      </md-outlined-button>
    );
  }
  if (variant === "text") {
    return (
      <md-text-button className={buttonClass} disabled={disabled} title={title} type={type} onClick={onClick}>
        {iconEl}
        {children}
      </md-text-button>
    );
  }
  if (variant === "elevated") {
    return (
      <md-elevated-button
        className={buttonClass}
        disabled={disabled}
        title={title}
        type={type}
        onClick={onClick}
      >
        {iconEl}
        {children}
      </md-elevated-button>
    );
  }
  if (variant === "danger") {
    return (
      <md-filled-button
        className={buttonClass}
        style={
          {
            "--md-filled-button-container-color": "var(--md-sys-color-error)",
            "--md-filled-button-label-text-color": "var(--md-sys-color-on-error)",
          } as CSSProperties
        }
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
    <md-filled-button className={buttonClass} disabled={disabled} title={title} type={type} onClick={onClick}>
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
    <md-icon-button disabled={disabled} title={title} aria-label={title ?? icon} onClick={onClick}>
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
  id,
  disabled,
  required,
  error,
  supportingText,
  onBlur,
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
  id?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  supportingText?: string;
  onBlur?: () => void;
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
      id={id}
      disabled={disabled}
      required={required}
      error={Boolean(error)}
      error-text={error}
      supporting-text={supportingText}
      aria-invalid={Boolean(error)}
      onBlur={onBlur}
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
        <md-select-option
          key={opt.value}
          value={opt.value}
          headline={opt.label}
          selected={opt.value === value}
        >
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
        whiteSpace: "normal",
        overflowWrap: "anywhere",
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
  wide = false,
  beforeClose,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  beforeClose?: () => boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const callbacks = useRef({ onClose, beforeClose });
  callbacks.current = { onClose, beforeClose };
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    const cancel = (event: Event) => {
      if (callbacks.current.beforeClose && !callbacks.current.beforeClose()) event.preventDefault();
    };
    const close = () => callbacks.current.onClose();
    el.addEventListener("cancel", cancel);
    el.addEventListener("close", close);
    return () => {
      el.removeEventListener("cancel", cancel);
      el.removeEventListener("close", close);
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, []);
  return (
    <md-dialog ref={ref} open className={wide ? "dialog-wide" : "dialog-compact"} aria-labelledby={titleId}>
      <div slot="headline" id={titleId}>
        {title}
      </div>
      <div slot="content" className="dialog-content">
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
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <span style={{ fontSize: "14px" }}>{label}</span>
    </label>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)", fontWeight: 500 }}>
      {children}
    </span>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return (
    <span style={{ color: "var(--md-sys-color-on-surface-variant)", fontSize: "13px" }}>{children}</span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: "13px" }}>{children}</span>;
}

export function Tabular({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{ padding: "48px 16px", textAlign: "center", color: "var(--md-sys-color-on-surface-variant)" }}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return <md-circular-progress indeterminate />;
}
