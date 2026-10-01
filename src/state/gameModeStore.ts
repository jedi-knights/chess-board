import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Rules } from "./gameStore";

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

/** Variants the local-play picker exposes. Each one starts from the
 * standard FEN (plus a variant suffix where applicable, like Crazyhouse's
 * `[]` or Three-check's `+3+3`); variants with non-standard starting
 * positions (Chess960, Horde, Racing Kings) are deliberately NOT in
 * the picker because they require either a specific starting FEN or
 * a 1-of-960 Chess960 position choice. Those still work when they
 * come in from a Lichess challenge (the initialFen is supplied). The
 * picker is a UX for local engine-vs-engine / human-vs-engine play,
 * not a general variant-loader. */
export type LocalVariant =
  | "chess"
  | "koth"
  | "3check"
  | "antichess"
  | "atomic"
  | "crazyhouse";

export const LOCAL_VARIANT_LABELS: Record<LocalVariant, string> = {
  "chess":      "Standard",
  "koth":       "King of the Hill",
  "3check":     "Three-check",
  "antichess":  "Antichess",
  "atomic":     "Atomic",
  "crazyhouse": "Crazyhouse",
};

/** Starting FEN per variant for local play. All of these are the
 * standard chess starting position plus a variant-specific suffix
 * where the variant's FEN format demands one (`+3+3` for Three-check,
 * `[]` for Crazyhouse). `null` means "use `startNewGame`'s default"
 * (standard startpos). */
export const LOCAL_VARIANT_START_FEN: Record<LocalVariant, string | null> = {
  "chess":      null,
  "koth":       null,
  "antichess":  null,
  "atomic":     null,
  "3check":     "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 +3+3",
  "crazyhouse": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1",
};

/** Map LocalVariant to the gameStore's full `Rules` union. All current
 * LocalVariant values map 1:1, but keeping this translation function
 * explicit means a future variant that needs non-identity mapping
 * (e.g. "chess" with Chess960 FEN) doesn't blow up the type system. */
export function localVariantToRules(v: LocalVariant): Rules {
  return v as Rules;  // 1:1 for now
}

interface GameModeUiState {
  preset: GameModePreset;
  setPreset: (preset: GameModePreset) => void;
  /** The variant local-play (human-vs-engine, engine-vs-engine) uses
   * when starting a game. Lichess-mode presets ignore this and derive
   * variant from the incoming challenge. */
  localVariant: LocalVariant;
  setLocalVariant: (v: LocalVariant) => void;
}

export const useGameModeStore = create<GameModeUiState>()(
  persist(
    (set) => ({
      preset: "human-vs-engine",
      setPreset: (preset) => set({ preset }),
      localVariant: "chess",
      setLocalVariant: (localVariant) => set({ localVariant }),
    }),
    { name: "chess-board-game-mode" },
  ),
);
