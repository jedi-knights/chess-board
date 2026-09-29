import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fenAtPly, gameStatus, sideToMove } from "../lib/chessRules";
import {
  appendSearchInfo,
  buildGoCommand,
  buildPositionCommand,
  buildSetOptionCommand,
  parseUciLine,
  upsertOption,
  type UciInfo,
  type UciOption,
} from "../lib/uci";
import { useGameStore } from "./gameStore";

export type EngineStatus = "idle" | "starting" | "ready" | "thinking" | "error" | "crashed";
export type Side = "w" | "b";

export interface EngineExitPayload {
  code: number | null;
  /** The engine's most recent stderr output before it exited, if any. */
  stderr: string;
}

/** Builds the user-facing message for an `engine-exit` event, including
 * whatever stderr the engine printed -- without it, "exited unexpectedly"
 * gives no context at all, which was the whole complaint this fixes. */
export function formatEngineExitMessage(payload: EngineExitPayload): string {
  const codePart =
    payload.code !== null ? `engine process exited (code ${payload.code})` : "engine process exited unexpectedly";
  const stderrPart = payload.stderr.trim();
  return stderrPart ? `${codePart}\n${stderrPart}` : codePart;
}

/** Fire-and-forget append to the on-disk debug log -- a logging failure
 * must never cascade into a user-visible error of its own. */
function logDebug(side: Side, message: string) {
  invoke("debug_log_append", { message: `[${side}] ${message}` }).catch(() => {});
}

const NOT_RUNNING = new Set<EngineStatus>(["idle", "error", "crashed"]);

export interface EngineStoreState {
  /** Selected engine path -- persisted across sessions, independent of status. */
  path: string | null;
  status: EngineStatus;
  movetimeMs: number;
  lastInfo: UciInfo | null;
  /** Every `info` line from the *current* search, oldest first, capped (see uci.ts). */
  searchInfoHistory: UciInfo[];
  /** Options the engine advertised after `uci`, e.g. UseNNUE/EvalFile. */
  options: UciOption[];
  /** The value last set (or the option's own default) per option name. */
  optionValues: Record<string, string>;
  errorMessage: string | null;

  setPath: (path: string) => void;
  setMovetimeMs: (ms: number) => void;
  setOption: (name: string, value?: string) => void;
  startEngine: (path: string) => Promise<void>;
  stopEngine: () => Promise<void>;
  /** Checks whether it's this side's turn to move and, if so, requests one.
   * Exported so a caller can nudge both sides right after entering play
   * mode (mode flipping alone doesn't append a ply, so the plies-length
   * subscription below wouldn't otherwise fire for the game's first move). */
  checkTurn: () => void;
}

/**
 * One independent engine store per side (see gameStore.ts's `Controllers`).
 * Standard zustand "store factory" pattern: everything that used to be
 * module-level singleton state/logic now closes over `side`, so two calls
 * produce two fully independent stores -- same shape, same behavior, each
 * only ever acting on its own side's process and turn.
 */
