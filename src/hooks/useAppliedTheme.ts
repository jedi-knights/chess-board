import { useEffect } from "react";
import { resolveTheme, useThemeStore } from "../state/themeStore";
import type { ResolvedTheme } from "../state/themeStore";

/**
 * Applies the resolved theme to `<html data-theme>` (driving the CSS in App.css)
 * and keeps `systemIsDark` in sync with the OS while `preference === "system"`.
 * Mount once, at the app root.
 */
export function useAppliedTheme(): ResolvedTheme {
  const preference = useThemeStore((s) => s.preference);
  const systemIsDark = useThemeStore((s) => s.systemIsDark);
  const syncSystemIsDark = useThemeStore((s) => s._syncSystemIsDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => syncSystemIsDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [syncSystemIsDark]);

  const resolved = resolveTheme(preference, systemIsDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return resolved;
}
