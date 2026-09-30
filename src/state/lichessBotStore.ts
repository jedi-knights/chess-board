import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  decideChallenge,
  isTerminalStatus,
  parseLichessAccountEvent,
  parseLichessLine,
  type LichessAccountInfo,
  type LichessChallengeEvent,
  type LichessDeclineReason,
} from "../lib/lichess";
import { engineStoreForSide } from "./engineStore";
import { useGameStore } from "./gameStore";
import { movesToApply, pendingMoveToSend } from "./lichessStore";

export type LichessBotStatus = "idle" | "listening" | "playing" | "error";

/** See `HUMAN_SLOT` in lichessStore.ts -- this module's counterpart for
 * the Bot slot. Rust decides which keychain entry gets read; JS just
 * tags every call with the string discriminator. */
const BOT_SLOT = "bot" as const;

interface LichessBotStoreState {
  /** Whether a bot-slot token is currently stored in the OS keychain. */
  hasToken: boolean;
  /** Last verify result for the bot slot; see the human-side counterpart
   * in `lichessStore.ts` for the same rationale. */
  verifiedAccount: LichessAccountInfo | null;
  verifyError: string | null;
  /** Persisted preference: whether to accept rated challenges. Default
   * `false`, on purpose -- a bot testing an engine shouldn't affect
   * other players' ratings unless the operator has explicitly opted in.
   * See `decideChallenge` in `src/lib/lichess.ts` for the enforcement. */
  acceptRated: boolean;
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

