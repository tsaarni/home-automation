import { useSyncExternalStore } from "react";

let query = "";
const listeners = new Set<() => void>();

export function setSearch(next: string): void {
  query = next;
  for (const listener of listeners) listener();
}

export function clearSearch(): void {
  setSearch("");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSearchQuery(): string {
  return useSyncExternalStore(
    subscribe,
    () => query,
    () => "",
  );
}

/** Plain text match over the words a person would type. */
export function matches(query: string, ...texts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return texts.some((text) => text?.toLowerCase().includes(needle));
}
