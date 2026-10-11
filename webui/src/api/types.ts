import { z } from "zod";

/** Scalars the backend documents can hold in `value` slots. */
export const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof scalarSchema>;

export const valueRefSchema = z.object({ device: z.string(), attr: z.string() });
export type ValueRef = z.infer<typeof valueRefSchema>;

/** A literal or a reference to another attribute (only literals are editable in the builder). */
export const actionValueSchema = z.union([valueRefSchema, scalarSchema]);
export type ActionValue = z.infer<typeof actionValueSchema>;

export const attributeSchema = z
  .object({
    read: z.object({ topic: z.string(), path: z.string().nullish() }).nullish(),
    write: z
      .object({ topic: z.string(), payload: z.unknown().optional(), retain: z.boolean().optional() })
      .nullish(),
    type: z.enum(["number", "string", "boolean"]).default("string"),
    unit: z.string().nullish(),
    limits: z.tuple([z.number(), z.number()]).nullish(),
    enum: z.array(z.unknown()).nullish(),
    scale: z.number().optional(),
    offset: z.number().optional(),
    default: z.unknown().optional(),
  })
  .loose();
export type Attribute = z.infer<typeof attributeSchema>;

export const stateValueSchema = z.object({
  value: z.unknown(),
  ts: z.string(),
  source: z.string(),
});
export type StateValue = z.infer<typeof stateValueSchema>;

export const deviceSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    locked: z.boolean().default(false),
    attributes: z.record(z.string(), attributeSchema),
    command: z
      .object({ topic: z.string(), state_topic: z.string(), result_topic: z.string() })
      .loose()
      .nullish(),
    pending: z
      .record(z.string(), z.object({ request_id: z.string(), value: z.unknown(), status: z.string() }))
      .optional(),
    availability: z.object({ available: z.boolean(), reason: z.string().nullish() }).loose().optional(),
    command_results: z
      .record(z.string(), z.object({ status: z.string(), reason: z.string().nullish() }).loose())
      .optional(),
    state: z.record(z.string(), stateValueSchema).default({}),
    referenced_by: z.array(z.string()).default([]),
  })
  .loose();
export type Device = z.infer<typeof deviceSchema>;

export const groupSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    members: z.array(z.string()),
    referenced_by: z.array(z.string()).default([]),
  })
  .loose();
export type Group = z.infer<typeof groupSchema>;

export const termSchema = z
  .object({
    attr: z.tuple([z.string(), z.string()]),
    op: z.enum(["eq", "ne", "gt", "ge", "lt", "le"]),
    value: actionValueSchema,
  })
  .loose();
export type Term = z.infer<typeof termSchema>;

export const conditionSchema = z
  .object({
    all: z.array(termSchema).optional(),
    any: z.array(termSchema).optional(),
  })
  .loose();
export type Condition = z.infer<typeof conditionSchema>;

export const whenSchema = z
  .object({
    device: z.string().nullish(),
    attr: z.string().nullish(),
    changed: z.boolean().optional(),
    at: z.string().nullish(),
    offset: z.string().nullish(),
    days: z.array(z.string()).nullish(),
    every: z.string().nullish(),
  })
  .loose();
export type When = z.infer<typeof whenSchema>;

export const setActionSchema = z
  .object({
    device: z.string().nullish(),
    group: z.string().nullish(),
    attr: z.string(),
    value: actionValueSchema,
    revert_after: z.string().nullish(),
  })
  .loose();
export type SetAction = z.infer<typeof setActionSchema>;

export const curveActionSchema = z
  .object({
    device: z.string().nullish(),
    group: z.string().nullish(),
    attr: z.string(),
    x: valueRefSchema,
    points: z.array(z.tuple([z.number(), z.number()])),
  })
  .loose();
export type CurveAction = z.infer<typeof curveActionSchema>;

export const publishActionSchema = z
  .object({
    topic: z.string(),
    payload: z.unknown().optional(),
    retain: z.boolean().optional(),
  })
  .loose();
export type PublishAction = z.infer<typeof publishActionSchema>;

export const actionSchema = z
  .object({
    set: setActionSchema.nullish(),
    set_curve: curveActionSchema.nullish(),
    publish: publishActionSchema.nullish(),
  })
  .loose();