  refreshHasToken: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
  /** Live-fetch `/api/account` under the bot slot; see human-side
   * `verifyAccount` for the same rationale. */
  verifyAccount: () => Promise<void>;
  setEnginePath: (path: string) => void;
  setMovetimeMs: (ms: number) => void;
  setAcceptRated: (v: boolean) => void;
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

async function declineChallenge(challengeId: string, reason: LichessDeclineReason) {
  logDebug(`declining challenge ${challengeId} (${reason})`);
  try {
    await invoke("lichess_challenge_decline", {
      slot: BOT_SLOT,
      challengeId,
      reason,
    });
  } catch (err) {
    // A single rejected/expired decline isn't fatal to the listening
    // session -- same reasoning as accept failures below.
    logDebug(`failed to decline challenge ${challengeId}: ${String(err)}`);
  }
}

async function acceptChallenge(challengeId: string) {
  logDebug(`accepting challenge: ${challengeId}`);
  try {
    await invoke("lichess_challenge_accept", { slot: BOT_SLOT, challengeId });
  } catch (err) {
    // A single rejected/expired challenge isn't fatal to the listening
    // session -- log it and keep listening for the next one, rather than
    // tearing the whole connection down over one bad challenge.
    logDebug(`failed to accept challenge ${challengeId}: ${String(err)}`);
  }
}

async function handleChallenge(challenge: LichessChallengeEvent) {
  const state = useLichessBotStore.getState();
  const decision = decideChallenge(challenge, {
    myAccountId: state.verifiedAccount?.id ?? null,
    acceptRated: state.acceptRated,
    activeGameId: state.activeGameId,
  });
  logDebug(
    `challenge ${challenge.challengeId} from ${challenge.challenger?.id ?? "?"}: ` +
      `variant=${challenge.variant} speed=${challenge.speed} rated=${challenge.rated} ` +
      `initialFen=${challenge.initialFen ? "custom" : "startpos"} -> ${
        decision.kind === "accept"
          ? "accept"
          : decision.kind === "decline"
            ? `decline(${decision.reason})`
            : `drop(${decision.because})`
      }`,
  );
  if (decision.kind === "accept") {
    await acceptChallenge(challenge.challengeId);
  } else if (decision.kind === "decline") {
    await declineChallenge(challenge.challengeId, decision.reason);
  }
  // "drop" deliberately does nothing -- e.g. self-challenges can't be
  // declined (Lichess 400s a self-decline) and letting Lichess time
  // them out is the correct behavior.
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
    switch (parsed.type) {
      case "challenge":
        void handleChallenge(parsed);
        break;
      case "gameStart":
        void handleGameStart(parsed.gameId, parsed.botColor);
        break;
      case "challengeCanceled":
        logDebug(`challenge ${parsed.challengeId} canceled by challenger`);
        break;
      case "challengeDeclined":
        // The bot never issues outgoing challenges today, so this
        // arrives only when Lichess echoes back our own decline. Log
        // it for the timeline, but do nothing -- the decline was our
        // own action.
        logDebug(
          `challenge ${parsed.challengeId} declined${parsed.reason ? ` (${parsed.reason})` : ""}`,
        );
        break;
      case "gameFinish":
        // Redundant with the terminal status inside the game stream,
        // which also flips status to "listening". Kept as a defense-
        // in-depth log line: if the game stream missed the terminal
        // status for any reason, this confirms the game ended.
        logDebug(`gameFinish event for ${parsed.gameId}`);
        break;
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
      hasToken: false,
      verifiedAccount: null,
      verifyError: null,
      acceptRated: false,
      enginePath: null,
      movetimeMs: 1000,
      status: "idle",
      errorMessage: null,
      activeGameId: null,
      lastSentUci: null,

      refreshHasToken: async () => {
        const hasToken = await invoke<boolean>("lichess_token_has", { slot: BOT_SLOT }).catch(
          () => false,
        );
        set({ hasToken });
      },

      setToken: async (token) => {
        await invoke("lichess_token_set", { slot: BOT_SLOT, token });
        set({ hasToken: true, verifiedAccount: null, verifyError: null });
      },

      clearToken: async () => {
        await invoke("lichess_token_clear", { slot: BOT_SLOT });
        set({ hasToken: false, verifiedAccount: null, verifyError: null });
      },

      verifyAccount: async () => {
        try {
          const info = await invoke<LichessAccountInfo>("lichess_verify_account", {
            slot: BOT_SLOT,
          });
          set({ verifiedAccount: info, verifyError: null });
          logDebug(`verified: ${info.username} (isBot=${info.isBot})`);
        } catch (err) {
          set({ verifiedAccount: null, verifyError: String(err) });
          logDebug(`verify failed: ${String(err)}`);
        }
      },

      setEnginePath: (enginePath) => set({ enginePath }),
      setMovetimeMs: (movetimeMs) => set({ movetimeMs }),
      setAcceptRated: (acceptRated) => set({ acceptRated }),

      upgradeToBotAccount: async () => {
        logDebug("requesting bot account upgrade");
        try {
          await invoke("lichess_bot_upgrade");
          // Upgrade succeeded -- Rust already invalidated its cache; drop
          // ours so the UI re-verifies and shows the new (BOT) title
          // instead of the stale "regular account" one.
          set({ errorMessage: null, verifiedAccount: null, verifyError: null });
          return true;
        } catch (err) {
          set({ errorMessage: String(err) });
          return false;
        }
      },

      startListening: async () => {
        // Re-entrancy guard, same reasoning as engineStore/lichessStore.
        if (!NOT_LISTENING.has(get().status)) return;

        // Fair-play guard, mirrored on the frontend for a fast, clear
        // error: Rust's `token_for_slot_verified` will also refuse a
        // non-BOT account on the bot slot, but running the check locally
        // when the cached verify result already answers it avoids a
        // needless HTTP round-trip just to produce the same error.
        const verified = get().verifiedAccount;
        if (verified && !verified.isBot) {
          failBot(
            `the bot slot's token belongs to a non-BOT account ("${verified.username}") -- either use the human slot or upgrade this account to BOT`,
          );
          return;
        }

        installListenersOnce();
        set({ status: "listening", errorMessage: null, activeGameId: null, lastSentUci: null });
        logDebug("listening for challenges");
        try {
          await invoke("lichess_stream_events", { slot: BOT_SLOT });
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
      partialize: (state) => ({
        enginePath: state.enginePath,
        movetimeMs: state.movetimeMs,
        acceptRated: state.acceptRated,
      }),
    },
  ),
);
