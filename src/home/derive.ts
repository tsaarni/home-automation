import type { Device, Group, Rule } from "@/api/types";
import { displayUnit } from "@/lib/format";
import {
  ATTR_LABELS,
  type ControlKind,
  humanize,
  kindOf,
  NOISY_ATTRIBUTES,
  PRIMARY_PREFERENCE,
  roomOf,
  rooms,
  type ThingKind,
  things,
} from "./model";

export interface Reading {
  device: string;
  attr: string;
  label: string;
  value: unknown;
  unit: string | null;
  ts: string | null;
  source: string | null;
  known: boolean;
  /** the value the action should write, for switch-style controls */
  on?: unknown;
  off?: unknown;
  min?: number | null;
  max?: number | null;
  step?: number;
  /** quick "on for ..." choices, in the house's units */
  hold?: boolean;
  options?: unknown[];
  /** schedules that write this attribute */
  schedules: string[];
  isControl: boolean;
}

export interface Thing {
  id: string;
  name: string;
  room: string;
  kind: ThingKind;
  locked: boolean;
  readings: Reading[];
  primary: Reading[];
  controls: Reading[];
  /** true when nothing has been reported yet (fresh boot) */
  waiting: boolean;
  referencedBy: string[];
}

export interface RoomView {
  id: string;
  name: string;
  order: number;
  things: Thing[];
}

export interface Home {
  rooms: RoomView[];
  things: Thing[];
  byDevice: Map<string, Thing>;
  /** device -> every rule (enabled or not) that writes one of its attributes */
  rulesByTarget: Map<string, Rule[]>;
}

export function attrLabel(attr: string): string {
  return ATTR_LABELS[attr] ?? humanize(attr);
}

function controlKind(device: Device, attr: string): ControlKind {
  const curated = things[device.id]?.controls.find((control) => control.attr === attr);
  if (curated) return curated.kind;
  const spec = device.attributes[attr];
  if (!spec) return "text";
  if (spec.type === "boolean") return "boolean";
  if (spec.enum) {
    if (spec.enum.length === 2 && spec.enum.includes("ON") && spec.enum.includes("OFF")) return "switch";
    return "select";
  }
  if (spec.type === "number") return spec.unit === "C" ? "temperature" : "number";
  return "text";
}

/** The value a switch-style control writes when turned on / off. */
function switchValues(device: Device, attr: string): { on: unknown; off: unknown } {
  const spec = device.attributes[attr];
  const curated = things[device.id]?.controls.find((control) => control.attr === attr);
  if (curated?.on !== undefined) return { on: curated.on, off: curated.off };
  if (spec?.enum?.length === 2) return { on: spec.enum[0], off: spec.enum[1] };
  if (spec?.type === "boolean") return { on: true, off: false };
  return { on: 1, off: 0 };
}

/** Build the room/thing model from the backend's device, rule and group payloads. */
export function buildHome(devices: Device[], rules: Rule[], _groups: Group[]): Home {
  const writersByAttribute = new Map<string, string[]>();
  const rulesByTarget = new Map<string, Rule[]>();
  for (const rule of rules) {
    for (const action of rule.then) {
      const target = action.set?.device ?? action.set_curve?.device;
      const attr = action.set?.attr ?? action.set_curve?.attr;
      if (!target) continue;
      const targetRules = rulesByTarget.get(target) ?? [];
      if (!targetRules.some((item) => item.id === rule.id)) targetRules.push(rule);
      rulesByTarget.set(target, targetRules);
      if (!attr) continue;
      const key = `${target}\u0000${attr}`;
      const list = writersByAttribute.get(key) ?? [];
      if (!list.includes(rule.id)) list.push(rule.id);
      writersByAttribute.set(key, list);
    }
  }

  const built: Thing[] = devices.map((device) => {
    const meta = things[device.id];
    const hidden = new Set([...(meta?.hide ?? []), ...NOISY_ATTRIBUTES]);
    const attrs = Object.keys(device.attributes);
    const allHidden = !meta && attrs.length > 0 && attrs.every((attr) => hidden.has(attr));
    const ordered = [...new Set([...(meta?.primary ?? []), ...PRIMARY_PREFERENCE, ...attrs])].filter((attr) =>
      attrs.includes(attr),
    );

    const readings: Reading[] = [];
    for (const attr of ordered) {
      const isCurated =
        meta?.primary?.includes(attr) || meta?.controls?.some((control) => control.attr === attr);
      if (hidden.has(attr) && !isCurated && !allHidden) continue;
      const spec = device.attributes[attr];
      if (!spec) continue;
      const state = device.state[attr];
      const isControl = Boolean(spec.write) && !device.locked;
      const switches = switchValues(device, attr);
      const curatedControl = meta?.controls.find((control) => control.attr === attr);
      readings.push({
        device: device.id,
        attr,
        label: meta?.labels?.[attr] ?? curatedControl?.label ?? attrLabel(attr),
        value: state?.value,
        unit: displayUnit(spec.unit),
        ts: state?.ts ?? null,
        source: state?.source ?? null,
        known: state !== undefined,
        on: switches.on,
        off: switches.off,
        min: spec.limits?.[0] ?? null,
        max: spec.limits?.[1] ?? null,
        step: curatedControl?.step ?? 0.5,
        hold: curatedControl?.hold,
        options: spec.enum ?? undefined,
        schedules: writersByAttribute.get(`${device.id}\u0000${attr}`) ?? [],
        isControl,
      });
    }

    const curatedPrimary = (meta?.primary ?? []).filter((attr) =>
      readings.some((reading) => reading.attr === attr),
    );
    const primary = curatedPrimary.length
      ? readings.filter((reading) => curatedPrimary.includes(reading.attr))
      : readings.slice(0, 2);

    const controls: Reading[] = meta?.controls
      ? meta.controls.flatMap((control) => {
          const reading = readings.find((r) => r.attr === control.attr);
          if (!reading || !reading.isControl) return [];
          return [
            {
              ...reading,
              label: control.label ?? reading.label,
              step: control.step ?? reading.step,
              on: control.on ?? reading.on,
              off: control.off ?? reading.off,
              hold: control.hold ?? reading.hold,
            },
          ];
        })
      : readings.filter((reading) => reading.isControl);

    return {
      id: device.id,
      name: meta?.name ?? device.name ?? humanize(device.id),
      room: meta?.room ?? roomOf(device.id),
      kind: kindOf(device.id),
      locked: device.locked,
      readings,
      primary,
      controls,
      waiting: readings.every((reading) => !reading.known),
      referencedBy: device.referenced_by,
    };
  });

  const byRoom = new Map<string, Thing[]>();
  for (const thing of built) {
    const list = byRoom.get(thing.room) ?? [];
    list.push(thing);
    byRoom.set(thing.room, list);
  }

  const roomViews: RoomView[] = rooms
    .filter((room) => byRoom.has(room.id))
    .map((room) => ({
      id: room.id,
      name: room.name,
      order: room.order,
      things: (byRoom.get(room.id) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    }));

  return {
    rooms: roomViews,
    things: built.slice().sort((a, b) => a.name.localeCompare(b.name)),
    byDevice: new Map(built.map((thing) => [thing.id, thing])),
    rulesByTarget,
  };
}

/** The control kinds a widget can render (kept next to the deriver for the builder). */
export function widgetKind(device: Device, attr: string): ControlKind {
  return controlKind(device, attr);
}
