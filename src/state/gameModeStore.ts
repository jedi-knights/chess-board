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
