import { useEffect, useSyncExternalStore } from "react";
import { type NavigateFunction, useLocation, useNavigate } from "react-router";

// Each destination retains its own URL-backed query while navigating in this session.
let navigateSearch: NavigateFunction | undefined;
const queries = new Map<string, string>();
const listeners = new Set<() => void>();
export function setSearch(next: string): void {
  const url = new URL(window.location.href);
  if (next) url.searchParams.set("q", next);
  else url.searchParams.delete("q");
  queries.set(url.pathname, next);
  if (navigateSearch) void navigateSearch(`${url.pathname}${url.search}${url.hash}`, { replace: true });
  else window.history.replaceState(window.history.state, "", url);
  for (const listener of listeners) listener();
}
export function clearSearch(): void {
  setSearch("");
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}
export function useSearchQuery(): string {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    navigateSearch = navigate;
    const url = new URL(window.location.href);
    const query = url.searchParams.get("q");
    if (query !== null) queries.set(location.pathname, query);
    else if (queries.get(location.pathname)) setSearch(queries.get(location.pathname) ?? "");
  }, [location.pathname, location.search, navigate]);
  return useSyncExternalStore(
    subscribe,
    () => {
      const url = new URL(window.location.href);
      return url.searchParams.get("q") ?? queries.get(url.pathname) ?? "";
    },
    () => "",
  );
}

/** Plain text match over the words a person would type. */
export function matches(query: string, ...texts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return texts.some((text) => text?.toLowerCase().includes(needle));
}
