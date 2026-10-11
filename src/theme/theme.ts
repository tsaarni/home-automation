import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { darkTheme } from "./tokens.stylex";

/** `createTheme` returns a theme object; the DOM needs its class names (dev mode emits several). */
const darkClasses = (stylex.props(darkTheme).className ?? "").split(/\s+/).filter(Boolean);

export type ThemeChoice = "system" | "dark" | "light";

/** Dark is the primary target (evening use); system is the default. */
export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(
    () => (localStorage.getItem("theme") as ThemeChoice | null) ?? "system",
  );
  useEffect(() => {
    localStorage.setItem("theme", choice);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = choice === "dark" || (choice === "system" && media.matches);
      for (const className of darkClasses) document.documentElement.classList.toggle(className, dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [choice]);
  return [choice, setChoice];
}
