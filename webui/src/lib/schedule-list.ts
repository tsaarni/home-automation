import type { Rule } from "@/api/types";
import type { TimeHelpers } from "./format";

export function nextTime(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Group by house-local calendar day, sorting instants rather than clock labels. */
export function groupByNext(
  rules: Rule[],
  due: Record<string, string | null | undefined>,
  time: TimeHelpers,
  now = new Date(),
) {
  const sections = [
    "Due now",
    "Today",
    "Tomorrow",
    "Later",
    "Next time unavailable",
    "On change / event",
    "Disabled",
  ];
  const blocks = sections.map((label) => ({ id: label, label, rules: [] as Rule[] }));
  for (const rule of rules) {
    const next = nextTime(due[rule.id]);
    let section: number;
    if (!rule.enabled) section = 6;
    else if (rule.when.device) section = 5;
    else if (!next) section = 4;
    else if (Date.parse(next) <= now.getTime()) section = 0;
    else {
      const days = time.dayDifference(next, now);
      section = days === 0 ? 1 : days === 1 ? 2 : 3;
    }
    blocks[section].rules.push(rule);
  }
  for (const [index, block] of blocks.entries()) {
    block.rules.sort((a, b) => {
      if (index < 4) {
        const difference = Date.parse(due[a.id]!) - Date.parse(due[b.id]!);
        if (difference) return difference;
      }
      return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
    });
  }
  return blocks.filter((block) => block.rules.length);
}
