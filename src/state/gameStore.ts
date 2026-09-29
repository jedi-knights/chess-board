import { create } from "zustand";
import type { Ply } from "../lib/chessRules";

export type CameraMode = "2d" | "3d";

interface GameState {
  plies: Ply[];
  ply: number;
  cameraMode: CameraMode;
  loadError: string | null;
  loadGame: (plies: Ply[]) => void;
  goToPly: (ply: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  goToStart: () => void;
  goToEnd: () => void;
  setCameraMode: (mode: CameraMode) => void;
  setLoadError: (message: string | null) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  plies: [],
  ply: 0,
  cameraMode: "2d",
  loadError: null,

  loadGame: (plies) => set({ plies, ply: 0, loadError: null }),

  goToPly: (ply) => {
    const { plies } = get();
    set({ ply: Math.max(0, Math.min(ply, plies.length)) });
  },

  stepForward: () => {
    const { ply, plies } = get();
    if (ply < plies.length) set({ ply: ply + 1 });
  },

  stepBackward: () => {
    const { ply } = get();
    if (ply > 0) set({ ply: ply - 1 });
  },

  goToStart: () => set({ ply: 0 }),

  goToEnd: () => set({ ply: get().plies.length }),

  setCameraMode: (cameraMode) => set({ cameraMode }),

  setLoadError: (loadError) => set({ loadError }),
}));
