import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create, type UseBoundStore, type StoreApi } from "zustand";
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

export type Side = "w" | "b";
export type EngineStatus = "idle" | "starting" | "ready" | "thinking" | "error" | "crashed";

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
  /** Asks this side's engine to move now, if it's actually this side's turn
   * on the live position. Exposed so a caller can trigger the initial check
   * right after `enterPlayMode()` -- see `startEngine`'s doc comment for why
   * that can't happen automatically inside this store anymore. */
  checkTurn: () => void;
  /** Sends UCI `stop` if this engine is currently thinking. Used when a
   * game ends mid-search (Lichess terminal status, opponent resign)
   * so the engine returns to `ready` for the next game instead of holding
   * its search context indefinitely. The forthcoming `bestmove` is dropped
   * by `applyEngineBestMove`'s late-bestmove guard. */
  stopSearch: () => void;
}

const NOT_RUNNING = new Set<EngineStatus>(["idle", "error", "crashed"]);

/**
 * One independent engine store per side, so both sides can be engine-
 * controlled at once (same binary or different ones -- each is its own OS
 * process, see `engine.rs`'s `WhiteEngine`/`BlackEngine` slots). Every
 * closure below is scoped to one `side` and one store instance; resist the
 * urge to "deduplicate" the two instances into one with a side field --
 * that's exactly the singleton assumption this factory undoes.
 */
