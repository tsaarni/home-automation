import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "dark" | "light";

/**
 * Material Design 3 Theme provider.
 * Manages the data-theme attribute on <html> and documentElement colorScheme.
 */
export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(
    () => (localStorage.getItem("theme") as ThemeChoice | null) ?? "system",
  );

  useEffect(() => {
    localStorage.setItem("theme", choice);
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
      const isDark = choice === "dark" || (choice === "system" && media.matches);
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [choice]);

  return [choice, setChoice];
}