export type Action = z.infer<typeof actionSchema>;

export const ruleSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    enabled: z.boolean().default(true),
    priority: z.number().default(0),
    once: z.boolean().default(false),
    when: whenSchema,
    if: conditionSchema.nullish(),
    for: z.string().nullish(),
    then: z.array(actionSchema).min(1),
    rate_limit: z.number().optional(),
  })
  .loose();
export type Rule = z.infer<typeof ruleSchema>;

export const timerSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    device: z.string().nullish(),
    attr: z.string().nullish(),
    value: z.unknown().optional(),
    overridden_value: z.unknown().optional(),
    rule: z.string().nullish(),
    trigger: z.unknown().optional(),
    created_at: z.string().nullish(),
    due_at: z.string().nullish(),
  })
  .loose();
export type Timer = z.infer<typeof timerSchema>;

export const timersSchema = z.object({
  timers: z.array(timerSchema),
  next_due: z.record(z.string(), z.string().nullish()),
});
export type Timers = z.infer<typeof timersSchema>;

export const readySchema = z
  .object({
    status: z.string(),
    version: z.string(),
    dry_run: z.boolean(),
    mqtt_enabled: z.boolean(),
    mqtt_connected: z.boolean(),
    data_dir: z.string().optional(),
    timezone: z.string().default("UTC"),
    started_at: z.string().nullish(),
    uptime_seconds: z.number().optional(),
    devices: z.number().optional(),
    groups: z.number().optional(),
    rules: z.number().optional(),
    pending_timers: z.number().optional(),
    state_values: z.number().optional(),
    config_version: z.number().optional(),
    warnings: z.array(z.string()).default([]),
  })
  .loose();
export type Ready = z.infer<typeof readySchema>;

export const eventSchema = z
  .object({
    ts: z.string(),
    type: z.string(),
    rule: z.string().nullish(),
    // a list of rule ids (conflict) or a plain count (boot) — the backend uses both
    rules: z.union([z.number(), z.array(z.string())]).nullish(),
    device: z.string().nullish(),
    attr: z.string().nullish(),
    value: z.unknown().optional(),
    previous: z.unknown().optional(),
    source: z.string().nullish(),
    status: z.string().nullish(),
    reason: z.string().nullish(),
    error: z.string().nullish(),
    kind: z.string().nullish(),
    action: z.string().nullish(),
    due_at: z.string().nullish(),
    trigger: z.unknown().optional(),
    writes: z.number().optional(),
    publishes: z.number().optional(),
    topic: z.string().nullish(),
    payload: z.unknown().optional(),
    version: z.string().optional(),
    dry_run: z.boolean().optional(),
    enabled: z.boolean().optional(),
    warnings: z.array(z.string()).optional(),
    terms: z.array(z.unknown()).optional(),
    unknown: z.array(z.unknown()).optional(),
    late_seconds: z.number().optional(),
    limit: z.number().optional(),
  })
  .loose();
export type Event = z.infer<typeof eventSchema>;

export const writeResultSchema = z
  .object({
    device: z.string(),
    attr: z.string(),
    value: z.unknown().optional(),
    previous: z.unknown().optional(),
    status: z.string(),
    reason: z.string().nullish(),
    rule: z.string().nullish(),
    source: z.string().nullish(),
    topic: z.string().nullish(),
  })
  .loose();
export type WriteResult = z.infer<typeof writeResultSchema>;

export const writeResponseSchema = z.object({ results: z.array(writeResultSchema) });

export const testReportSchema = z
  .object({
    rule: z.string(),
    trigger: z.object({ kind: z.string() }).loose(),
    condition: z.object({
      satisfied: z.boolean(),
      unknown: z.array(z.string()),
      terms: z.array(z.unknown()),
    }),
    deferred_seconds: z.number(),
    rate_limited: z.boolean(),
    writes: z.array(writeResultSchema),
    publishes: z.array(z.object({ topic: z.string(), payload: z.unknown(), retain: z.boolean() }).loose()),
  })
  .loose();
export type TestReport = z.infer<typeof testReportSchema>;

/** `GET /api/v1/state`: device id -> attribute -> value. */
export const stateSnapshotSchema = z.record(z.string(), z.record(z.string(), stateValueSchema));
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

export type { Action as RuleAction };
