import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PieceStyleName } from "../lib/pieceStyles";

interface PieceStyleState {
  style: PieceStyleName;
  setStyle: (style: PieceStyleName) => void;
}

export const usePieceStyleStore = create<PieceStyleState>()(
  persist(
    (set) => ({
      style: "classic",
      setStyle: (style) => set({ style }),
    }),
    { name: "chess-board-piece-style" },
  ),
);