export function createEngineStore(side: Side): UseBoundStore<StoreApi<EngineStoreState>> {
  let listenersInstalled = false;
  // Set just before an intentional `engine_stop` call and consumed by the
  // engine-exit listener below. Rust's stop_locked() kills the process and
  // joins its stdout-reader thread -- which emits engine-exit-{side} on EOF
  // -- before the engine_stop command returns, but Tauri does not order
  // event delivery against the invoke() promise that races it: the event
  // can reach this store either before or after stopEngine's own `finally`
  // sets status "idle". Without this latch, a clean, user-requested Stop
  // could have its "idle" silently overwritten by "crashed" a moment later.
  let stopRequested = false;

  /** Fire-and-forget append to the on-disk debug log -- a logging failure
   * must never cascade into a user-visible error of its own. */
  function logDebug(message: string) {
    invoke("debug_log_append", { message: `[${side}] ${message}` }).catch(() => {});
  }

  /**
   * Every path that ends this engine's ability to keep playing goes through
   * here, so "this engine is no longer trustworthy" and "moves are locked
   * again" can never drift apart -- see gameStore.exitPlayMode's own comment
   * for the bug this fixes. A failure on either side ends the whole game,
   * same as before -- there's no partial-stop semantic where one side keeps
   * playing with no opponent responding.
   */
  function failEngine(status: "error" | "crashed", message: string) {
    logDebug(`FAILED (${status}): ${message}`);
    useEngineStore.setState({ status, errorMessage: message });
    useGameStore.getState().exitPlayMode();
  }

  function applyEngineBestMove(move: string) {
    logDebug(`received bestmove: ${move}`);
    // A duplicate delivery of the exact move just applied is not a real
    // illegal move -- it's the same bestmove arriving twice (observed in
    // dev: `listen()`'s unlisten handle is never stored/called, so a Vite
    // HMR re-evaluation of this module attaches a second listener onto
    // the same Rust-side engine-stdout-{side} event without removing the
    // first; both then apply the one bestmove Rust actually emitted).
    // Silently ignoring an exact repeat of the last ply is correct
    // regardless of *why* it arrived twice -- tanking the whole game over
    // a harmless duplicate would be worse than a missing defensive check.
    const gameState = useGameStore.getState();
    const plies = gameState.plies;
    const lastPly = plies[plies.length - 1];
    if (lastPly?.uci === move) {
      logDebug(`ignoring duplicate bestmove: ${move}`);
      return;
    }
    // Drop late bestmoves: the game may have ended (Lichess terminal status,
    // manual Stop, or an on-board checkmate the engine wasn't yet aware of)
    // between the `go` and this reply, or an opponent's move may already have
    // been applied via a different path (Lichess echo). Applying this move
    // would rewrite the board past a finished game, and in Lichess-bot mode
    // would try to POST it to a stream that's already closed.
    const liveFen = fenAtPly(plies, plies.length);
    if (
      gameState.mode !== "play" ||
      sideToMove(liveFen) !== side ||
      gameStatus(liveFen).over
    ) {
      logDebug(`dropping late bestmove: ${move}`);
      useEngineStore.setState({ status: "ready" });
      return;
    }
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

  /**
   * Sends `position` + `go` to this side's engine when it's actually this
   * side's turn on the live position. Called after every ply append (from
   * either side), from the gameStore subscription installed below --
   * self-terminating, since applying this engine's own move flips the turn
   * away from `side`, so this check fails on the very next call.
   */
  function maybeRequestEngineMove() {
    const engine = useEngineStore.getState();
    const game = useGameStore.getState();

    if (engine.status !== "ready") return;
    if (game.mode !== "play" || game.ply !== game.plies.length) return;

    const fen = fenAtPly(game.plies, game.ply);
    if (sideToMove(fen) !== side) return;
    if (game.controllers[side] !== "engine") return;
    if (gameStatus(fen).over) return;

    // When *both* sides are engine-controlled, a human's own reaction time
    // isn't there to pace the game -- top the delay before this move up to
    // playbackDelayMs so a fully-automated game stays watchable instead of
    // flashing by at whatever speed the engines move.
    const fullyAutomated = game.controllers.w === "engine" && game.controllers.b === "engine";
    const topUpMs = fullyAutomated ? Math.max(0, game.playbackDelayMs - engine.movetimeMs) : 0;

    const send = () => {
      // Re-check status: Stop or a crash may have landed during the delay.
      if (useEngineStore.getState().status !== "ready") return;
      useEngineStore.setState({ status: "thinking", searchInfoHistory: [], lastInfo: null });
      const moves = game.plies.map((p) => p.uci);
      const positionCmd = buildPositionCommand(moves);
      const goCmd = buildGoCommand(engine.movetimeMs);
      logDebug(`sending: ${positionCmd}`);
      logDebug(`sending: ${goCmd}`);
      invoke("engine_write_line", { side, line: positionCmd })
        .then(() => invoke("engine_write_line", { side, line: goCmd }))
        .catch((err) => failEngine("error", String(err)));
    };

    if (topUpMs > 0) {
      window.setTimeout(send, topUpMs);
    } else {
      send();
    }
  }

  /** Installs the stdout/exit event listeners and the turn-watcher exactly
   * once per store instance (so once per side, per app lifetime). */
  function installListenersOnce() {
    if (listenersInstalled) return;
    listenersInstalled = true;

    void listen<string>(`engine-stdout-${side}`, (event) => {
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

    void listen<EngineExitPayload>(`engine-exit-${side}`, (event) => {
      if (stopRequested) {
        // Expected -- this is the exit our own stopEngine() caused.
        stopRequested = false;
        return;
      }
      failEngine("crashed", formatEngineExitMessage(event.payload));
    });

    useGameStore.subscribe((state, prevState) => {
      if (state.plies.length !== prevState.plies.length) {
        maybeRequestEngineMove();
      }
    });
  }

  const useEngineStore = create<EngineStoreState>()(
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
          // Re-entrancy guard: a double-click (or any duplicate call while a
          // start is already in flight) would otherwise spawn a second
          // process, whose Rust-side startup kills the first one mid-flight
          // and surfaces as a spurious "engine process exited unexpectedly".
          if (!NOT_RUNNING.has(get().status)) return;

          // A stray, delayed engine-exit event tied to a *previous* stop
          // (e.g. one that was a no-op because nothing was running, so the
          // listener above never got to consume the latch) must never
          // suppress a crash report for this fresh engine lifecycle.
          stopRequested = false;
          installListenersOnce();
          // A fresh debug log per game, per the mandate that it must never
          // grow unbounded across a long session -- app launch clears it too
          // (see src-tauri/src/lib.rs's .setup() hook), this covers "new game".
          invoke("debug_log_clear").catch(() => {});
          set({
            status: "starting",
            path,
            errorMessage: null,
            lastInfo: null,
            searchInfoHistory: [],
            options: [],
            optionValues: {},
          });
          logDebug(`starting engine: ${path}`);
          try {
            await invoke("engine_start", { side, path });
            // Triggers the id/option/uciok handshake burst so `options`
            // populates. Fire-and-forget: the existing position/go flow
            // already works without waiting on uciok, so this doesn't
            // change the ready/turn-orchestration timing at all.
            void invoke("engine_write_line", { side, line: "uci" });
            set({ status: "ready" });
            logDebug("engine ready");
            // Deliberately does NOT call enterPlayMode()/checkTurn() here --
            // when two engines are starting at once (engine-vs-engine mode),
            // the first one ready must not unlock moves or ask itself to go
            // before anyone knows whether the *other* requested engine will
            // start at all. The caller is responsible for calling
            // gameStore.enterPlayMode() and this store's own checkTurn()
            // only once everything it started has confirmed ready -- same
            // reasoning as the existing startNewGame/enterPlayMode split.
          } catch (err) {
            failEngine("error", String(err));
          }
        },

        stopEngine: async () => {
          logDebug("stop requested");
          // See the `stopRequested` declaration above for why this latch
          // exists -- it must be set before the invoke, not after.
          stopRequested = true;
          try {
            await invoke("engine_stop", { side });
          } finally {
            // Clearing errorMessage here is what makes "Stop" actually
            // dismiss a displayed crash/error -- previously it didn't, so a
            // stale "engine process exited unexpectedly" stuck around with
            // no way to clear it short of restarting the whole app.
            set({ status: "idle", lastInfo: null, searchInfoHistory: [], errorMessage: null });
            // loadGame([]) resets the board back to the starting position
            // (plies/ply cleared) in addition to exitPlayMode()'s own
            // effect (mode back to "replay", selection cleared) -- a
            // deliberate, user-requested Stop should leave a clean board
            // to start the next game from, not the position the last game
            // ended at. This is intentionally *not* shared with
            // failEngine()'s crash path below (still just exitPlayMode()):
            // a crash should leave the position on screen for diagnosis,
            // not silently erase the evidence.
            useGameStore.getState().loadGame([]);
          }
        },

        checkTurn: () => maybeRequestEngineMove(),

        stopSearch: () => {
          if (useEngineStore.getState().status !== "thinking") return;
          logDebug("stop search requested");
          invoke("engine_write_line", { side, line: "stop" }).catch(() => {});
        },
      }),
      {
        name: `chess-board-engine-${side}`,
        partialize: (state) => ({ path: state.path, movetimeMs: state.movetimeMs }),
      },
    ),
  );

  return useEngineStore;
}

export const useWhiteEngineStore = createEngineStore("w");
export const useBlackEngineStore = createEngineStore("b");

/** The hook type returned by `engineStoreForSide` -- for components that
 * need to accept "whichever side's engine store" as a prop (e.g. a shared
 * display component rendered once per side). */
export type EngineStoreHook = UseBoundStore<StoreApi<EngineStoreState>>;

export function engineStoreForSide(side: Side): EngineStoreHook {
  return side === "w" ? useWhiteEngineStore : useBlackEngineStore;
}
