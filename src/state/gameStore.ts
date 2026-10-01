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

/** Game variant / rule set. Standard chess is the default; Chess960
 * shares movegen rules with chessops' standard Chess class but needs
 * the engine's `UCI_Chess960` option toggled so bestmove output uses
 * the king-captures-own-rook UCI form. Other Lichess variants
 * (Antichess, Atomic, ...) will extend this union as each lands. */
export type Rules = "chess" | "chess960" | "koth";

/** What drives a given side's moves. "lichess" means moves arrive from (and
 * are sent to) a live Lichess game stream -- see lichessStore.ts /
 * lichessBotStore.ts. */
export type Controller = "human" | "engine" | "lichess";
export type Controllers = { w: Controller; b: Controller };

interface GameState {
  plies: Ply[];
  ply: number;
  /** Custom starting FEN for the current game, `null` for a standard startpos
   * game. Set by `startNewGame`'s optional `startFen` and plumbed into every
   * `fenAtPly` call and the engine `position` command so a Lichess
   * "From Position" challenge, a custom-FEN local game, or (later) a
   * Chess960 SFEN all behave identically to a startpos game. */
  startFen: string | null;
  /** Variant / rule set for the active game. `"chess"` for standard
   * (startpos or From Position), `"chess960"` for Fischer Random. The
   * engineStore reads this to decide whether to send `setoption name
   * UCI_Chess960 value true` after `startEngine`. */
  rules: Rules;
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

  startNewGame: (
    controllers: Controllers,
    pov?: "w" | "b",
    startFen?: string | null,
    rules?: Rules,
  ) => void;
  /** Replaces `controllers` mid-game without touching plies/ply/mode.
   * Deliberately narrow: for the case where the caller starts the game
   * with a placeholder (e.g. `{ w: "lichess", b: "lichess" }` when it
   * doesn't yet know which side the human plays) and needs to promote
   * one side to `"human"` once the answer arrives (Lichess `gameFull`
   * with a `white.id` / `black.id` we can compare to the verified
   * account). Do not use for "start a new game" -- that's what
   * `startNewGame` is for. */
  setControllers: (controllers: Controllers, pov?: "w" | "b") => void;
  /** Replaces `startFen` mid-game without touching plies/ply/mode.
   * Same reasoning as `setControllers`: `gameFull` arrives after
   * `primeForNewSession` has already run `startNewGame`, and the
   * Lichess stores need to update the custom start FEN *before*
   * applying any moves in the same update (otherwise the first
   * move validates against standard startpos). Passing `null` is
   * valid -- a standard-startpos game explicitly reports it. */
  setStartFen: (startFen: string | null) => void;
  /** Narrow setter for the variant, same reasoning as `setStartFen`:
   * when `handleGameStart` has already created the game placeholder
   * via `startNewGame` and `gameFull` later arrives carrying the real
   * variant, this is how the variant is updated without resetting
   * `plies`. */
  setRules: (rules: Rules) => void;
  enterPlayMode: () => void;
  exitPlayMode: () => void;
  selectSquare: (square: string) => void;
  clearSelection: () => void;
  /** Validates and applies a move; returns whether it succeeded. Used for
   * both a human's click-to-move and an engine's `bestmove`. */
  attemptMove: (from: string, to: string, promotion?: string) => boolean;
  /** Attaches derived timing metadata to the most recently appended ply.
   * The Lichess stores call this right after `attemptMove` returns true,
   * so `thinkTimeSeconds` shows up in the move log for live plies without
   * having to rebuild the entire ply array from clock deltas. A no-op
   * when there are no plies yet. */
  annotateLastPly: (info: { thinkTimeSeconds?: number; clockSeconds?: number }) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  plies: [],
  ply: 0,
  startFen: null,
  rules: "chess",
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
      // A loaded PGN/UCI list starts from the standard initial position --
      // custom-FEN loads are a separate entry point and are not supported
      // via `loadGame` today.
      startFen: null,
      rules: "chess",
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

  startNewGame: (controllers, pov, startFen, rules) =>
    set((state) => ({
      plies: [],
      ply: 0,
      // Every `startNewGame` call starts from standard startpos unless the
      // caller explicitly supplies a `startFen`. Lichess "From Position"
      // passes it; standard-mode controls (EngineControls, LichessControls
      // for a vanilla seek) don't -- a fresh game should not inherit the
      // previous one's custom setup.
      startFen: startFen ?? null,
      rules: rules ?? "chess",
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

  setControllers: (controllers, pov) =>
    set((state) => ({
      controllers,
      pov: pov ?? state.pov,
    })),

  setStartFen: (startFen) => set({ startFen }),

  setRules: (rules) => set({ rules }),

  enterPlayMode: () => set({ mode: "play" }),

  exitPlayMode: () => set({ mode: "replay", selectedSquare: null, legalDestinationSquares: [] }),

  clearSelection: () => set({ selectedSquare: null, legalDestinationSquares: [] }),

  selectSquare: (square) => {
    const state = get();
    // Only a human-controlled side's own turn, on the live position, in
    // play mode.
    if (state.mode !== "play" || state.ply !== state.plies.length) return;
    const fen = fenAtPly(state.plies, state.ply, state.startFen ?? undefined);
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
    const liveFen = fenAtPly(state.plies, state.plies.length, state.startFen ?? undefined);
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

  annotateLastPly: (info) => {
    const state = get();
    if (state.plies.length === 0) return;
    const lastIndex = state.plies.length - 1;
    const last = state.plies[lastIndex];
    const patched: (typeof last) = { ...last };
    if (info.thinkTimeSeconds !== undefined) patched.thinkTimeSeconds = info.thinkTimeSeconds;
    if (info.clockSeconds !== undefined) patched.clockSeconds = info.clockSeconds;
    const nextPlies = state.plies.slice();
    nextPlies[lastIndex] = patched;
    set({ plies: nextPlies });
  },
}));
