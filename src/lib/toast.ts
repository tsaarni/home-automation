export type Toast = { id: number; kind: "ok" | "bad" | "info"; message: string };

const listeners = new Set<(toast: Toast) => void>();
let nextId = 1;

export function notify(kind: Toast["kind"], message: string): void {
  const toast = { id: nextId++, kind, message };
  for (const listener of listeners) listener(toast);
}

export function subscribeToasts(listener: (toast: Toast) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
