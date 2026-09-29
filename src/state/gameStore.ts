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
/** Who is choosing this side's moves. "engine" doesn't say *which* engine --
 * that's each side's own engineStore instance (see engineStore.ts). */
export type Controller = "human" | "engine";
export type Controllers = { w: Controller; b: Controller };

interface GameState {
  plies: Ply[];
  ply: number;
  cameraMode: CameraMode;
  loadError: string | null;

  mode: GameMode;
  controllers: Controllers;
  /** Which side the camera favors -- purely cosmetic, independent of who's
   * actually playing (both sides can be engines with no human at all). */
  pov: "w" | "b";
  /** Minimum ms between moves in a fully-automated (both-engine) game, so
   * playback stays human-watchable even if movetime is set very low. Not
   * applied when a human is playing either side -- their own reaction time
   * already paces a human-vs-engine game. */
  playbackDelayMs: number;
  selectedSquare: string | null;
  legalDestinationSquares: string[];

  loadGame: (plies: Ply[]) => void;
  goToPly: (ply: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  goToStart: () => void;
  goToEnd: () => void;
  setCameraMode: (mode: CameraMode) => void;
  setPov: (pov: "w" | "b") => void;
  setPlaybackDelayMs: (ms: number) => void;
  setLoadError: (message: string | null) => void;

  startNewGame: (controllers: Controllers) => void;
  enterPlayMode: () => void;
  exitPlayMode: () => void;
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
  controllers: { w: "human", b: "engine" },
  pov: "w",
  playbackDelayMs: 1500,
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

  setPov: (pov) => set({ pov }),

  setPlaybackDelayMs: (playbackDelayMs) => set({ playbackDelayMs }),

  setLoadError: (loadError) => set({ loadError }),

  startNewGame: (controllers) =>
    set({
      plies: [],
      ply: 0,
      // Deliberately stays "replay" (moves locked) here -- flipping to
      // "play" is a separate step (enterPlayMode), called only once the
      // engine actually confirms it started. Flipping it here, optimistically,
      // is exactly what let a human move pieces around with no engine
      // backing the game at all when engine_start subsequently failed.
      mode: "replay",
      controllers,
      selectedSquare: null,
      legalDestinationSquares: [],
      loadError: null,
    }),

  enterPlayMode: () => set({ mode: "play" }),

  exitPlayMode: () => set({ mode: "replay", selectedSquare: null, legalDestinationSquares: [] }),

  clearSelection: () => set({ selectedSquare: null, legalDestinationSquares: [] }),

  selectSquare: (square) => {
    const state = get();
    // Only on the live position, in play mode, and only when the side to
    // move is human-controlled -- a side set to "engine" never accepts a
    // click, even if that engine hasn't actually replied yet.
    if (state.mode !== "play" || state.ply !== state.plies.length) return;
    const fen = fenAtPly(state.plies, state.ply);
    const toMove = sideToMove(fen);
    if (state.controllers[toMove] !== "human") return;

    if (state.selectedSquare === square) {
      set({ selectedSquare: null, legalDestinationSquares: [] });
      return;
    }

    if (state.selectedSquare && state.legalDestinationSquares.includes(square)) {
      get().attemptMove(state.selectedSquare, square);
      return;
    }

    const piece = fenToPieces(fen).find((p) => p.square === square);
    if (!piece || piece.color !== toMove) {
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
