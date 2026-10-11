import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { buildHome } from "@/home/derive";
import { makeNames, type Names } from "@/home/names";
import { durationWords, makeTime, type TimeHelpers } from "@/lib/format";
import { writeSentence } from "@/lib/reasons";
import { notify } from "@/lib/toast";
import { ApiError, api, type WriteBody } from "./client";
import { pollEvents } from "./events";
import type {
  Device,
  Event,
  Group,
  Ready,
  Rule,
  StateSnapshot,
  TestReport,
  Timers,
  WriteResult,
} from "./types";

export const keys = {
  ready: ["ready"] as const,
  state: ["state"] as const,
  devices: ["devices"] as const,
  groups: ["groups"] as const,
  rules: ["rules"] as const,
  timers: ["timers"] as const,
  events: ["events"] as const,
};

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Health, warnings, counts and the house timezone. */
export function useReady() {
  return useQuery({ queryKey: keys.ready, queryFn: api.readyz, refetchInterval: 5000, retry: 1 });
}

/** Every device/attribute value, one call, every 2 s. */
export function useStateSnapshot() {
  return useQuery({ queryKey: keys.state, queryFn: api.state, refetchInterval: 2000 });
}

export function useDevices() {
  return useQuery({ queryKey: keys.devices, queryFn: api.devices, refetchInterval: 60000 });
}

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: api.groups, refetchInterval: 60000 });
}

export function useRules() {
  return useQuery({ queryKey: keys.rules, queryFn: api.rules, refetchInterval: 30000 });
}

/** Pending timers and each armed schedule's next fire. */
export function useTimers() {
  return useQuery({ queryKey: keys.timers, queryFn: api.timers, refetchInterval: 5000 });
}

/** The rolling event window: a full slice once, then deltas. */
export function useEvents() {
  return useQuery({ queryKey: keys.events, queryFn: pollEvents, refetchInterval: 2000 });
}

export function useTime(): TimeHelpers {
  const { data } = useReady();
  const zone = data?.timezone ?? browserZone;
  return useMemo(() => makeTime(zone), [zone]);
}

/** Ids to words: thing names, attribute labels, formatted values. */
export function useNames(): Names {
  const devices = useDevices().data ?? [];
  const rules = useRules().data ?? [];
  const groups = useGroups().data ?? [];
  return useMemo(() => makeNames(devices, rules, groups), [devices, rules, groups]);
}

export function useHome() {
  const devices = useDevices().data ?? [];
  const groups = useGroups().data ?? [];
  const rules = useRules().data ?? [];
  return useMemo(() => buildHome(devices, rules, groups), [devices, rules, groups]);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problems.join("; ") || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface WriteTarget {
  kind: "device" | "group";
  id: string;
}

export interface WriteVars {
  target: WriteTarget;
  body: WriteBody;
}

/**
 * Manual control writes: optimistic (the switch flips immediately), reconciled by the poll
 * or the response's status, rolled back with a toast on failure (§6.4).
 */
export function useSetValue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, body }: WriteVars): Promise<WriteResult[]> =>
      target.kind === "device" ? api.setDevice(target.id, body) : api.setGroup(target.id, body),
    onMutate: async ({ target, body }) => {
      if (target.kind !== "device") return { previous: undefined as StateSnapshot | undefined };
      await queryClient.cancelQueries({ queryKey: keys.state });
      const previous = queryClient.getQueryData<StateSnapshot>(keys.state);
      if (previous) {
        const next: StateSnapshot = structuredClone(previous);
        const device = next[target.id] ?? (next[target.id] = {});
        for (const [attr, value] of Object.entries(body)) {
          if (attr === "revert_after") continue;
          device[attr] = { value, ts: new Date().toISOString(), source: "manual" };
        }
        queryClient.setQueryData(keys.state, next);
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(keys.state, context.previous);
      notify("bad", errorMessage(error));
    },
    onSuccess: (results, { body }) => {
      const bad = results.find((result) => result.status === "error" || result.status === "skipped");
      if (bad) {
        notify("bad", bad.reason ? bad.reason.replace(/[_-]+/g, " ") : "the device refused the change");
        return;
      }
      if (results.every((result) => result.status === "unchanged")) {
        notify("info", "that is already the value");
        return;
      }
      if (results.some((result) => result.status === "dry-run")) {
        notify("info", "dry run: nothing was sent to the device");
        return;
      }
      if (body.revert_after) notify("ok", `done — it goes back ${durationWords(body.revert_after)} from now`);
      else notify("ok", "done");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: keys.state });
      queryClient.invalidateQueries({ queryKey: keys.timers });
      queryClient.invalidateQueries({ queryKey: keys.events });
    },
  });
}

/** Restore now: write back the value an override would have restored (§5.1). */
export function useRestoreOverride() {
  const setValue = useSetValue();
  return (timer: { device?: string | null; attr?: string | null; value?: unknown }) => {
    if (!timer.device || !timer.attr || timer.value === undefined) return;
    setValue.mutate({
      target: { kind: "device", id: timer.device },
      body: { [timer.attr]: timer.value as never },
    });
  };
}

function useRuleInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: keys.rules });
    queryClient.invalidateQueries({ queryKey: keys.timers });
    queryClient.invalidateQueries({ queryKey: keys.devices });
    queryClient.invalidateQueries({ queryKey: keys.events });
  };
}

export function useSaveRule() {
  const invalidate = useRuleInvalidation();
  return useMutation({
    mutationFn: (rule: Rule) => api.putRule(rule),
    onSuccess: (rule) => {
      notify("ok", `${rule.name ?? rule.id} saved`);
      invalidate();
    },
    onError: (error) => notify("bad", errorMessage(error)),
  });
}

export function useDeleteRule() {
  const invalidate = useRuleInvalidation();
  return useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: () => {
      notify("ok", "schedule deleted");
      invalidate();
    },
    onError: (error) => notify("bad", errorMessage(error)),
  });
}

export function useToggleRule() {
  const invalidate = useRuleInvalidation();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setRuleEnabled(id, enabled),
    onSuccess: (rule) => {
      notify("ok", `${rule.name ?? rule.id} ${rule.enabled ? "enabled" : "disabled"}`);
      invalidate();
    },
    onError: (error) => notify("bad", errorMessage(error)),
  });
}

export function useTestRule() {
  return useMutation({ mutationFn: (id: string): Promise<TestReport> => api.testRule(id) });
}

export function useSystemActions() {
  const queryClient = useQueryClient();
  return {
    dryRun: useMutation({
      mutationFn: (enabled: boolean) => api.dryRun(enabled),
      onSuccess: () => {
        notify("info", "dry-run toggled");
        queryClient.invalidateQueries({ queryKey: keys.ready });
        queryClient.invalidateQueries({ queryKey: keys.events });
      },
      onError: (error) => notify("bad", errorMessage(error)),
    }),
    reload: useMutation({
      mutationFn: () => api.reload(),
      onSuccess: () => {
        notify("ok", "config reloaded");
        queryClient.invalidateQueries();
      },
      onError: (error) => notify("bad", errorMessage(error)),
    }),
  };
}

/** A one-line sentence for a write result (used by the activity detail). */
export function sentenceForWrite(result: WriteResult, names: Names): string {
  return writeSentence(result, names);
}

export type { Device, Event, Group, Ready, Rule, StateSnapshot, Timers };
