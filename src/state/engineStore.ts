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

interface EngineStoreState {
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
}

/**
 * Sends `position` + `go` to the engine when it's the engine's turn on the
 * live position. Called after every ply append (human or engine), from the
 * gameStore subscription installed below — self-terminating, since applying
 * the engine's own move flips the turn back to the human, so this check
 * fails on the very next call rather than looping.
 */
function maybeRequestEngineMove() {
  const engine = useEngineStore.getState();
  const game = useGameStore.getState();

  if (engine.status !== "ready") return;
  if (game.mode !== "play" || game.ply !== game.plies.length) return;

  const fen = fenAtPly(game.plies, game.ply);
  if (sideToMove(fen) === game.humanColor) return;
  if (gameStatus(fen).over) return;

  useEngineStore.setState({ status: "thinking", searchInfoHistory: [], lastInfo: null });
  const moves = game.plies.map((p) => p.uci);
  invoke("engine_write_line", { line: buildPositionCommand(moves) })
    .then(() => invoke("engine_write_line", { line: buildGoCommand(engine.movetimeMs) }))
    .catch((err) => failEngine("error", String(err)));
}

/**
 * Every path that ends the engine's ability to keep playing goes through
 * here, so "the engine is no longer trustworthy" and "moves are locked
 * again" can never drift apart -- see gameStore.exitPlayMode's own comment
 * for the bug this fixes (mode could stay "play" with no live engine
 * behind it, letting a human move both sides with nothing checking them).
 */
function failEngine(status: "error" | "crashed", message: string) {
  useEngineStore.setState({ status, errorMessage: message });
  useGameStore.getState().exitPlayMode();
}

function applyEngineBestMove(move: string) {
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  const promotion = move.length > 4 ? move.slice(4, 5) : undefined;
  const applied = useGameStore.getState().attemptMove(from, to, promotion);
  if (applied) {
    useEngineStore.setState({ status: "ready" });
  } else {
    failEngine("error", `engine returned an illegal move: ${move}`);
  }
}

let listenersInstalled = false;

/** Installs the stdout/exit event listeners and the turn-watcher exactly once per app lifetime. */
function installListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void listen<string>("engine-stdout", (event) => {
    const message = parseUciLine(event.payload);
    if (message.type === "bestmove") {
      applyEngineBestMove(message.move);
    } else if (message.type === "info") {
      useEngineStore.setState((state) => ({
        lastInfo: message,
        searchInfoHistory: appendSearchInfo(state.searchInfoHistory, message),
      }));
    } else if (message.type === "option") {
      useEngineStore.setState((state) => ({
        options: upsertOption(state.options, message),
        optionValues:
          message.name in state.optionValues || message.default === undefined
            ? state.optionValues
            : { ...state.optionValues, [message.name]: message.default },
      }));
    }
  });

  void listen<number | null>("engine-exit", (event) => {
    failEngine(
      "crashed",
      event.payload !== null
        ? `engine process exited (code ${event.payload})`
        : "engine process exited unexpectedly",
    );
  });

  useGameStore.subscribe((state, prevState) => {
    if (state.plies.length !== prevState.plies.length) {
      maybeRequestEngineMove();
    }
  });
}

const NOT_RUNNING = new Set<EngineStatus>(["idle", "error", "crashed"]);

export const useEngineStore = create<EngineStoreState>()(
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
        invoke("engine_write_line", { line: buildSetOptionCommand(name, value) }).catch(
          (err) => failEngine("error", String(err)),
        );
      },

      startEngine: async (path) => {
        // Re-entrancy guard: a double-click (or any duplicate call while a
        // start is already in flight) would otherwise spawn a second
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
        try {
          await invoke("engine_start", { path });
          // Triggers the id/option/uciok handshake burst so `options`
          // populates. Fire-and-forget: the existing position/go flow
          // already works without waiting on uciok, so this doesn't
          // change the ready/turn-orchestration timing at all.
          void invoke("engine_write_line", { line: "uci" });
          set({ status: "ready" });
          // Only unlock moves once the engine has actually confirmed it
          // started -- gameStore.startNewGame (called before this) resets
          // the board but deliberately leaves moves locked until now.
          useGameStore.getState().enterPlayMode();
          maybeRequestEngineMove();
        } catch (err) {
          failEngine("error", String(err));
        }
      },

      stopEngine: async () => {
        try {
          await invoke("engine_stop");
        } finally {
          set({ status: "idle", lastInfo: null, searchInfoHistory: [] });
          useGameStore.getState().exitPlayMode();
        }
      },
    }),
    {
      name: "chess-board-engine",
      partialize: (state) => ({ path: state.path, movetimeMs: state.movetimeMs }),
    },
  ),
);
