import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The 4 fixed presets the mode selector offers -- each maps to exactly
 * one existing (or new) panel. Free-form per-side Human/Engine/Lichess
 * pickers were considered and deliberately not built; these 4 named
 * presets are the smaller surface. */
export type GameModePreset =
  | "human-vs-engine"
  | "human-vs-lichess"
  | "engine-vs-lichess"
  | "engine-vs-engine";

/** Single source of truth for each preset's display label -- shared by
 * the header's active-mode display and the native View menu's game-mode
 * group (src-tauri/src/menu.rs owns the menu item ids, not the label
 * text shown to the user). */
export const GAME_MODE_LABELS: Record<GameModePreset, string> = {
  "human-vs-engine": "Human vs Engine",
  "human-vs-lichess": "Human vs Lichess",
  "engine-vs-lichess": "Engine vs Lichess (Bot API)",
  "engine-vs-engine": "Engine vs Engine",
};

interface GameModeUiState {
  preset: GameModePreset;
  setPreset: (preset: GameModePreset) => void;
}

export const useGameModeStore = create<GameModeUiState>()(
  persist(
    (set) => ({
      preset: "human-vs-engine",
      setPreset: (preset) => set({ preset }),
    }),
    { name: "chess-board-game-mode" },
  ),
);
