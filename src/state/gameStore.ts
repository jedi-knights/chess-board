import { create } from "zustand";
import {
  fenAtPly,
  fenToPieces,
  legalDestinations,
  sideToMove,
  tryMove,
  type Ply,
} from "../lib/chessRules";

export type CameraMode = "2d" | "3d";
export type GameMode = "replay" | "play";

interface GameState {
  plies: Ply[];
  ply: number;
  cameraMode: CameraMode;
  loadError: string | null;

  mode: GameMode;
  humanColor: "w" | "b";
  selectedSquare: string | null;
  legalDestinationSquares: string[];

  loadGame: (plies: Ply[]) => void;
  goToPly: (ply: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  goToStart: () => void;
  goToEnd: () => void;
  setCameraMode: (mode: CameraMode) => void;
  setLoadError: (message: string | null) => void;

  startNewGame: (humanColor: "w" | "b") => void;
  selectSquare: (square: string) => void;
  clearSelection: () => void;
  /** Validates and applies a move; returns whether it succeeded. Used for
   * both a human's click-to-move and an engine's `bestmove`. */
  attemptMove: (from: string, to: string, promotion?: string) => boolean;
}

export const useGameStore = create<GameState>((set, get) => ({
  plies: [],
  ply: 0,
  cameraMode: "3d",
  loadError: null,

  mode: "replay",
  humanColor: "w",
  selectedSquare: null,
  legalDestinationSquares: [],

  loadGame: (plies) =>
    set({
      plies,
      ply: 0,
      loadError: null,
      mode: "replay",
      selectedSquare: null,
      legalDestinationSquares: [],
    }),

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

  startNewGame: (humanColor) =>
    set({
      plies: [],
      ply: 0,
      mode: "play",
      humanColor,
      selectedSquare: null,
      legalDestinationSquares: [],
      loadError: null,
    }),

  clearSelection: () => set({ selectedSquare: null, legalDestinationSquares: [] }),

  selectSquare: (square) => {
    const state = get();
    // Only the human's own turn, on the live position, in play mode.
    if (state.mode !== "play" || state.ply !== state.plies.length) return;
    const fen = fenAtPly(state.plies, state.ply);
    if (sideToMove(fen) !== state.humanColor) return;

    if (state.selectedSquare === square) {
      set({ selectedSquare: null, legalDestinationSquares: [] });
      return;
    }

    if (state.selectedSquare && state.legalDestinationSquares.includes(square)) {
      get().attemptMove(state.selectedSquare, square);
      return;
    }

    const piece = fenToPieces(fen).find((p) => p.square === square);
    if (!piece || piece.color !== state.humanColor) {
      set({ selectedSquare: null, legalDestinationSquares: [] });
      return;
    }

    set({ selectedSquare: square, legalDestinationSquares: legalDestinations(fen, square) });
  },

  attemptMove: (from, to, promotion) => {
    const state = get();
    const fen = fenAtPly(state.plies, state.ply);
    const ply = tryMove(fen, from, to, promotion);
    if (!ply) return false;

    set({
      plies: [...state.plies, ply],
      ply: state.ply + 1,
      selectedSquare: null,
      legalDestinationSquares: [],
    });
    return true;
  },
}));
