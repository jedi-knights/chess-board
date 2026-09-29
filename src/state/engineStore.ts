import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { fenAtPly, gameStatus, sideToMove } from "../lib/chessRules";
import { buildGoCommand, buildPositionCommand, parseUciLine } from "../lib/uci";
import { useGameStore } from "./gameStore";

export type EngineStatus = "idle" | "starting" | "ready" | "thinking" | "error" | "crashed";

export interface EngineInfo {
  depth?: number;
  scoreCp?: number;
  scoreMate?: number;
  nodes?: number;
}

interface EngineStoreState {
  status: EngineStatus;
  path: string | null;
  movetimeMs: number;
  lastInfo: EngineInfo | null;
  errorMessage: string | null;

  setMovetimeMs: (ms: number) => void;
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

  useEngineStore.setState({ status: "thinking" });
  const moves = game.plies.map((p) => p.uci);
  invoke("engine_write_line", { line: buildPositionCommand(moves) })
    .then(() => invoke("engine_write_line", { line: buildGoCommand(engine.movetimeMs) }))
    .catch((err) => {
      useEngineStore.setState({ status: "error", errorMessage: String(err) });
    });
}

function applyEngineBestMove(move: string) {
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  const promotion = move.length > 4 ? move.slice(4, 5) : undefined;
  const applied = useGameStore.getState().attemptMove(from, to, promotion);
  useEngineStore.setState({
    status: applied ? "ready" : "error",
    errorMessage: applied ? null : `engine returned an illegal move: ${move}`,
  });
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
      useEngineStore.setState({
        lastInfo: {
          depth: message.depth,
          scoreCp: message.scoreCp,
          scoreMate: message.scoreMate,
          nodes: message.nodes,
        },
      });
    }
  });

  void listen<number | null>("engine-exit", (event) => {
    useEngineStore.setState({
      status: "crashed",
      errorMessage:
        event.payload !== null
          ? `engine process exited (code ${event.payload})`
          : "engine process exited unexpectedly",
    });
  });

  useGameStore.subscribe((state, prevState) => {
    if (state.plies.length !== prevState.plies.length) {
      maybeRequestEngineMove();
    }
  });
}

export const useEngineStore = create<EngineStoreState>((set) => ({
  status: "idle",
  path: null,
  movetimeMs: 1000,
  lastInfo: null,
  errorMessage: null,

  setMovetimeMs: (movetimeMs) => set({ movetimeMs }),

  startEngine: async (path) => {
    installListenersOnce();
    set({ status: "starting", path, errorMessage: null, lastInfo: null });
    try {
      await invoke("engine_start", { path });
      set({ status: "ready" });
      maybeRequestEngineMove();
    } catch (err) {
      set({ status: "error", errorMessage: String(err) });
    }
  },

  stopEngine: async () => {
    try {
      await invoke("engine_stop");
    } finally {
      set({ status: "idle", lastInfo: null });
    }
  },
}));
