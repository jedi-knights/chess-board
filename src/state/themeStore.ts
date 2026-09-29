import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

interface ThemeState {
  preference: ThemePreference;
  systemIsDark: boolean;
  setPreference: (preference: ThemePreference) => void;
  /** Called once by useAppliedTheme to wire up the OS-preference listener. */
  _syncSystemIsDark: (isDark: boolean) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: "system",
      systemIsDark: systemPrefersDark(),
      setPreference: (preference) => set({ preference }),
      _syncSystemIsDark: (isDark) => set({ systemIsDark: isDark }),
    }),
    { name: "chess-board-theme", partialize: (state) => ({ preference: state.preference }) },
  ),
);

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}
