import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTerminalStatus, parseLichessAccountEvent, parseLichessLine } from "../lib/lichess";
import { engineStoreForSide } from "./engineStore";
import { useGameStore } from "./gameStore";
import { movesToApply, pendingMoveToSend } from "./lichessStore";

export type LichessBotStatus = "idle" | "listening" | "playing" | "error";

interface LichessBotStoreState {
  /** This mode's engine choice, independent of the White/Black engine
   * slots -- Bot API mode doesn't know which color Lichess will assign
   * the bot until a challenge actually arrives, so it can't pin its
   * engine choice to either per-side store the way Human-vs-Engine mode
   * pins its one engine to "whichever color the human didn't pick."
   * `handleGameStart` copies this into whichever side's store the bot
   * actually ends up playing, right before starting it. */
  enginePath: string | null;
  movetimeMs: number;
  status: LichessBotStatus;
  errorMessage: string | null;
  activeGameId: string | null;
  lastSentUci: string | null;

  setEnginePath: (path: string) => void;
  setMovetimeMs: (ms: number) => void;
  /** Irreversible on Lichess's side -- see lichess.rs's lichess_bot_upgrade
   * doc comment. The caller (the UI) is responsible for a separate,
   * explicit confirmation step before calling this. Returns whether it
   * succeeded, so the UI can decide what to do next (e.g. clear a
   * confirmation field only on success) without needing a try/catch. */
  upgradeToBotAccount: () => Promise<boolean>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
}

/** Fire-and-forget append to the on-disk debug log, same convention as
 * engineStore.ts/lichessStore.ts. */
function logDebug(message: string) {
  invoke("debug_log_append", { message: `[lichess-bot] ${message}` }).catch(() => {});
}

/** Every path that ends the current bot game goes through here, pairing
 * status + gameStore.exitPlayMode -- same reasoning as engineStore's
 * failEngine and lichessStore's failLichess. Listening for the *next*
 * challenge is a separate concern from the current game, so this
 * deliberately doesn't tear down the account event stream. */
function failBot(message: string) {
  logDebug(`FAILED: ${message}`);
  useLichessBotStore.setState({ status: "error", errorMessage: message, activeGameId: null });
  useGameStore.getState().exitPlayMode();
}

async function handleChallenge(challengeId: string) {
  logDebug(`auto-accepting challenge: ${challengeId}`);
  try {
    await invoke("lichess_challenge_accept", { challengeId });
  } catch (err) {
    // A single rejected/expired challenge isn't fatal to the listening
    // session -- log it and keep listening for the next one, rather than
    // tearing the whole connection down over one bad challenge.
    logDebug(`failed to accept challenge ${challengeId}: ${String(err)}`);
  }
}

async function handleGameStart(gameId: string, botColor: "w" | "b") {
  const { enginePath, movetimeMs } = useLichessBotStore.getState();
  if (!enginePath) {
    failBot("a game started, but no engine binary is selected");
    return;
  }
  const engine = engineStoreForSide(botColor);

  logDebug(`game starting: ${gameId}, engine plays ${botColor}`);
  useLichessBotStore.setState({ activeGameId: gameId, lastSentUci: null, errorMessage: null });

  // Same ordering as EngineControls/LichessControls: reset the board
  // *before* the engine or the game stream is confirmed, so nothing stale
  // from a previous game can land on the fresh one.
  useGameStore.getState().startNewGame({
    w: botColor === "w" ? "engine" : "lichess",
    b: botColor === "w" ? "lichess" : "engine",
  });
  try {
    // This mode's own movetime choice (see enginePath's doc comment) has
    // to be copied into whichever side's store actually starts, since
    // that store's own persisted movetimeMs may be stale from a different
    // mode entirely.
    engine.getState().setMovetimeMs(movetimeMs);
    await engine.getState().startEngine(enginePath);
    // startEngine never rejects on failure (it reports failure via status +
    // errorMessage instead) -- must check the resulting status explicitly.
    if (engine.getState().status !== "ready") {
      failBot(engine.getState().errorMessage ?? "engine failed to start");
      return;
    }
    await invoke("lichess_bot_stream_game", { gameIdOrUrl: gameId });
    // Only unlock moves once *both* the engine and the bot game stream have
    // confirmed ready -- startEngine deliberately no longer does this
    // itself (see its own doc comment), so this store owns the ordering.
    useGameStore.getState().enterPlayMode();
    engine.getState().checkTurn();
    useLichessBotStore.setState({ status: "playing" });
  } catch (err) {
    failBot(String(err));
  }
}

