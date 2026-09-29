import type { ThemePreference } from "../state/themeStore";
import { useThemeStore } from "../state/themeStore";

const NEXT: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** Cycles system -> light -> dark -> system on each click. */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

  return (
    <button
      className="theme-toggle"
      onClick={() => setPreference(NEXT[preference])}
      title="Cycle theme: system -> light -> dark"
    >
      Theme: {LABEL[preference]}
    </button>
  );
}
