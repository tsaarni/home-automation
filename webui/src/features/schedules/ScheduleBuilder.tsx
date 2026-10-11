import { useMemo, useState } from "react";
import { useDevices, useGroups, useNames, useSaveRule } from "@/api/queries";
import type { Attribute, Device, Group, Rule, Scalar, Term } from "@/api/types";
import {
  Badge,
  Button,
  Chip,
  Dialog,
  Icon,
  Label,
  Muted,
  Row,
  Select,
  Stack,
  Switch,
  TextField,
} from "@/components/primitives";
import { attrLabel } from "@/home/derive";
import { durationWords } from "@/lib/format";
import {
  applySchedule,
  type Clause,
  clauseFor,
  DAYS,
  DURATION_CHOICES,
  describeSchedule,
  emptySchedule,
  HOLD_CHOICES,
  type ParsedSchedule,
  parseRule,
  SOLAR_EVENTS,
  slugify,
  type Trigger,
  unrepresentable,
} from "@/lib/schedule";

interface Draft {
  schedule: ParsedSchedule;
  name: string;
  description: string;
  enabled: boolean;
  once: boolean;
  priority: number;
  rateLimit: number;
  id: string;
}

function draftFor(rule: Rule | null): Draft {
  if (!rule) {
    return {
      schedule: emptySchedule(),
      name: "",
      description: "",
      enabled: true,
      once: false,
      priority: 0,
      rateLimit: 1,
      id: "",
    };
  }
  const parsed = parseRule(rule);
  return {
    schedule: parsed.ok ? parsed.schedule : emptySchedule(),
    name: rule.name ?? "",
    description: rule.description ?? "",
    enabled: rule.enabled,
    once: rule.once,
    priority: rule.priority,
    rateLimit: rule.rate_limit ?? 1,
    id: rule.id,
  };
}

function newRuleDoc(id: string): Rule {
  return {
    id,
    enabled: true,
    priority: 0,
    once: false,
    rate_limit: 1,
    when: { at: "00:00", changed: false },
    then: [{ set: { device: "", attr: "", value: "" } }],
  } as Rule;
}

