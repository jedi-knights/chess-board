import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BoardPaletteName } from "../lib/boardPalettes";

interface BoardThemeState {
  palette: BoardPaletteName;
  setPalette: (palette: BoardPaletteName) => void;
}

export const useBoardThemeStore = create<BoardThemeState>()(
  persist(
    (set) => ({
      palette: "classic",
      setPalette: (palette) => set({ palette }),
    }),
    { name: "chess-board-board-theme" },
  ),
);
