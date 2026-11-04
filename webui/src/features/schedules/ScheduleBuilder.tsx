import { useRef, useState } from "react";
import { Link } from "react-router";
import { useDevices, useGroups, useNames, useRules, useSaveRule } from "@/api/queries";
import type { Attribute, Device, Rule, Scalar, Term } from "@/api/types";
import { Button, Dialog, Muted, Select, Stack, TextField, Toggle } from "@/components/primitives";
import { attrLabel } from "@/home/derive";
import { durationSeconds } from "@/lib/duration";
import {
  applySchedule,
  type Clause,
  clauseFor,
  DAYS,
  describeSchedule,
  emptySchedule,
  parseRule,
  SOLAR_EVENTS,
  slugify,
  type Trigger,
  unrepresentable,
} from "@/lib/schedule";
import { defaultValue, scheduleErrors, targetAttributes } from "@/lib/schedule-fields";
import { useUnsavedChanges } from "@/lib/use-unsaved";

type TriggerKind = "at" | "sun" | "state" | "every";
function kindOf(trigger: Trigger): TriggerKind {
  return trigger.kind === "at" && trigger.solar ? "sun" : trigger.kind;
}
function initial(rule: Rule | null) {
  const parsed = rule ? parseRule(rule) : null;
  return {
    schedule: parsed?.ok ? parsed.schedule : { ...emptySchedule(), then: [clauseFor("device", "", "", "")] },
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    enabled: rule?.enabled ?? true,
    once: rule?.once ?? false,
    priority: String(rule?.priority ?? 0),
    rateLimit: String(rule?.rate_limit ?? 1),
  };
}

