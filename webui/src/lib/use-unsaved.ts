import { useEffect } from "react";
import { useBlocker } from "react-router";

/** Cover route changes as well as reload/closing the tab. */
export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!dirty) return false;
    if (currentLocation.pathname !== nextLocation.pathname) return true;
    const current = new URLSearchParams(currentLocation.search);
    const next = new URLSearchParams(nextLocation.search);
    return ["tab", "type"].some((key) => current.get(key) !== next.get(key));
  });
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Discard unsaved changes?")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