export function ScheduleBuilder({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const devices = useDevices().data ?? [];
  const groups = useGroups().data ?? [];
  const names = useNames();
  const save = useSaveRule();
  const rawReasons = rule ? unrepresentable(rule) : [];
  const [raw, setRaw] = useState(() => (rule ? JSON.stringify(rule, null, 2) : ""));
  const [rawMode, setRawMode] = useState(rawReasons.length > 0);
  const [draft, setDraft] = useState<Draft>(() => draftFor(rule));

  const writable = useMemo(
    () => devices.filter((device) => Object.values(device.attributes).some((attribute) => attribute.write)),
    [devices],
  );

  const problems = useMemo(() => validate(draft), [draft]);
  const description = useMemo(() => describeSchedule(draft.schedule, names), [draft.schedule, names]);
  const suggestedName = description.sentence;

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateTrigger = (trigger: Trigger) => update({ schedule: { ...draft.schedule, when: trigger } });
  const updateClause = (index: number, patch: Partial<Clause>) =>
    update({
      schedule: {
        ...draft.schedule,
        then: draft.schedule.then.map((clause, position) =>
          position === index ? { ...clause, ...patch } : clause,
        ),
      },
    });

  const saveRaw = () => {
    try {
      const document = JSON.parse(raw) as Rule;
      save.mutate(document, { onSuccess: onClose });
    } catch (error) {
      problems.push(`Invalid JSON: ${(error as Error).message}`);
    }
  };

  const submit = () => {
    if (rawMode) return saveRaw();
    const id = draft.id || slugify(draft.name || suggestedName);
    const base = rule ?? newRuleDoc(id);
    const document = applySchedule(base, draft.schedule, {
      id,
      name: draft.name || suggestedName,
      description: draft.description || undefined,
      enabled: draft.enabled,
      once: draft.once,
      priority: draft.priority,
      rate_limit: draft.rateLimit,
    } as Partial<Rule>);
    save.mutate(document, { onSuccess: onClose });
  };

  return (
    <Dialog
      wide
      title={rule ? `Edit: ${rule.name ?? rule.id}` : "New Schedule"}
      onClose={onClose}
      footer={
        <>
          {problems.length > 0 ? (
            <span style={{ color: "var(--md-sys-color-error)", fontSize: "13px", marginRight: "auto" }}>
              {problems[0]}
            </span>
          ) : null}
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            onClick={submit}
            disabled={save.isPending || (!rawMode && problems.length > 0)}
          >
            Save Schedule
          </Button>
        </>
      }
    >
      {rawReasons.length > 0 ? (
        <Badge tone="warn">This schedule contains advanced rules ({rawReasons.join(", ")}) — editing raw JSON.</Badge>
      ) : null}

      {!rawMode ? (
        <Stack gap={16}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "12px 16px",
              borderRadius: "12px",
              backgroundColor: "var(--md-sys-color-primary-container)",
              color: "var(--md-sys-color-on-primary-container)",
              fontWeight: 600,
              fontSize: "15px",
            }}
          >
            <Icon name="auto_awesome" />
            <span>{description.sentence}</span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              padding: "16px",
              borderRadius: "12px",
              backgroundColor: "var(--md-sys-color-surface-container)",
              border: "1px solid var(--md-sys-color-outline-variant)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Icon name="alarm" />
              <strong>When (Trigger)</strong>
            </div>

            <Row gap={8} wrap>
              {(
                [
                  ["at", "Clock Time", "schedule"],
                  ["sun", "Solar Position", "wb_sunny"],
                  ["state", "Device Reading", "sensors"],
                  ["every", "Interval", "repeat"],
                ] as const
              ).map(([key, label, iconName]) => (
                <Chip
                  key={key}
                  active={kindOfTrigger(draft.schedule.when) === key}
                  onClick={() => updateTrigger(switchTrigger(draft.schedule.when, key))}
                  icon={iconName}
                >
                  {label}
                </Chip>
              ))}
            </Row>

            <TriggerFields
              trigger={draft.schedule.when}
              onChange={updateTrigger}
              devices={devices}
              names={names}
            />

            <Row gap={12} wrap>
              <Switch checked={draft.once} onChange={(next) => update({ once: next })} label="One-shot schedule" />
              <span>One-shot: delete schedule immediately after it fires</span>
            </Row>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              padding: "16px",
              borderRadius: "12px",
              backgroundColor: "var(--md-sys-color-surface-container)",
              border: "1px solid var(--md-sys-color-outline-variant)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Icon name="bolt" />
                <strong>Do (Action)</strong>
              </div>
              <Button
                size="small"
                variant="tonal"
                icon="add"
                onClick={() =>
                  update({
                    schedule: {
                      ...draft.schedule,
                      then: [
                        ...draft.schedule.then,
                        clauseFor(
                          "device",
                          writable[0]?.id ?? "",
                          firstControllable(writable[0]),
                          0 as Scalar,
                        ),
                      ],
                    },
                  })
                }
              >
                Add action
              </Button>
            </div>

            {draft.schedule.then.map((clause, index) => (
              <div
                key={`${clause.target.id}-${clause.attr}-${index}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  padding: "12px",
                  borderRadius: "8px",
                  backgroundColor: "var(--md-sys-color-surface-container-high)",
                  border: "1px solid var(--md-sys-color-outline-variant)",
                }}
              >
                <ClauseFields
                  clause={clause}
                  devices={devices}
                  groups={groups}
                  names={names}
                  onChange={(patch) => updateClause(index, patch)}
                />
                {draft.schedule.then.length > 1 ? (
                  <Row justify="flex-end">
                    <Button
                      size="small"
                      variant="danger"
                      icon="delete"
                      onClick={() =>
                        update({
                          schedule: {
                            ...draft.schedule,
                            then: draft.schedule.then.filter((_item, position) => position !== index),
                          },
                        })
                      }
                    >
                      Remove action
                    </Button>
                  </Row>
                ) : null}
              </div>
            ))}

            {draft.schedule.onlyIf ? (
              <ConditionFields
                terms={draft.schedule.onlyIf.terms}
                devices={devices}
                names={names}
                onChange={(terms) => update({ schedule: { ...draft.schedule, onlyIf: { terms } } })}
              />
            ) : (
              <Row gap={8}>
                <Button
                  size="small"
                  variant="outlined"
                  icon="filter_alt"
                  onClick={() =>
                    update({ schedule: { ...draft.schedule, onlyIf: { terms: [defaultTerm(devices)] } } })
                  }
                >
                  Add condition (Only if…)
                </Button>
                <Muted>Condition must be satisfied for the action to execute</Muted>
              </Row>
            )}

            <Row gap={8} wrap>
              <Select
                label="Condition hold duration"
                value={draft.schedule.hold ?? ""}
                onChange={(value) => update({ schedule: { ...draft.schedule, hold: value || null } })}
                options={[
                  { value: "", label: "Immediately" },
                  ...DURATION_CHOICES.map((value) => ({ value, label: durationWords(value) })),
                ]}
              />
              <Muted>Wait for condition to continuously hold before executing</Muted>
            </Row>
          </div>
        </Stack>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          padding: "16px",
          borderRadius: "12px",
          backgroundColor: "var(--md-sys-color-surface-container)",
          border: "1px solid var(--md-sys-color-outline-variant)",
          marginTop: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="tune" />
          <strong>Configuration & Metadata</strong>
        </div>

        <TextField
          label="Schedule Name"
          value={draft.name}
          onChange={(value) => update({ name: value })}
          placeholder={suggestedName}
        />
        <TextField
          label="Notes & Description"
          value={draft.description}
          onChange={(value) => update({ description: value })}
        />

        <Row gap={12} wrap>
          <Switch checked={draft.enabled} onChange={(next) => update({ enabled: next })} label="Enabled" />
          <span>Enable schedule</span>
          <Muted>ID: {draft.id || slugify(draft.name || suggestedName)}</Muted>
        </Row>

        <Row gap={8}>
          <Button size="small" variant="text" onClick={() => setRawMode(!rawMode)}>
            {rawMode ? "Return to visual builder" : "Switch to raw JSON editor"}
          </Button>
        </Row>

        {rawMode ? (
          <textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={18}
            style={{
              fontFamily: "Roboto Mono, monospace",
              fontSize: "13px",
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "var(--md-sys-color-surface-container-lowest)",
              color: "var(--md-sys-color-on-surface)",
              border: "1px solid var(--md-sys-color-outline-variant)",
            }}
          />
        ) : (
          <Row gap={12} wrap>
            <TextField
              label="Priority"
              type="number"
              value={String(draft.priority)}
              onChange={(value) => update({ priority: Number(value) || 0 })}
            />
            <TextField
              label="Rate Limit (seconds)"
              type="number"
              value={String(draft.rateLimit)}
              onChange={(value) => update({ rateLimit: Number(value) || 0 })}
            />
          </Row>
        )}
      </div>
    </Dialog>
  );
}

function kindOfTrigger(trigger: Trigger): "at" | "sun" | "state" | "every" {
  if (trigger.kind === "at") return trigger.solar ? "sun" : "at";
  return trigger.kind;
}

function switchTrigger(current: Trigger, kind: "at" | "sun" | "state" | "every"): Trigger {
  if (kind === "at" && current.kind === "at" && !current.solar) return current;
  if (kind === "sun" && current.kind === "at" && current.solar) return current;
  if (kind === "state" && current.kind === "state") return current;
  if (kind === "every" && current.kind === "every") return current;
  switch (kind) {
    case "at":
      return { kind: "at", at: "23:30", solar: false, days: [], offset: null };
    case "sun":
      return { kind: "at", at: "dusk", solar: true, days: [], offset: null };
    case "state":
      return { kind: "state", device: "", attr: "", changed: true };
    default:
      return { kind: "every", every: "15m" };
  }
}

function TriggerFields({
  trigger,
  onChange,
  devices,
  names,
}: {
  trigger: Trigger;
  onChange: (next: Trigger) => void;
  devices: Device[];
  names: ReturnType<typeof useNames>;
}) {
  if (trigger.kind === "at") {
    return (
      <Stack gap={12}>
        <Row gap={8} wrap>
          {trigger.solar ? (
            <Select
              label="Solar event"
              value={trigger.at}
              onChange={(value) => onChange({ ...trigger, at: value })}
              options={SOLAR_EVENTS.map((event) => ({ value: event, label: event }))}
            />
          ) : (
            <TextField
              label="At time"
              type="time"
              value={trigger.at}
              onChange={(value) => onChange({ ...trigger, at: value })}
            />
          )}
          {trigger.solar ? (
            <TextField
              label="Offset (± 30m)"
              value={trigger.offset ?? ""}
              onChange={(value) => onChange({ ...trigger, offset: value || null })}
              placeholder="-30m"
            />
          ) : null}
        </Row>
        {!trigger.solar ? (
          <Row gap={4} wrap>
            <Label>Days of week</Label>
            {DAYS.map((day) => (
              <Chip
                key={day}
                active={trigger.days.includes(day)}
                onClick={() =>
                  onChange({
                    ...trigger,
                    days: trigger.days.includes(day)
                      ? trigger.days.filter((item) => item !== day)
                      : [...trigger.days, day],
                  })
                }
              >
                {day}
              </Chip>
            ))}
            <Button size="small" variant="text" onClick={() => onChange({ ...trigger, days: [] })}>
              Every day
            </Button>
          </Row>
        ) : null}
        {trigger.solar ? (
          <Muted>Calculated dynamically by the server based on solar ephemeris.</Muted>
        ) : null}
      </Stack>
    );
  }

  if (trigger.kind === "state") {
    const device = devices.find((item) => item.id === trigger.device);
    return (
      <Stack gap={12}>
        <Row gap={8} wrap>
          <Select
            label="Device"
            value={trigger.device}
            onChange={(value) => {
              const next = devices.find((item) => item.id === value);
              onChange({ ...trigger, device: value, attr: next ? Object.keys(next.attributes)[0] : "" });
            }}
            options={[
              { value: "", label: "Choose device…" },
              ...devices.map((item) => ({ value: item.id, label: names.device(item.id) })),
            ]}
          />
          <Select
            label="Attribute"
            value={trigger.attr}
            onChange={(value) => onChange({ ...trigger, attr: value })}
            options={[
              { value: "", label: "Choose attribute…" },
              ...Object.keys(device?.attributes ?? {}).map((attr) => ({
                value: attr,
                label: attrLabel(attr),
              })),
            ]}
          />
        </Row>
        <Row gap={8} wrap>
          <Chip active={trigger.changed} onClick={() => onChange({ ...trigger, changed: true })}>
            Only on value change
          </Chip>
          <Chip active={!trigger.changed} onClick={() => onChange({ ...trigger, changed: false })}>
            Every telemetry report
          </Chip>
        </Row>
      </Stack>
    );
  }

  return (
    <Row gap={8} wrap>
      <TextField
        label="Interval"
        value={trigger.every}
        onChange={(value) => onChange({ ...trigger, every: value })}
      />
      <Row gap={4}>
        {DURATION_CHOICES.slice(0, 5).map((choice) => (
          <Chip
            key={choice}
            active={trigger.every === choice}
            onClick={() => onChange({ ...trigger, every: choice })}
          >
            {choice}
          </Chip>
        ))}
      </Row>
    </Row>
  );
}

function ClauseFields({
  clause,
  devices,
  groups,
  names,
  onChange,
}: {
  clause: Clause;
  devices: Device[];
  groups: Group[];
  names: ReturnType<typeof useNames>;
  onChange: (patch: Partial<Clause>) => void;
}) {
  const device = devices.find((item) => item.id === clause.target.id);
  const attribute: Attribute | undefined = device?.attributes[clause.attr];
  const group = clause.target.kind === "group";
  const attributes = group
    ? commonAttributes(devices, groups.find((item) => item.id === clause.target.id)?.members ?? [])
    : Object.entries(device?.attributes ?? {})
        .filter(([, spec]) => spec.write)
        .map(([name]) => name);

  return (
    <Stack gap={8}>
      <Row gap={8} wrap>
        <Select
          label="Target"
          value={`${clause.target.kind}:${clause.target.id}`}
          onChange={(value) => {
            const [kind, id] = value.split(":");
            onChange({ target: { kind: kind as "device" | "group", id }, attr: "" });
          }}
          options={[
            { value: ":", label: "Choose target…" },
            ...devices
              .filter((item) => Object.values(item.attributes).some((spec) => spec.write))
              .map((item) => ({ value: `device:${item.id}`, label: names.device(item.id) })),
            ...groups.map((item) => ({ value: `group:${item.id}`, label: `All of ${item.name ?? item.id}` })),
          ]}
        />
        <Select
          label="Attribute"
          value={clause.attr}
          onChange={(value) => {
            const spec = device?.attributes[value];
            onChange({ attr: value, value: defaultValue(spec) });
          }}
          options={[
            { value: "", label: "Choose attribute…" },
            ...attributes.map((attr) => ({ value: attr, label: attrLabel(attr) })),
          ]}
        />
        <ValueWidget spec={attribute} value={clause.value} onChange={(value) => onChange({ value })} />
        <Select
          label="Revert after duration"
          value={clause.revertAfter ?? ""}
          onChange={(value) => onChange({ revertAfter: value || null })}
          options={[
            { value: "", label: "Permanent" },
            ...HOLD_CHOICES.map((value) => ({ value, label: `Revert in ${durationWords(value)}` })),
          ]}
        />
      </Row>
    </Stack>
  );
}

function ValueWidget({
  spec,
  value,
  onChange,
}: {
  spec: Attribute | undefined;
  value: Scalar;
  onChange: (next: Scalar) => void;
}) {
  if (!spec) return <Muted>Choose an attribute first</Muted>;
  if (spec.type === "boolean") {
    return (
      <Row gap={8}>
        <Label>Value</Label>
        <Switch checked={value === true} onChange={(next) => onChange(next)} label="Value" />
      </Row>
    );
  }
  if (spec.enum?.length === 2 && spec.enum.includes("ON") && spec.enum.includes("OFF")) {
    return (
      <Row gap={4}>
        <Label>Value</Label>
        <Chip active={value === "ON"} onClick={() => onChange("ON")}>
          ON
        </Chip>
        <Chip active={value === "OFF"} onClick={() => onChange("OFF")}>
          OFF
        </Chip>
      </Row>
    );
  }
  if (spec.enum?.length) {
    return (
      <Select
        label="Value"
        value={String(value)}
        onChange={(next) =>
          onChange((spec.enum?.find((option) => String(option) === next) ?? next) as Scalar)
        }
        options={spec.enum.map((option) => ({ value: String(option), label: String(option) }))}
      />
    );
  }
  if (spec.type === "number") {
    return (
      <TextField
        label={`Target value${spec.unit ? ` (${spec.unit})` : ""}`}
        type="number"
        value={String(value)}
        min={spec.limits?.[0]}
        max={spec.limits?.[1]}
        step={0.5}
        onChange={(next) => onChange(Number(next))}
      />
    );
  }
  return <TextField label="Value" value={String(value)} onChange={(next) => onChange(next)} />;
}

function ConditionFields({
  terms,
  devices,
  names,
  onChange,
}: {
  terms: Term[];
  devices: Device[];
  names: ReturnType<typeof useNames>;
  onChange: (terms: Term[]) => void;
}) {
  return (
    <Stack gap={8}>
      <Row justify="space-between">
        <Label>Conditions (Only if)</Label>
        <Button size="small" variant="text" icon="add" onClick={() => onChange([...terms, defaultTerm(devices)])}>
          Add condition
        </Button>
      </Row>
      {terms.map((term, index) => {
        const [device, attr] = term.attr;
        return (
          <Row key={`${index}-${device}-${attr}`} gap={8} wrap>
            <Select
              value={device}
              onChange={(value) => {
                const next = devices.find((item) => item.id === value);
                onChange(
                  terms.map((item, position) =>
                    position === index
                      ? {
                          ...item,
                          attr: [value, Object.keys(next?.attributes ?? {})[0] ?? ""] as [string, string],
                        }
                      : item,
                  ),
                );
              }}
              options={[
                { value: "", label: "Choose device…" },
                ...devices.map((item) => ({ value: item.id, label: names.device(item.id) })),
              ]}
            />
            <Select
              value={attr}
              onChange={(value) =>
                onChange(
                  terms.map((item, position) =>
                    position === index ? { ...item, attr: [device, value] as [string, string] } : item,
                  ),
                )
              }
              options={Object.keys(devices.find((item) => item.id === device)?.attributes ?? {}).map(
                (name) => ({ value: name, label: attrLabel(name) }),
              )}
            />
            <Select
              value={term.op}
              onChange={(value) =>
                onChange(
                  terms.map((item, position) =>
                    position === index ? { ...item, op: value as Term["op"] } : item,
                  ),
                )
              }
              options={[
                { value: "eq", label: "is equal to" },
                { value: "ne", label: "is not equal to" },
                { value: "gt", label: "is greater than" },
                { value: "ge", label: "is at least" },
                { value: "lt", label: "is less than" },
                { value: "le", label: "is at most" },
              ]}
            />
            <TextField
              value={String(term.value)}
              onChange={(next) => {
                const spec = devices.find((item) => item.id === device)?.attributes[attr];
                const value: Scalar =
                  spec?.type === "number" ? Number(next) : spec?.type === "boolean" ? next === "true" : next;
                onChange(terms.map((item, position) => (position === index ? { ...item, value } : item)));
              }}
            />
            <Button
              size="small"
              variant="danger"
              icon="delete"
              onClick={() => onChange(terms.filter((_item, position) => position !== index))}
            >
              Remove
            </Button>
          </Row>
        );
      })}
    </Stack>
  );
}

function defaultTerm(devices: Device[]): Term {
  const device = devices[0];
  const attr = Object.keys(device?.attributes ?? {})[0] ?? "";
  return { attr: [device?.id ?? "", attr], op: "eq", value: defaultValue(device?.attributes?.[attr]) };
}

function defaultValue(spec: Attribute | undefined): Scalar {
  if (!spec) return "";
  if (spec.type === "boolean") return true;
  if (spec.enum?.length) return spec.enum.includes("ON") ? "ON" : (spec.enum[0] as Scalar);
  if (spec.type === "number") return 20;
  return "";
}

function firstControllable(device: Device | undefined): string {
  if (!device) return "";
  return Object.entries(device.attributes).find(([, spec]) => spec.write)?.[0] ?? "";
}

function commonAttributes(devices: Device[], members: string[]): string[] {
  const lists = members
    .map((member) => devices.find((device) => device.id === member))
    .filter((device): device is Device => Boolean(device))
    .map((device) =>
      Object.entries(device.attributes)
        .filter(([, spec]) => spec.write)
        .map(([name]) => name),
    );
  if (!lists.length) return [];
  return lists.reduce((common, list) => common.filter((attr) => list.includes(attr)));
}

function validate(draft: Draft): string[] {
  const problems: string[] = [];
  if (!draft.name && !draft.schedule.when) problems.push("Please provide a name or trigger.");
  if (draft.schedule.then.length === 0) problems.push("Please add at least one action.");
  for (const clause of draft.schedule.then) {
    if (!clause.target.id || !clause.attr) problems.push("Every action must specify a target device and attribute.");
  }
  return problems;
}
