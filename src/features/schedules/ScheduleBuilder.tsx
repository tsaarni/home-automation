import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { useDevices, useGroups, useNames, useSaveRule } from "@/api/queries";
import type { Attribute, Device, Group, Rule, Scalar, Term } from "@/api/types";
import {
  Badge,
  Button,
  Chip,
  Dialog,
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
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  section: {
    borderColor: tokens.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: tokens.radiusSm,
    padding: tokens.space3,
    display: "flex",
    flexDirection: "column",
    gap: tokens.space3,
  },
  clause: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.space2,
    paddingTop: tokens.space2,
    borderTopColor: tokens.border,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  sentence: { fontSize: tokens.fontLg, fontWeight: 600 },
  problem: { color: tokens.bad, fontSize: tokens.fontSm },
});

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

/** A placeholder document for a brand new schedule; `applySchedule` overwrites when/then. */
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

/** The three-section builder (§5.2). Everything it cannot show opens in raw mode instead. */
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

  const problems = useMemo(() => validate(draft, devices), [draft, devices]);
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
      problems.push(`not valid JSON: ${(error as Error).message}`);
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
      title={rule ? `Edit: ${rule.name ?? rule.id}` : "New schedule"}
      onClose={onClose}
      footer={
        <>
          {problems.length ? <span {...stylex.props(styles.problem)}>{problems[0]}</span> : null}
          <Button variant="ghost" onClick={onClose}>
            cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={save.isPending || (!rawMode && problems.length > 0)}
          >
            save
          </Button>
        </>
      }
    >
      {rawReasons.length ? (
        <Badge tone="warn">This schedule uses {rawReasons.join(", ")} — edit it as JSON below.</Badge>
      ) : null}

      {!rawMode ? (
        <>
          <div {...stylex.props(styles.sentence)}>{description.sentence}</div>

          <div {...stylex.props(styles.section)}>
            <strong>When</strong>
            <Row gap={2} wrap>
              {(
                [
                  ["at", "At a time"],
                  ["sun", "At sun"],
                  ["state", "When a reading changes"],
                  ["every", "Every"],
                ] as const
              ).map(([key, label]) => (
                <Chip
                  key={key}
                  active={kindOfTrigger(draft.schedule.when) === key}
                  onClick={() => updateTrigger(switchTrigger(draft.schedule.when, key))}
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

            <Row gap={3} wrap>
              <Row gap={2}>
                <Switch checked={draft.once} onChange={(next) => update({ once: next })} label="one-shot" />
                <span>One-shot: delete this schedule after it runs</span>
              </Row>
            </Row>
          </div>

          <div {...stylex.props(styles.section)}>
            <Row justify="space-between">
              <strong>Do</strong>
              <Button
                size="small"
                variant="ghost"
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
                + add action
              </Button>
            </Row>

            {draft.schedule.then.map((clause, index) => (
              <div key={`${clause.target.id}-${clause.attr}-${index}`} {...stylex.props(styles.clause)}>
                <ClauseFields
                  clause={clause}
                  devices={devices}
                  groups={groups}
                  names={names}
                  onChange={(patch) => updateClause(index, patch)}
                />
                {draft.schedule.then.length > 1 ? (
                  <Row>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() =>
                        update({
                          schedule: {
                            ...draft.schedule,
                            then: draft.schedule.then.filter((_item, position) => position !== index),
                          },
                        })
                      }
                    >
                      remove
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
              <Row gap={2}>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() =>
                    update({ schedule: { ...draft.schedule, onlyIf: { terms: [defaultTerm(devices)] } } })
                  }
                >
                  + only if…
                </Button>
                <Muted>the action only happens when this is true</Muted>
              </Row>
            )}

            <Row gap={2} wrap>
              <Select
                label="stays that way for"
                value={draft.schedule.hold ?? ""}
                onChange={(value) => update({ schedule: { ...draft.schedule, hold: value || null } })}
                options={[
                  { value: "", label: "immediately" },
                  ...DURATION_CHOICES.map((value) => ({ value, label: durationWords(value) })),
                ]}
              />
              <Muted>wait this long before doing it, cancelling if the condition stops holding</Muted>
            </Row>
          </div>
        </>
      ) : null}

      <div {...stylex.props(styles.section)}>
        <strong>Name &amp; save</strong>
        <TextField
          label="name"
          value={draft.name}
          onChange={(value) => update({ name: value })}
          placeholder={suggestedName}
        />
        <TextField
          label="notes"
          value={draft.description}
          onChange={(value) => update({ description: value })}
        />
        <Row gap={3} wrap>
          <Row gap={2}>
            <Switch checked={draft.enabled} onChange={(next) => update({ enabled: next })} label="enabled" />
            <span>enabled</span>
          </Row>
          <Muted>id: {draft.id || slugify(draft.name || suggestedName)}</Muted>
        </Row>

        <Row gap={2}>
          <Button size="small" variant="ghost" onClick={() => setRawMode(!rawMode)}>
            {rawMode ? "back to the builder" : "advanced: raw JSON"}
          </Button>
          {rule ? (
            <Muted>the builder never drops fields it does not show; the raw document is kept as-is</Muted>
          ) : null}
        </Row>

        {rawMode ? (
          <textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={18}
            {...stylex.props(styles.section)}
            style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
          />
        ) : (
          <Row gap={3} wrap>
            <TextField
              label="priority"
              type="number"
              value={String(draft.priority)}
              onChange={(value) => update({ priority: Number(value) || 0 })}
            />
            <TextField
              label="rate limit (s)"
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
      <Stack gap={3}>
        <Row gap={2} wrap>
          {trigger.solar ? (
            <Select
              label="at"
              value={trigger.at}
              onChange={(value) => onChange({ ...trigger, at: value })}
              options={SOLAR_EVENTS.map((event) => ({ value: event, label: event }))}
            />
          ) : (
            <TextField
              label="at"
              type="time"
              value={trigger.at}
              onChange={(value) => onChange({ ...trigger, at: value })}
            />
          )}
          {trigger.solar ? (
            <TextField
              label="offset (± 30m)"
              value={trigger.offset ?? ""}
              onChange={(value) => onChange({ ...trigger, offset: value || null })}
              placeholder="-30m"
            />
          ) : null}
        </Row>
        {!trigger.solar ? (
          <Row gap={1} wrap>
            <Label>days</Label>
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
            <Button size="small" variant="ghost" onClick={() => onChange({ ...trigger, days: [] })}>
              every day
            </Button>
          </Row>
        ) : null}
        {trigger.solar ? (
          <Muted>The exact time comes from the backend after saving (sun position, not the browser).</Muted>
        ) : null}
      </Stack>
    );
  }

  if (trigger.kind === "state") {
    const device = devices.find((item) => item.id === trigger.device);
    return (
      <Stack gap={3}>
        <Row gap={2} wrap>
          <Select
            label="thing"
            value={trigger.device}
            onChange={(value) => {
              const next = devices.find((item) => item.id === value);
              onChange({ ...trigger, device: value, attr: next ? Object.keys(next.attributes)[0] : "" });
            }}
            options={[
              { value: "", label: "choose…" },
              ...devices.map((item) => ({ value: item.id, label: names.device(item.id) })),
            ]}
          />
          <Select
            label="reading"
            value={trigger.attr}
            onChange={(value) => onChange({ ...trigger, attr: value })}
            options={[
              { value: "", label: "choose…" },
              ...Object.keys(device?.attributes ?? {}).map((attr) => ({
                value: attr,
                label: attrLabel(attr),
              })),
            ]}
          />
        </Row>
        <Row gap={2} wrap>
          <Chip active={trigger.changed} onClick={() => onChange({ ...trigger, changed: true })}>
            only when it changes
          </Chip>
          <Chip active={!trigger.changed} onClick={() => onChange({ ...trigger, changed: false })}>
            every report
          </Chip>
        </Row>
      </Stack>
    );
  }

  return (
    <Row gap={2} wrap>
      <TextField
        label="every"
        value={trigger.every}
        onChange={(value) => onChange({ ...trigger, every: value })}
      />
      <Row gap={1}>
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
    <Stack gap={2}>
      <Row gap={2} wrap>
        <Select
          label="target"
          value={`${clause.target.kind}:${clause.target.id}`}
          onChange={(value) => {
            const [kind, id] = value.split(":");
            onChange({ target: { kind: kind as "device" | "group", id }, attr: "" });
          }}
          options={[
            { value: ":", label: "choose…" },
            ...devices
              .filter((item) => Object.values(item.attributes).some((spec) => spec.write))
              .map((item) => ({ value: `device:${item.id}`, label: names.device(item.id) })),
            ...groups.map((item) => ({ value: `group:${item.id}`, label: `all of ${item.name ?? item.id}` })),
          ]}
        />
        <Select
          label="reading"
          value={clause.attr}
          onChange={(value) => {
            const spec = device?.attributes[value];
            onChange({ attr: value, value: defaultValue(spec) });
          }}
          options={[
            { value: "", label: "choose…" },
            ...attributes.map((attr) => ({ value: attr, label: attrLabel(attr) })),
          ]}
        />
        <ValueWidget spec={attribute} value={clause.value} onChange={(value) => onChange({ value })} />
        <Select
          label="then restore"
          value={clause.revertAfter ?? ""}
          onChange={(value) => onChange({ revertAfter: value || null })}
          options={[
            { value: "", label: "never" },
            ...HOLD_CHOICES.map((value) => ({ value, label: `after ${durationWords(value)}` })),
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
  if (!spec) return <Muted>choose a reading</Muted>;
  if (spec.type === "boolean") {
    return (
      <Row gap={2}>
        <Label>value</Label>
        <Switch checked={value === true} onChange={(next) => onChange(next)} label="value" />
      </Row>
    );
  }
  if (spec.enum?.length === 2 && spec.enum.includes("ON") && spec.enum.includes("OFF")) {
    return (
      <Row gap={2}>
        <Label>value</Label>
        <Chip active={value === "ON"} onClick={() => onChange("ON")}>
          on
        </Chip>
        <Chip active={value === "OFF"} onClick={() => onChange("OFF")}>
          off
        </Chip>
      </Row>
    );
  }
  if (spec.enum?.length) {
    return (
      <Select
        label="value"
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
        label={`value${spec.unit ? ` (${spec.unit})` : ""}`}
        type="number"
        value={String(value)}
        min={spec.limits?.[0]}
        max={spec.limits?.[1]}
        step={0.5}
        onChange={(next) => onChange(Number(next))}
      />
    );
  }
  return <TextField label="value" value={String(value)} onChange={(next) => onChange(next)} />;
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
    <Stack gap={2}>
      <Row justify="space-between">
        <Label>Only if</Label>
        <Button size="small" variant="ghost" onClick={() => onChange([...terms, defaultTerm(devices)])}>
          + add condition
        </Button>
      </Row>
      {terms.map((term, index) => {
        const [device, attr] = term.attr;
        return (
          <Row key={`${index}-${device}-${attr}`} gap={2} wrap>
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
                { value: "", label: "choose…" },
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
                { value: "eq", label: "is" },
                { value: "ne", label: "is not" },
                { value: "gt", label: "is above" },
                { value: "ge", label: "is at least" },
                { value: "lt", label: "is below" },
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
              variant="ghost"
              onClick={() => onChange(terms.filter((_item, position) => position !== index))}
            >
              remove
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

/** Builder-side hints mirroring the backend validation (§7.1). */
function validate(draft: Draft, devices: Device[]): string[] {
  const problems: string[] = [];
  const { schedule } = draft;
  if (!schedule.then.length) problems.push("add at least one action");
  for (const clause of schedule.then) {
    if (!clause.target.id) problems.push("choose a target for every action");
    if (!clause.attr) problems.push("choose a reading for every action");
  }
  if (schedule.when.kind === "state" && (!schedule.when.device || !schedule.when.attr))
    problems.push("choose the reading that triggers this schedule");
  if (schedule.when.kind === "every" && !/^\d+(\.\d+)?[smhdw]$/.test(schedule.when.every))
    problems.push('write the interval like "15m" or "2h"');
  if (
    schedule.when.kind === "at" &&
    !schedule.when.solar &&
    !/^([01]?\d|2[0-3]):[0-5]\d$/.test(schedule.when.at)
  )
    problems.push("write the time as HH:MM");
  if (schedule.hold && !/^\d+(\.\d+)?[smhdw]$/.test(schedule.hold))
    problems.push('write the hold as "3h" or "30m"');
  for (const clause of schedule.then) {
    if (clause.revertAfter && !/^\d+(\.\d+)?[smhdw]$/.test(clause.revertAfter))
      problems.push('write the restore delay as "4h" or "30m"');
    const device = devices.find((item) => item.id === clause.target.id);
    const spec = device?.attributes[clause.attr];
    if (
      spec?.limits &&
      typeof clause.value === "number" &&
      (clause.value < spec.limits[0] || clause.value > spec.limits[1])
    ) {
      problems.push(`${attrLabel(clause.attr)} must be between ${spec.limits[0]} and ${spec.limits[1]}`);
    }
  }
  if (draft.rateLimit < 0) problems.push("the rate limit cannot be negative");
  return problems;
}
