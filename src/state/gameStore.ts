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

/** What drives a given side's moves. "lichess" means moves arrive from (and
 * are sent to) a live Lichess game stream -- see lichessStore.ts /
 * lichessBotStore.ts. */
export type Controller = "human" | "engine" | "lichess";
export type Controllers = { w: Controller; b: Controller };

interface GameState {
  plies: Ply[];
  ply: number;
  cameraMode: CameraMode;
  loadError: string | null;

  mode: GameMode;
  controllers: Controllers;
  /** Which side's home ranks render at the bottom of the view. Deliberately
   * independent of `controllers` -- it's purely cosmetic ("which side do I
   * want to watch from"), not "who is human," since a game can have no
   * human side at all (engine vs. engine, engine vs. Lichess). */
  pov: "w" | "b";
  /** Floor for the delay between plies when *both* sides are engine-
   * controlled, so a fully-automated game stays human-watchable instead of
   * flashing by at whatever speed the engines themselves move. Ignored
   * otherwise -- a human's own reaction time already paces every other mode. */
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
  setLoadError: (message: string | null) => void;
  setPov: (pov: "w" | "b") => void;
  setPlaybackDelayMs: (ms: number) => void;

  startNewGame: (controllers: Controllers, pov?: "w" | "b") => void;
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

  setLoadError: (loadError) => set({ loadError }),

  setPov: (pov) => set({ pov }),

  setPlaybackDelayMs: (playbackDelayMs) => set({ playbackDelayMs }),

  startNewGame: (controllers, pov) =>
    set((state) => ({
      plies: [],
      ply: 0,
      // Deliberately stays "replay" (moves locked) here -- flipping to
      // "play" is a separate step (enterPlayMode), called only once every
      // requested engine/connection actually confirms it started. Flipping
      // it here, optimistically, is exactly what let a human move pieces
      // around with nothing backing the game at all if that subsequently
      // failed.
      mode: "replay",
      controllers,
      pov: pov ?? state.pov,
      selectedSquare: null,
      legalDestinationSquares: [],
      loadError: null,
    })),

  enterPlayMode: () => set({ mode: "play" }),

  exitPlayMode: () => set({ mode: "replay", selectedSquare: null, legalDestinationSquares: [] }),

  clearSelection: () => set({ selectedSquare: null, legalDestinationSquares: [] }),

  selectSquare: (square) => {
    const state = get();
    // Only a human-controlled side's own turn, on the live position, in
    // play mode.
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

    // toMove is the human's own color here -- the controller check above
    // already established that the side to move is human-controlled.
    const piece = fenToPieces(fen).find((p) => p.square === square);
    if (!piece || piece.color !== toMove) {
      set({ selectedSquare: null, legalDestinationSquares: [] });
      return;
    }

    set({ selectedSquare: square, legalDestinationSquares: legalDestinations(fen, square) });
  },

  attemptMove: (from, to, promotion) => {
    const state = get();
    // Always validate against the live end of the game, never `state.ply` --
    // an incoming Lichess/engine move must apply while the user is reviewing
    // an earlier position, and validating against the viewed FEN would
    // reject it as illegal (or worse, apply the wrong replacement). Only
    // advance the view if the user was already at the end; otherwise leave
    // them where they were reviewing.
    const liveFen = fenAtPly(state.plies, state.plies.length);
    const ply = tryMove(liveFen, from, to, promotion);
    if (!ply) return false;

    const wasAtEnd = state.ply === state.plies.length;
    set({
      plies: [...state.plies, ply],
      ply: wasAtEnd ? state.plies.length + 1 : state.ply,
      selectedSquare: null,
      legalDestinationSquares: [],
    });
    return true;
  },
}));