export function createEngineStore(side: Side) {
  /**
   * Sends `position` + `go` when it's this side's turn on the live
   * position. Called after every ply append (human or engine) via the
   * gameStore subscription below, and once explicitly right after entering
   * play mode — self-terminating either way, since applying this side's
   * own move flips the turn away, so the next call for *this* side fails
   * the turn check rather than looping.
   */
  function maybeRequestEngineMove() {
    const engine = useThisEngineStore.getState();
    const game = useGameStore.getState();

    if (engine.status !== "ready") return;
    if (game.mode !== "play" || game.ply !== game.plies.length) return;

    const fen = fenAtPly(game.plies, game.ply);
    const toMove = sideToMove(fen);
    if (toMove !== side) return;
    if (game.controllers[toMove] !== "engine") return;
    if (gameStatus(fen).over) return;

    // Fully-automated games (no human on either side) get topped up to a
    // human-watchable minimum pace; a human-vs-engine game already paces
    // itself via the human's own reaction time, so no artificial delay.
    const fullyAutomated = game.controllers.w === "engine" && game.controllers.b === "engine";
    const topUpMs = fullyAutomated ? Math.max(0, game.playbackDelayMs - engine.movetimeMs) : 0;

    const moves = game.plies.map((p) => p.uci);
    const positionCmd = buildPositionCommand(moves);
    const goCmd = buildGoCommand(engine.movetimeMs);

    window.setTimeout(() => {
      // Re-check: Stop (or a crash) may have landed during the pacing delay.
      if (useThisEngineStore.getState().status !== "ready") return;
      useThisEngineStore.setState({ status: "thinking", searchInfoHistory: [], lastInfo: null });
      logDebug(side, `sending: ${positionCmd}`);
      logDebug(side, `sending: ${goCmd}`);
      invoke("engine_write_line", { side, line: positionCmd })
        .then(() => invoke("engine_write_line", { side, line: goCmd }))
        .catch((err) => failEngine("error", String(err)));
    }, topUpMs);
  }

  /**
   * Every path that ends this side's engine's ability to keep playing goes
   * through here, so "no longer trustworthy" and "moves locked again" can
   * never drift apart -- see gameStore.exitPlayMode's own comment for the
   * bug this fixes.
   */
  function failEngine(status: "error" | "crashed", message: string) {
    logDebug(side, `FAILED (${status}): ${message}`);
    useThisEngineStore.setState({ status, errorMessage: message });
    useGameStore.getState().exitPlayMode();
  }

  function applyEngineBestMove(move: string) {
    logDebug(side, `received bestmove: ${move}`);
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    const promotion = move.length > 4 ? move.slice(4, 5) : undefined;
    const applied = useGameStore.getState().attemptMove(from, to, promotion);
    if (applied) {
      useThisEngineStore.setState({ status: "ready" });
    } else {
      failEngine("error", `engine returned an illegal move: ${move}`);
    }
  }

  let listenersInstalled = false;

  function installListenersOnce() {
    if (listenersInstalled) return;
    listenersInstalled = true;

    void listen<string>(`engine-stdout-${side}`, (event) => {
      const message = parseUciLine(event.payload);
      if (message.type === "bestmove") {
        applyEngineBestMove(message.move);
      } else if (message.type === "info") {
        useThisEngineStore.setState((state) => ({
          lastInfo: message,
          searchInfoHistory: appendSearchInfo(state.searchInfoHistory, message),
        }));
      } else if (message.type === "option") {
        useThisEngineStore.setState((state) => ({
          options: upsertOption(state.options, message),
          optionValues:
            message.name in state.optionValues || message.default === undefined
              ? state.optionValues
              : { ...state.optionValues, [message.name]: message.default },
        }));
      }
    });

    void listen<EngineExitPayload>(`engine-exit-${side}`, (event) => {
      failEngine("crashed", formatEngineExitMessage(event.payload));
    });

    useGameStore.subscribe((state, prevState) => {
      if (state.plies.length !== prevState.plies.length) {
        maybeRequestEngineMove();
      }
    });
  }

  const useThisEngineStore = create<EngineStoreState>()(
    persist(
      (set, get) => ({
        path: null,
        status: "idle",
        movetimeMs: 1000,
        lastInfo: null,
        searchInfoHistory: [],
        options: [],
        optionValues: {},
        errorMessage: null,

        setPath: (path) => set({ path }),
        setMovetimeMs: (movetimeMs) => set({ movetimeMs }),

        setOption: (name, value) => {
          if (value !== undefined) {
            set((state) => ({ optionValues: { ...state.optionValues, [name]: value } }));
          }
          invoke("engine_write_line", { side, line: buildSetOptionCommand(name, value) }).catch(
            (err) => failEngine("error", String(err)),
          );
        },

        startEngine: async (path) => {
          // Re-entrancy guard: a double-click (or any duplicate call while
          // a start is already in flight) would otherwise spawn a second
          // process, whose Rust-side startup kills the first one mid-flight
          // and surfaces as a spurious "engine process exited unexpectedly".
          if (!NOT_RUNNING.has(get().status)) return;

          installListenersOnce();
          set({
            status: "starting",
            path,
            errorMessage: null,
            lastInfo: null,
            searchInfoHistory: [],
            options: [],
            optionValues: {},
          });
          logDebug(side, `starting engine: ${path}`);
          try {
            await invoke("engine_start", { side, path });
            // Triggers the id/option/uciok handshake burst so `options`
            // populates. Fire-and-forget: the position/go flow already
            // works without waiting on uciok, so this doesn't change the
            // ready/turn-orchestration timing at all.
            void invoke("engine_write_line", { side, line: "uci" });
            set({ status: "ready" });
            logDebug(side, "engine ready");
            // Deliberately does NOT call gameStore.enterPlayMode() here.
            // When both sides are engine-controlled, unlocking on the
            // *first* side to finish starting would let a move happen
            // before we know whether the *other* side's engine will even
            // start -- the caller (EngineControls) waits for every
            // requested side to reach "ready" before calling
            // enterPlayMode() once, then nudges checkTurn() on both.
          } catch (err) {
            failEngine("error", String(err));
          }
        },

        stopEngine: async () => {
          logDebug(side, "stop requested");
          try {
            await invoke("engine_stop", { side });
          } finally {
            // Clearing errorMessage here is what makes "Stop" actually
            // dismiss a displayed crash/error -- previously it didn't, so
            // a stale "engine process exited unexpectedly" stuck around
            // with no way to clear it short of restarting the whole app.
            set({ status: "idle", lastInfo: null, searchInfoHistory: [], errorMessage: null });
            useGameStore.getState().exitPlayMode();
          }
        },

        checkTurn: () => maybeRequestEngineMove(),
      }),
      {
        name: `chess-board-engine-${side}`,
        partialize: (state) => ({ path: state.path, movetimeMs: state.movetimeMs }),
      },
    ),
  );

  return useThisEngineStore;
}

export const useWhiteEngineStore = createEngineStore("w");
export const useBlackEngineStore = createEngineStore("b");

export function engineStoreForSide(side: Side) {
  return side === "w" ? useWhiteEngineStore : useBlackEngineStore;
}
