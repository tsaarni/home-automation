import type { Device, Group, Rule } from "@/api/types";
import { ATTR_LABELS, humanize, things } from "@/home/model";
import { displayUnit, formatNumber, formatValue } from "@/lib/format";

/** Z-Wave thermostat mode values (the enum the devices actually report). */
const MODE_LABELS: Record<string, string> = { "0": "off", "1": "heat", "2": "cool", "11": "auto" };

export interface Names {
  rule: (id: string | null | undefined) => string;
  device: (id: string | null | undefined) => string;
  group: (id: string | null | undefined) => string;
  attr: (device: string, attr: string) => string;
  value: (device: string | null | undefined, attr: string | null | undefined, value: unknown) => string;
  unit: (device: string | null | undefined, attr: string | null | undefined) => string | null;
}

/** Resolve ids to the words a person uses: thing names, attribute labels, formatted values. */
export function makeNames(devices: Device[], rules: Rule[], groups: Group[]): Names {
  const byDevice = new Map(devices.map((device) => [device.id, device]));
  const byRule = new Map(rules.map((rule) => [rule.id, rule]));
  const byGroup = new Map(groups.map((group) => [group.id, group]));

  const device = (id: string | null | undefined): string => {
    if (!id) return "unknown device";
    const curated = things[id]?.name;
    if (curated) return curated;
    const doc = byDevice.get(id);
    if (doc?.name) return doc.name;
    return humanize(id);
  };

  return {
    rule: (id) => {
      if (!id) return "a schedule";
      return byRule.get(id)?.name ?? humanize(id);
    },
    device,
    group: (id) => {
      if (!id) return "a group";
      return byGroup.get(id)?.name ?? humanize(id);
    },
    attr: (deviceId, attribute) => {
      const curated =
        things[deviceId]?.labels?.[attribute] ??
        things[deviceId]?.controls.find((control) => control.attr === attribute)?.label;
      return curated ?? ATTR_LABELS[attribute] ?? humanize(attribute);
    },
    unit: (deviceId, attribute) => {
      if (!deviceId || !attribute) return null;
      return byDevice.get(deviceId)?.attributes[attribute]?.unit ?? null;
    },
    value: (deviceId, attribute, value) => {
      const spec = deviceId && attribute ? byDevice.get(deviceId)?.attributes[attribute] : undefined;
      if (spec) {
        if (attribute === "mode" && spec.enum && MODE_LABELS[String(value)])
          return MODE_LABELS[String(value)];
        if (spec.enum?.length === 2 && spec.enum.includes("ON") && spec.enum.includes("OFF")) {
          return value === "ON" ? "on" : "off";
        }
        const unit = displayUnit(spec.unit);
        if (typeof value === "number") {
          const text = formatNumber(value);
          return unit ? `${text} ${unit}` : text;
        }
        return formatValue(value, unit);
      }
      return formatValue(value, null);
    },
  };
}