function applyIncomingBotMoves(update: ReturnType<typeof parseLichessLine>) {
  if (!update) return;
  // Same movesToApply diff as lichessStore's human-play path -- it's
  // agnostic to *who* made a given move, so it also correctly no-ops on
  // Lichess echoing the engine's own move back.
  const newMoves = movesToApply(update.moves, useGameStore.getState().plies.length);
  for (const uci of newMoves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    const applied = useGameStore.getState().attemptMove(from, to, promotion);
    if (!applied) {
      failBot(`lichess sent an illegal move: ${uci}`);
      return;
    }
  }

  if (isTerminalStatus(update.status)) {
    logDebug(`game over: ${update.status}`);
    // Ask the engine to stop searching if it's mid-move -- the engine's
    // resulting `bestmove` is then dropped by applyEngineBestMove's late-
    // bestmove guard. Without this, the engine keeps its search context
    // for the next game and (worse) the incoming bestmove would have been
    // applied to the board and attempted-POST to a closed Lichess stream.
    const engineSide = useGameStore.getState().controllers.w === "engine" ? "w" : "b";
    engineStoreForSide(engineSide).getState().stopSearch();
    useLichessBotStore.setState({ status: "listening", activeGameId: null });
    useGameStore.getState().exitPlayMode();
    invoke("lichess_stop_game").catch(() => {});
  }
}

/** Sends the engine's own just-made move to Lichess -- the Bot API
 * counterpart to lichessStore's maybeSendHumanMove. The engine's side is
 * whichever one `controllers` marks `"engine"` -- exactly one side, since
 * this mode always pairs one local engine against the Lichess opponent. */
function maybeSendEngineMove() {
  const bot = useLichessBotStore.getState();
  const game = useGameStore.getState();
  if (bot.status !== "playing" || !bot.activeGameId) return;
  if (game.mode !== "play" || game.ply !== game.plies.length) return;

  const engineSide = game.controllers.w === "engine" ? "w" : "b";
  const uci = pendingMoveToSend(game.plies, engineSide, bot.lastSentUci);
  if (!uci) return;

  useLichessBotStore.setState({ lastSentUci: uci });
  logDebug(`sending engine move: ${uci}`);
  invoke("lichess_bot_make_move", { gameIdOrUrl: bot.activeGameId, uciMove: uci }).catch((err) =>
    failBot(String(err)),
  );
}

let listenersInstalled = false;

function installListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void listen<string>("lichess-event-stream", (event) => {
    const parsed = parseLichessAccountEvent(event.payload);
    if (!parsed) return;
    if (parsed.type === "challenge") {
      void handleChallenge(parsed.challengeId);
    } else {
      void handleGameStart(parsed.gameId, parsed.botColor);
    }
  });

  void listen<string>("lichess-event-exit", (event) => {
    if (useLichessBotStore.getState().status !== "idle") {
      failBot(event.payload);
    }
  });

  void listen<string>("lichess-bot-game-stream", (event) => {
    applyIncomingBotMoves(parseLichessLine(event.payload));
  });

  void listen<string>("lichess-bot-game-exit", (event) => {
    if (useLichessBotStore.getState().status === "playing") {
      failBot(event.payload);
    }
  });

  useGameStore.subscribe((state, prevState) => {
    if (state.plies.length !== prevState.plies.length) {
      maybeSendEngineMove();
    }
  });
}

const NOT_LISTENING = new Set<LichessBotStatus>(["idle", "error"]);

export const useLichessBotStore = create<LichessBotStoreState>()(
  persist(
    (set, get) => ({
      enginePath: null,
      movetimeMs: 1000,
      status: "idle",
      errorMessage: null,
      activeGameId: null,
      lastSentUci: null,

      setEnginePath: (enginePath) => set({ enginePath }),
      setMovetimeMs: (movetimeMs) => set({ movetimeMs }),

      upgradeToBotAccount: async () => {
        logDebug("requesting bot account upgrade");
        try {
          await invoke("lichess_bot_upgrade");
          set({ errorMessage: null });
          return true;
        } catch (err) {
          set({ errorMessage: String(err) });
          return false;
        }
      },

      startListening: async () => {
        // Re-entrancy guard, same reasoning as engineStore/lichessStore.
        if (!NOT_LISTENING.has(get().status)) return;

        installListenersOnce();
        set({ status: "listening", errorMessage: null, activeGameId: null, lastSentUci: null });
        logDebug("listening for challenges");
        try {
          await invoke("lichess_stream_events");
        } catch (err) {
          failBot(String(err));
        }
      },

      stopListening: async () => {
        logDebug("stop listening requested");
        try {
          await invoke("lichess_stop_events");
          await invoke("lichess_stop_game");
        } finally {
          set({ status: "idle", errorMessage: null, activeGameId: null });
          useGameStore.getState().exitPlayMode();
        }
      },
    }),
    {
      name: "chess-board-lichess-bot-engine",
      partialize: (state) => ({ enginePath: state.enginePath, movetimeMs: state.movetimeMs }),
    },
  ),
);