export function ScheduleBuilder({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const deviceQuery = useDevices();
  const groupQuery = useGroups();
  const rules = useRules();
  const devices = deviceQuery.data ?? [];
  const groups = groupQuery.data ?? [];
  const names = useNames();
  const save = useSaveRule();
  const [draft, setDraft] = useState(() => initial(rule));
  const original = useRef(JSON.stringify(initial(rule)));
  const creationId = useRef<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [customDays, setCustomDays] = useState(
    () => draft.schedule.when.kind === "at" && repeatFor(draft.schedule.when.days) === "custom",
  );
  const originalCustomDays = useRef(customDays);
  const dirty = JSON.stringify(draft) !== original.current || customDays !== originalCustomDays.current;
  const [actionIds, setActionIds] = useState(() => draft.schedule.then.map(() => crypto.randomUUID()));
  const [conditionIds, setConditionIds] = useState(
    () => draft.schedule.onlyIf?.terms.map(() => crypto.randomUUID()) ?? [],
  );
  const triggerDrafts = useRef<Partial<Record<TriggerKind, Trigger>>>({});
  const formRef = useRef<HTMLDivElement>(null);
  const reasons = rule ? unrepresentable(rule) : [];
  const errors = scheduleErrors(draft.schedule, devices, groups, customDays);
  if (!Number.isInteger(Number(draft.priority)) || draft.priority === "")
    errors.priority = "Enter a whole-number priority.";
  if (draft.rateLimit === "" || !Number.isFinite(Number(draft.rateLimit)) || Number(draft.rateLimit) < 0)
    errors.rate = "Enter a minimum interval of zero or more seconds.";
  const description = describeSchedule(draft.schedule, names).sentence;
  const update = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const schedule = (patch: Partial<typeof draft.schedule>) =>
    update({ schedule: { ...draft.schedule, ...patch } });
  const trigger = (when: Trigger) => schedule({ when });
  const closeAllowed = () =>
    !save.isPending && (!dirty || window.confirm("Discard unsaved schedule changes?"));
  const close = () => {
    if (closeAllowed()) onClose();
  };
  useUnsavedChanges(dirty && !save.isSuccess);
  const submit = () => {
    if (save.isPending) return;
    setAttempted(true);
    if (Object.keys(errors).length) {
      const key = Object.keys(errors)[0];
      requestAnimationFrame(() => {
        const area = formRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`);
        area?.scrollIntoView({ block: "center" });
        area?.querySelector<HTMLElement>("md-outlined-text-field, md-outlined-select, button")?.focus();
      });
      return;
    }
    // PUT is an upsert. A random suffix avoids overwriting a same-named schedule.
    if (!rule && !creationId.current) {
      let candidate = `${slugify(draft.name || description)}-${crypto.randomUUID()}`;
      while (rules.data?.some((r) => r.id === candidate))
        candidate = `${slugify(draft.name || description)}-${crypto.randomUUID()}`;
      creationId.current = candidate;
    }
    // Retrying a request with a lost response must address the same document.
    const id = rule?.id ?? creationId.current!;
    const base =
      rule ??
      ({
        id,
        enabled: true,
        priority: 0,
        once: false,
        rate_limit: 1,
        when: { at: "23:30" },
        then: [],
      } as Rule);
    save.mutate(
      applySchedule(base, draft.schedule, {
        id,
        name: draft.name || description,
        description: draft.description || undefined,
        enabled: draft.enabled,
        once: draft.once,
        priority: Number(draft.priority),
        rate_limit: Number(draft.rateLimit),
      }),
      { onSuccess: onClose },
    );
  };
  const problem = (key: string) =>
    attempted && errors[key] ? (
      <p role="alert" className="form-error field-error">
        {errors[key]}
      </p>
    ) : null;
  const updateClause = (i: number, patch: Partial<Clause>) =>
    schedule({ then: draft.schedule.then.map((c, n) => (n === i ? { ...c, ...patch } : c)) });
  const terms = draft.schedule.onlyIf?.terms ?? [];
  const setTerms = (next: Term[]) => schedule({ onlyIf: next.length ? { terms: next } : null });
  const addCondition = () => {
    setConditionIds([...conditionIds, crypto.randomUUID()]);
    setTerms([...terms, { attr: ["", ""], op: "eq", value: "" }]);
  };
  const nonDefault = Boolean(
    draft.name ||
      draft.description ||
      !draft.enabled ||
      draft.once ||
      Number(draft.priority) ||
      Number(draft.rateLimit) !== 1 ||
      draft.schedule.hold,
  );
  return (
    <Dialog
      wide
      title={rule ? `Edit: ${rule.name ?? rule.id}` : "New schedule"}
      onClose={onClose}
      beforeClose={closeAllowed}
      footer={
        <>
          <Button variant="text" disabled={save.isPending} onClick={close}>
            Cancel
          </Button>
          {!reasons.length && (
            <Button
              disabled={
                save.isPending ||
                deviceQuery.isPending ||
                groupQuery.isPending ||
                rules.isPending ||
                deviceQuery.isError ||
                groupQuery.isError ||
                rules.isError
              }
              onClick={submit}
            >
              {save.isPending ? "Saving…" : rule ? "Save changes" : "Create schedule"}
            </Button>
          )}
        </>
      }
    >
      {reasons.length ? (
        <Stack>
          <p>This schedule uses {reasons.join(", ")}.</p>
          <Link
            className="text-link"
            to={`/advanced?tab=schedules&rule=${encodeURIComponent(rule?.id ?? "")}`}
          >
            Edit advanced configuration
          </Link>
        </Stack>
      ) : (
        <div ref={formRef} className="form-section">
          {(deviceQuery.isError || groupQuery.isError || rules.isError) && (
            <p role="alert" className="form-error">
              Could not load devices or schedules.{" "}
              <button
                type="button"
                onClick={() => {
                  deviceQuery.refetch();
                  groupQuery.refetch();
                  rules.refetch();
                }}
              >
                Retry
              </button>
            </p>
          )}
          <section className="form-section" data-field="trigger">
            <h2>When</h2>
            <Select
              label="Trigger"
              value={kindOf(draft.schedule.when)}
              onChange={(value) => {
                const kind = value as TriggerKind;
                triggerDrafts.current[kindOf(draft.schedule.when)] = draft.schedule.when;
                const next =
                  triggerDrafts.current[kind] ??
                  (kind === "at" || kind === "sun"
                    ? {
                        kind: "at",
                        at: kind === "sun" ? "sunset" : "23:30",
                        solar: kind === "sun",
                        days: [],
                        offset: null,
                      }
                    : kind === "state"
                      ? { kind: "state", device: "", attr: "", changed: true }
                      : { kind: "every", every: "15m" });
                setCustomDays(next.kind === "at" && repeatFor(next.days) === "custom");
                trigger(next);
              }}
              options={[
                { value: "at", label: "Time" },
                { value: "sun", label: "Sunrise / sunset" },
                { value: "state", label: "Device update" },
                { value: "every", label: "Interval" },
              ]}
            />
            {draft.schedule.when.kind === "at" ? (
              <>
                {draft.schedule.when.solar ? (
                  <>
                    <Select
                      label="Solar event"
                      value={draft.schedule.when.at}
                      onChange={(at) => {
                        if (draft.schedule.when.kind === "at") trigger({ ...draft.schedule.when, at });
                      }}
                      options={[
                        "sunrise",
                        "sunset",
                        ...SOLAR_EVENTS.filter((e) => e !== "sunrise" && e !== "sunset"),
                      ].map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
                    />
                    <SolarOffset
                      value={draft.schedule.when.offset}
                      onChange={(offset) => {
                        if (draft.schedule.when.kind === "at") trigger({ ...draft.schedule.when, offset });
                      }}
                    />
                    {problem("offset")}
                  </>
                ) : (
                  <TextField
                    label="Time"
                    type="time"
                    value={draft.schedule.when.at}
                    onChange={(at) => {
                      if (draft.schedule.when.kind === "at") trigger({ ...draft.schedule.when, at });
                    }}
                  />
                )}
                <div data-field="repeat">
                  <Repeat
                    days={draft.schedule.when.days}
                    custom={customDays}
                    onChange={(days, custom) => {
                      setCustomDays(custom);
                      if (draft.schedule.when.kind === "at") trigger({ ...draft.schedule.when, days });
                    }}
                  />
                  {problem("repeat")}
                </div>
              </>
            ) : draft.schedule.when.kind === "every" ? (
              <DurationField
                label="Interval"
                value={draft.schedule.when.every}
                onChange={(every) => trigger({ kind: "every", every })}
              />
            ) : (
              <>
                <DeviceReading
                  devices={devices}
                  device={draft.schedule.when.device}
                  attr={draft.schedule.when.attr}
                  onChange={(device, attr) => {
                    if (draft.schedule.when.kind === "state")
                      trigger({ ...draft.schedule.when, device, attr });
                  }}
                />
                <details>
                  <summary>Device update options</summary>
                  <Toggle
                    label="Also trigger when the same value is reported"
                    checked={!draft.schedule.when.changed}
                    onChange={(same) => {
                      if (draft.schedule.when.kind === "state")
                        trigger({ ...draft.schedule.when, changed: !same });
                    }}
                  />
                  <Muted>Conditions below decide whether an update should run the actions.</Muted>
                </details>
              </>
            )}
            {problem("trigger")}
          </section>
          <section className="form-section">
            <h2>Action</h2>
            {draft.schedule.then.map((c, i) => {
              const attrs = targetAttributes(c.target, devices, groups);
              return (
                <div className="form-section" key={actionIds[i]} data-field={`action-${i}`}>
                  <Select
                    label="Device or group"
                    value={c.target.id ? `${c.target.kind}:${c.target.id}` : ""}
                    onChange={(value) => {
                      const split = value.indexOf(":");
                      const target = {
                        kind: value.slice(0, split) as "device" | "group",
                        id: value.slice(split + 1),
                      };
                      const available = targetAttributes(target, devices, groups);
                      const attr = Object.keys(available).length === 1 ? Object.keys(available)[0] : "";
                      updateClause(i, { target, attr, value: defaultValue(available[attr]) });
                    }}
                    options={[
                      { value: "", label: "Choose a device or group" },
                      ...devices
                        .filter((d) => !d.locked && Object.values(d.attributes).some((s) => s.write))
                        .map((d) => ({ value: `device:${d.id}`, label: names.device(d.id) })),
                      ...groups.map((g) => ({
                        value: `group:${g.id}`,
                        label: `${g.name ?? g.id} (${g.members.length} devices)`,
                      })),
                    ]}
                  />
                  <div className="form-grid">
                    <Select
                      label="Control"
                      disabled={!c.target.id || !Object.keys(attrs).length}
                      value={c.attr}
                      onChange={(attr) => updateClause(i, { attr, value: defaultValue(attrs[attr]) })}
                      options={[
                        { value: "", label: "Choose a control" },
                        ...Object.keys(attrs).map((a) => ({ value: a, label: attrLabel(a) })),
                      ]}
                    />
                    <ValueField
                      spec={attrs[c.attr]}
                      value={c.value}
                      onChange={(value) => updateClause(i, { value })}
                    />
                  </div>
                  {c.target.id && !Object.keys(attrs).length && (
                    <Muted>
                      This target has no compatible writable controls. Group members must share a type,
                      values, and numeric range.
                    </Muted>
                  )}
                  {problem(`action-${i}`)}
                  <details open={Boolean(c.revertAfter) || undefined}>
                    <summary>Restore previous value after…</summary>
                    <DurationField
                      label="Restore after"
                      optional
                      value={c.revertAfter ?? ""}
                      onChange={(v) => updateClause(i, { revertAfter: v || null })}
                    />
                    <Muted>Without a restore duration, the value stays until changed again.</Muted>
                  </details>
                  {draft.schedule.then.length > 1 && (
                    <Button
                      variant="text"
                      onClick={() => {
                        setActionIds(actionIds.filter((_, n) => n !== i));
                        schedule({ then: draft.schedule.then.filter((_, n) => n !== i) });
                      }}
                    >
                      Remove action
                    </Button>
                  )}
                </div>
              );
            })}
            {problem("actions")}
            <Button
              variant="text"
              icon="add"
              onClick={() => {
                setActionIds([...actionIds, crypto.randomUUID()]);
                schedule({ then: [...draft.schedule.then, clauseFor("device", "", "", "")] });
              }}
            >
              Add another action
            </Button>
          </section>
          {terms.length ? (
            <section className="form-section">
              <h2>Only if all conditions are true</h2>
              {terms.map((t, i) => {
                const spec = devices.find((d) => d.id === t.attr[0])?.attributes[t.attr[1]];
                const patch = (p: Partial<Term>) =>
                  setTerms(terms.map((v, n) => (n === i ? { ...v, ...p } : v)));
                return (
                  <div className="form-section" key={conditionIds[i]} data-field={`condition-${i}`}>
                    <DeviceReading
                      devices={devices}
                      device={t.attr[0]}
                      attr={t.attr[1]}
                      onChange={(device, attr) =>
                        patch({
                          attr: [device, attr],
                          op: "eq",
                          value: defaultValue(devices.find((d) => d.id === device)?.attributes[attr]),
                        })
                      }
                    />
                    <div className="form-grid">
                      <Select
                        label="Comparison"
                        value={t.op}
                        disabled={!spec}
                        onChange={(op) => patch({ op: op as Term["op"] })}
                        options={[
                          { value: "eq", label: "is" },
                          { value: "ne", label: "is not" },
                          ...(spec?.type === "number" && !spec.enum?.length
                            ? [
                                { value: "gt", label: "is above" },
                                { value: "ge", label: "is at least" },
                                { value: "lt", label: "is below" },
                                { value: "le", label: "is at most" },
                              ]
                            : []),
                        ]}
                      />
                      <ValueField
                        label="Compare with"
                        spec={spec}
                        value={t.value as Scalar}
                        onChange={(value) => patch({ value })}
                      />
                    </div>
                    {problem(`condition-${i}`)}
                    <Button
                      variant="text"
                      onClick={() => {
                        setConditionIds(conditionIds.filter((_, n) => n !== i));
                        setTerms(terms.filter((_, n) => n !== i));
                      }}
                    >
                      Remove condition
                    </Button>
                  </div>
                );
              })}
              <Delay value={draft.schedule.hold} onChange={(hold) => schedule({ hold })} />
              {problem("hold")}
            </section>
          ) : null}
          <Button variant="text" icon="add" onClick={addCondition}>
            Add condition
          </Button>
          <details open={nonDefault || undefined}>
            <summary>More options</summary>
            <Stack gap={16}>
              <TextField label="Name (optional)" value={draft.name} onChange={(name) => update({ name })} />
              <TextField
                label="Notes (optional)"
                value={draft.description}
                onChange={(description) => update({ description })}
              />
              <Toggle label="Enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
              <Toggle
                label="Delete after first run"
                checked={draft.once}
                onChange={(once) => update({ once })}
              />
              <Muted>This deletes the schedule after it fires.</Muted>
              <div className="form-grid">
                <div data-field="priority">
                  <TextField
                    label="Priority"
                    type="number"
                    value={draft.priority}
                    onChange={(priority) => update({ priority })}
                  />
                  {problem("priority")}
                </div>
                <div data-field="rate">
                  <TextField
                    label="Minimum interval between runs (seconds)"
                    type="number"
                    min={0}
                    value={draft.rateLimit}
                    onChange={(rateLimit) => update({ rateLimit })}
                  />
                  {problem("rate")}
                </div>
              </div>
              {!terms.length && (
                <div data-field="hold">
                  <Delay value={draft.schedule.hold} onChange={(hold) => schedule({ hold })} />
                  {problem("hold")}
                </div>
              )}
            </Stack>
          </details>
          <Muted>
            {draft.schedule.then.every((c) => c.target.id && c.attr)
              ? description
              : "Choose when to run, then a device or group and what to change."}
          </Muted>
          {save.error && (
            <p className="form-error" role="alert">
              Could not save: {save.error.message}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function ValueField({
  spec,
  value,
  onChange,
  label = "Set to",
}: {
  spec?: Attribute;
  value: Scalar;
  onChange: (v: Scalar) => void;
  label?: string;
}) {
  if (spec?.enum?.length || spec?.type === "boolean") {
    const options = spec.enum?.length ? spec.enum : [true, false];
    return (
      <Select
        label={label}
        value={String(value)}
        onChange={(v) => onChange(options.find((o) => String(o) === v) as Scalar)}
        options={options.map((o) => ({
          value: String(o),
          label: o === true || o === "ON" ? "On" : o === false || o === "OFF" ? "Off" : String(o),
        }))}
      />
    );
  }
  return (
    <TextField
      label={`${label}${spec?.unit ? ` (${spec.unit})` : ""}`}
      disabled={!spec}
      type={spec?.type === "number" ? "number" : "text"}
      value={String(value)}
      min={spec?.limits?.[0]}
      max={spec?.limits?.[1]}
      step={typeof spec?.step === "number" ? spec.step : undefined}
      onChange={(v) => onChange(spec?.type === "number" && v !== "" ? Number(v) : v)}
    />
  );
}
function DeviceReading({
  devices,
  device,
  attr,
  onChange,
}: {
  devices: Device[];
  device: string;
  attr: string;
  onChange: (device: string, attr: string) => void;
}) {
  const names = useNames();
  const attrs = Object.keys(devices.find((d) => d.id === device)?.attributes ?? {});
  return (
    <div className="form-grid">
      <Select
        label="Device"
        value={device}
        onChange={(d) => {
          const keys = Object.keys(devices.find((item) => item.id === d)?.attributes ?? {});
          onChange(d, keys.length === 1 ? keys[0] : "");
        }}
        options={[
          { value: "", label: "Choose a device" },
          ...devices.map((d) => ({ value: d.id, label: names.device(d.id) })),
        ]}
      />
      <Select
        label="Reading"
        value={attr}
        disabled={!device}
        onChange={(a) => onChange(device, a)}
        options={[
          { value: "", label: "Choose a reading" },
          ...attrs.map((a) => ({ value: a, label: attrLabel(a) })),
        ]}
      />
    </div>
  );
}
function repeatFor(days: string[]): string {
  const same = (values: string[]) => values.length === days.length && values.every((v) => days.includes(v));
  return !days.length || days.length === 7
    ? "daily"
    : same(DAYS.slice(0, 5))
      ? "weekdays"
      : same(DAYS.slice(5))
        ? "weekends"
        : "custom";
}
function Repeat({
  days,
  custom,
  onChange,
}: {
  days: string[];
  custom: boolean;
  onChange: (days: string[], custom: boolean) => void;
}) {
  return (
    <Stack gap={12}>
      <Select
        label="Repeat"
        value={custom ? "custom" : repeatFor(days)}
        onChange={(v) =>
          onChange(
            v === "daily"
              ? []
              : v === "weekdays"
                ? DAYS.slice(0, 5)
                : v === "weekends"
                  ? DAYS.slice(5)
                  : days,
            v === "custom",
          )
        }
        options={[
          { value: "daily", label: "Every day" },
          { value: "weekdays", label: "Weekdays" },
          { value: "weekends", label: "Weekends" },
          { value: "custom", label: "Custom days" },
        ]}
      />
      {custom && (
        <>
          <span>Days of the week</span>
          <div className="weekdays" role="group" aria-label="Days of the week">
            {DAYS.map((d, i) => (
              <button
                type="button"
                key={d}
                aria-label={["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}
                aria-pressed={days.includes(d)}
                onClick={() => onChange(days.includes(d) ? days.filter((v) => v !== d) : [...days, d], true)}
              >
                {d}
              </button>
            ))}
          </div>
        </>
      )}
    </Stack>
  );
}
export function DurationField({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
}) {
  const parsed = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value);
  const [unit, setUnit] = useState(parsed?.[2] ?? "m");
  if (value && !parsed)
    return <TextField label={`${label} (duration, e.g. 30m)`} value={value} onChange={onChange} />;
  return (
    <div className="form-grid">
      <TextField
        label={optional ? `${label} (optional)` : label}
        type="number"
        min={0}
        value={parsed?.[1] ?? ""}
        onChange={(v) => onChange(v ? `${v}${parsed?.[2] ?? unit}` : "")}
      />
      <Select
        label="Unit"
        value={parsed?.[2] ?? unit}
        onChange={(u) => {
          setUnit(u);
          if (parsed) onChange(`${parsed[1]}${u}`);
        }}
        options={[
          { value: "s", label: "Seconds" },
          { value: "m", label: "Minutes" },
          { value: "h", label: "Hours" },
          { value: "d", label: "Days" },
          { value: "w", label: "Weeks" },
        ]}
      />
    </div>
  );
}
function SolarOffset({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const seconds = value === null ? null : durationSeconds(value);
  const [direction, setDirection] = useState(
    value === null ? "at" : seconds !== null && seconds < 0 ? "before" : "after",
  );
  const magnitude = value?.startsWith("invalid:")
    ? value.slice(8)
    : value && /^[+-]?\d+(?:\.\d+)?[smhdw]$/i.test(value)
      ? value.replace(/^[+-]/, "")
      : seconds !== null
        ? `${Math.abs(seconds)}s`
        : (value ?? "");
  const offsetFor = (v: string, before: boolean) => {
    const amount = durationSeconds(v);
    if (!v) return "";
    if (amount === null || amount < 0) return `invalid:${v}`;
    return /^\d+(?:\.\d+)?[smhdw]$/i.test(v) ? `${before ? "-" : ""}${v}` : `${before ? -amount : amount}s`;
  };
  return (
    <div className="form-section" data-field="offset">
      <Select
        label="Offset"
        value={direction}
        onChange={(d) => {
          setDirection(d);
          onChange(d === "at" ? null : offsetFor(magnitude || "30m", d === "before"));
        }}
        options={[
          { value: "at", label: "At event" },
          { value: "before", label: "Before" },
          { value: "after", label: "After" },
        ]}
      />
      {direction !== "at" && (
        <DurationField
          label="Offset amount"
          value={magnitude}
          onChange={(v) => onChange(offsetFor(v, direction === "before"))}
        />
      )}
    </div>
  );
}
function Delay({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="form-section">
      <DurationField
        label="Delay before running"
        optional
        value={value ?? ""}
        onChange={(v) => onChange(v || null)}
      />
      <Muted>Another trigger can restart this wait. Conditions are checked before actions run.</Muted>
    </div>
  );
}
