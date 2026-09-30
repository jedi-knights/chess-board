import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  decideChallenge,
  isTerminalStatus,
  parseLichessLine,
  parseLichessOpponentGone,
  type LichessAccountEvent,
  type LichessAccountInfo,
  type LichessChallengeEvent,
  type LichessDeclineReason,
  type LichessMoveUpdate,
  type LichessOpponentGone,
} from "../lib/lichess";
import { installLichessEventBusOnce } from "../lib/lichessEventBus";
import type { GoOptions } from "../lib/uci";
import { ENGINE_NOT_RUNNING, engineStoreForSide } from "./engineStore";
import { useGameStore } from "./gameStore";
import { movesToApply, pendingMoveToSend, type LiveClocks } from "./lichessStore";

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
  /** Persisted milliseconds to subtract from the engine's own-clock
   * value in `go wtime/btime` so network and IPC latency doesn't push
   * a tight game into a time forfeit. Default 100 ms. */
  lagMarginMs: number;
  /** Most recent server clock snapshot for the live game -- shared shape
   * with lichessStore. Populated by every `gameState` update, cleared
   * on game end and on stopListening. */
  serverClocks: LiveClocks | null;
  /** Opponent-gone state from the game stream. Same shape and role as
   * `lichessStore.opponentGone`; `LiveGameActions` reads it to render
   * the countdown and enable the Claim Victory button. */
  opponentGone: LichessOpponentGone | null;
  /** This mode's engine choice, independent of the White/Black engine
   * slots -- Bot API mode doesn't know which color Lichess will assign
   * the bot until a challenge actually arrives, so it can't pin its
   * engine choice to either per-side store the way Human-vs-Engine mode
   * pins its one engine to "whichever color the human didn't pick."
   * `handleGameStart` copies this into whichever side's store the bot
   * actually ends up playing, right before starting it. */
  enginePath: string | null;
  /** Movetime *cap* in bot mode: `go` always includes clock fields when
   * a clock game is live, and `movetime` alongside them acts as an
   * upper bound the engine won't exceed. Not the engine's own thinking
   * budget the way it is in human-vs-engine/engine-vs-engine. */
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
  /** OAuth 2.0 + PKCE login for the bot slot. Same shape as the
   * human-side counterpart; requests bot-specific scopes
   * (`bot:play` + `challenge:write`). */
  oauthLogin: () => Promise<void>;
  setEnginePath: (path: string) => void;
  setMovetimeMs: (ms: number) => void;
  setAcceptRated: (v: boolean) => void;
  setLagMarginMs: (ms: number) => void;
  /** Irreversible on Lichess's side -- see lichess.rs's lichess_bot_upgrade
   * doc comment. The caller (the UI) is responsible for a separate,
   * explicit confirmation step before calling this. Returns whether it
   * succeeded, so the UI can decide what to do next (e.g. clear a
   * confirmation field only on success) without needing a try/catch. */
  upgradeToBotAccount: () => Promise<boolean>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  /** In-game actions (Bot API). Same set as the human-mode counterpart:
   * resign, abort, draw agree/decline, claim-victory. All target the
   * currently-active game id; `null` is a defensive no-op. */
  resign: () => Promise<void>;
  abort: () => Promise<void>;
  agreeToDraw: () => Promise<void>;
  declineDraw: () => Promise<void>;
  claimVictory: () => Promise<void>;
  /** Called by `lichessEventBus` for every event that arrives on the
   * account event stream while `engine-vs-lichess` is the active mode.
   * The bus, not this store, owns the raw Tauri listener. */
  handleAccountEvent: (event: LichessAccountEvent) => void;
  /** Called by `lichessEventBus` when the account event stream itself
   * ends (server closed, network drop). Only surfaces as a failure when
   * we were actually using it. */
  handleEventStreamExit: (reason: string) => void;
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

/** Clock-driven `go`-options builder installed on the engine store for
 * the duration of a bot game. Reads the *current* store state on each
 * call so a mid-game `setLagMarginMs`/`setMovetimeMs` takes effect
 * immediately.
 *
 * The bot's own clock -- and *only* the bot's own clock -- is adjusted
 * for two things Lichess doesn't report:
 *   1. `elapsed`: milliseconds between Lichess reporting the clock and
 *      this call. The server's reported wtime/btime is stale by roughly
 *      the network round-trip; the ticking side has burned that time
 *      already.
 *   2. `lagMarginMs`: headroom for this app's *own* IPC + HTTP latency
 *      going the other direction (engine bestmove -> POST /move ->
 *      server sees it).
 *
 * The opponent's clock is left at what Lichess reported: while the bot
 * is thinking, the opponent's clock isn't ticking, and no one owes the
 * opponent a lag margin. Movetime is included as an upper cap. Falls
 * back to plain movetime when the update stream hasn't reported any
 * clock at all (correspondence, unlimited). */
function buildBotGoOptions(botColor: "w" | "b"): GoOptions {
  const { serverClocks, lagMarginMs, movetimeMs } = useLichessBotStore.getState();
  if (!serverClocks) {
    return { movetimeMs };
  }
  const elapsed = Math.max(0, Date.now() - serverClocks.updatedAtMs);
  const ownAdjustment = elapsed + lagMarginMs;
  const wtimeMs =
    botColor === "w"
      ? Math.max(1, serverClocks.wtimeMs - ownAdjustment)
      : serverClocks.wtimeMs;
  const btimeMs =
    botColor === "b"
      ? Math.max(1, serverClocks.btimeMs - ownAdjustment)
      : serverClocks.btimeMs;
  return {
    wtimeMs,
    btimeMs,
    wincMs: serverClocks.wincMs,
    bincMs: serverClocks.bincMs,
    movetimeMs,
  };
}

async function handleGameStart(gameId: string, botColor: "w" | "b") {
  const { enginePath, movetimeMs } = useLichessBotStore.getState();
  if (!enginePath) {
    failBot("a game started, but no engine binary is selected");
    return;
  }
  const engine = engineStoreForSide(botColor);

  logDebug(`game starting: ${gameId}, engine plays ${botColor}`);
  useLichessBotStore.setState({
    activeGameId: gameId,
    lastSentUci: null,
    errorMessage: null,
    serverClocks: null,
    opponentGone: null,
  });

  // Same ordering as EngineControls/LichessControls: reset the board
  // *before* the engine or the game stream is confirmed, so nothing stale
  // from a previous game can land on the fresh one.
  useGameStore.getState().startNewGame({
    w: botColor === "w" ? "engine" : "lichess",
    b: botColor === "w" ? "lichess" : "engine",
  });
  try {
    const engineState = engine.getState();
    // Between-games reuse: if the same engine binary is already ready,
    // just send `ucinewgame` + `isready` and reuse the process. This is
    // materially faster than a full stop/start on a real engine (opening
    // book / hash table warmup) and avoids the "startEngine no-ops on
    // status=ready" trap that CLAUDE.md called out.
    const canReuse =
      engineState.status === "ready" && engineState.path === enginePath;
    if (canReuse) {
      logDebug("reusing ready engine via ucinewgame + isready");
      engine.getState().setMovetimeMs(movetimeMs);
      engine.getState().newGame();
    } else {
      // Different binary or stale state: fully stop-and-start. Stop only
      // when actually running -- an idle/error/crashed status has no
      // process to stop.
      if (!ENGINE_NOT_RUNNING.has(engineState.status)) {
        logDebug("engine changed or not ready -- stopping first");
        await engine.getState().stopEngine();
      }
      engine.getState().setMovetimeMs(movetimeMs);
      await engine.getState().startEngine(enginePath);
      // startEngine never rejects on failure (it reports failure via status +
      // errorMessage instead) -- must check the resulting status explicitly.
      if (engine.getState().status !== "ready") {
        failBot(engine.getState().errorMessage ?? "engine failed to start");
        return;
      }
    }

    // Install the clock-aware `go` builder for the duration of this
    // game. Every subsequent `maybeRequestEngineMove` reads live
    // clocks; the builder is cleared on game end / stopListening so
    // human-vs-engine and engine-vs-engine modes continue to use the
    // default movetime-only path.
    engine.getState().setGoBuilder(() => buildBotGoOptions(botColor));

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

/** Snapshots the update's clock fields into the bot store *before* the
 * moves in the same update are applied, so any engine-side `go` that
 * fires from the `attemptMove` → gameStore-subscribe chain reads the
 * freshest clocks rather than the previous update's stale ones. Returns
 * the *previous* snapshot for use in the post-loop think-time
 * annotation. */
function commitServerClocksEarly(update: LichessMoveUpdate) {
  const prev = useLichessBotStore.getState().serverClocks;
  if (update.wtimeMs !== null && update.btimeMs !== null) {
    useLichessBotStore.setState({
      serverClocks: {
        wtimeMs: update.wtimeMs,
        btimeMs: update.btimeMs,
        wincMs: update.wincMs ?? 0,
        bincMs: update.bincMs ?? 0,
        updatedAtMs: Date.now(),
      },
    });
  }
  return prev;
}

/** Uses the captured pre-update clocks to compute think-time for a
 * single new ply. Multi-move catch-ups on reconnect and no-clock games
 * (correspondence, unlimited) leave the ply un-annotated (`undefined`
 * in the move log) rather than fabricating a value. Same reasoning as
 * the human-mode counterpart in lichessStore.ts. */
function annotateLastPlyThinkTime(
  prev: LiveClocks | null,
  update: LichessMoveUpdate,
  appliedCount: number,
) {
  if (appliedCount !== 1 || !prev) return;
  const lastPly = useGameStore.getState().plies.at(-1);
  if (!lastPly) return;
  const color = lastPly.color;
  const prevTimeMs = color === "w" ? prev.wtimeMs : prev.btimeMs;
  const newTimeMs = color === "w" ? update.wtimeMs : update.btimeMs;
  const incMs = color === "w" ? prev.wincMs : prev.bincMs;
  if (newTimeMs === null) return;
  const thinkTimeSeconds = Math.max(0, (prevTimeMs + incMs - newTimeMs) / 1000);
  useGameStore.getState().annotateLastPly({
    thinkTimeSeconds,
    clockSeconds: newTimeMs / 1000,
  });
}

function applyIncomingBotMoves(update: ReturnType<typeof parseLichessLine>) {
  if (!update) return;
  // Update serverClocks *before* the move loop -- attemptMove fires
  // gameStore.subscribe synchronously, and engineStore's subscriber
  // reads `serverClocks` inside `buildBotGoOptions` to build the `go`
  // line. If clocks were updated after, the engine would see the
  // *previous* update's values on every second and subsequent go, which
  // in bullet games would consistently over-allocate.
  const prevClocks = commitServerClocksEarly(update);

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

  annotateLastPlyThinkTime(prevClocks, update, newMoves.length);

  if (isTerminalStatus(update.status)) {
    logDebug(`game over: ${update.status}`);
    // Ask the engine to stop searching if it's mid-move -- the engine's
    // resulting `bestmove` is then dropped by applyEngineBestMove's late-
    // bestmove guard. Without this, the engine keeps its search context
    // for the next game and (worse) the incoming bestmove would have been
    // applied to the board and attempted-POST to a closed Lichess stream.
    const engineSide = useGameStore.getState().controllers.w === "engine" ? "w" : "b";
    const engine = engineStoreForSide(engineSide);
    engine.getState().stopSearch();
    // Clear the clock-aware go builder: the next game will re-install
    // it, but between games (in the "listening" state) any spurious
    // engine trigger should fall back to the default movetime path.
    engine.getState().setGoBuilder(null);
    useLichessBotStore.setState({
      status: "listening",
      activeGameId: null,
      serverClocks: null,
      opponentGone: null,
    });
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

/** Dispatched to by `lichessEventBus.dispatch` when the mode preset is
 * `engine-vs-lichess`. Split into a store-level action rather than a
 * module-local closure so tests can drive the same code path without
 * touching the raw Tauri listener seam. */
function routeAccountEvent(event: LichessAccountEvent) {
  switch (event.type) {
    case "challenge":
      void handleChallenge(event);
      break;
    case "gameStart":
      void handleGameStart(event.gameId, event.botColor);
      break;
    case "challengeCanceled":
      logDebug(`challenge ${event.challengeId} canceled by challenger`);
      break;
    case "challengeDeclined":
      // The bot never issues outgoing challenges today, so this
      // arrives only when Lichess echoes back our own decline. Log
      // it for the timeline, but do nothing -- the decline was our
      // own action.
      logDebug(
        `challenge ${event.challengeId} declined${event.reason ? ` (${event.reason})` : ""}`,
      );
      break;
    case "gameFinish":
      // Redundant with the terminal status inside the game stream,
      // which also flips status to "listening". Kept as a defense-
      // in-depth log line: if the game stream missed the terminal
      // status for any reason, this confirms the game ended.
      logDebug(`gameFinish event for ${event.gameId}`);
      break;
  }
}

let listenersInstalled = false;

/** The bot-mode game stream (`lichess-bot-game-stream` /
 * `lichess-bot-game-exit`) is unique to this store, so its raw listeners
 * still live here. The *account* event stream is shared with
 * `lichessStore` via `lichessEventBus` -- both routes converge on
 * `handleAccountEvent` below. */
function installBotGameStreamListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void listen<string>("lichess-bot-game-stream", (event) => {
    // Same dual-parse shape as lichessStore's human-mode listener --
    // moves and opponentGone lines share the same NDJSON channel.
    const move = parseLichessLine(event.payload);
    if (move) applyIncomingBotMoves(move);
    const gone = parseLichessOpponentGone(event.payload);
    if (gone) {
      useLichessBotStore.setState({ opponentGone: gone });
      logDebug(
        `opponent ${gone.gone ? "gone" : "back"}${
          gone.claimWinInSeconds !== null ? ` (claim in ${gone.claimWinInSeconds}s)` : ""
        }`,
      );
    }
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
      lagMarginMs: 100,
      serverClocks: null,
      opponentGone: null,
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

      oauthLogin: async () => {
        logDebug("oauth login requested");
        try {
          const info = await invoke<LichessAccountInfo>("lichess_oauth_login", {
            slot: BOT_SLOT,
          });
          set({
            hasToken: true,
            verifiedAccount: info,
            verifyError: null,
          });
          logDebug(`oauth login succeeded as ${info.username}`);
        } catch (err) {
          set({ verifyError: String(err) });
          logDebug(`oauth login failed: ${String(err)}`);
        }
      },

      setEnginePath: (enginePath) => set({ enginePath }),
      setMovetimeMs: (movetimeMs) => set({ movetimeMs }),
      setAcceptRated: (acceptRated) => set({ acceptRated }),
      setLagMarginMs: (lagMarginMs) => set({ lagMarginMs }),

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

        installBotGameStreamListenersOnce();
        installLichessEventBusOnce();
        set({ status: "listening", errorMessage: null, activeGameId: null, lastSentUci: null });
        logDebug("listening for challenges");
        try {
          await invoke("lichess_stream_events", { slot: BOT_SLOT });
        } catch (err) {
          failBot(String(err));
        }
      },

      resign: async () => {
        const id = useLichessBotStore.getState().activeGameId;
        if (!id) return;
        logDebug("resign requested");
        try {
          await invoke("lichess_bot_resign", { gameIdOrUrl: id });
        } catch (err) {
          failBot(String(err));
        }
      },

      abort: async () => {
        const id = useLichessBotStore.getState().activeGameId;
        if (!id) return;
        logDebug("abort requested");
        try {
          await invoke("lichess_bot_abort", { gameIdOrUrl: id });
        } catch (err) {
          failBot(String(err));
        }
      },

      agreeToDraw: async () => {
        const id = useLichessBotStore.getState().activeGameId;
        if (!id) return;
        logDebug("draw/yes requested");
        try {
          await invoke("lichess_bot_draw", { gameIdOrUrl: id, accept: true });
        } catch (err) {
          failBot(String(err));
        }
      },

      declineDraw: async () => {
        const id = useLichessBotStore.getState().activeGameId;
        if (!id) return;
        logDebug("draw/no requested");
        try {
          await invoke("lichess_bot_draw", { gameIdOrUrl: id, accept: false });
        } catch (err) {
          failBot(String(err));
        }
      },

      claimVictory: async () => {
        const id = useLichessBotStore.getState().activeGameId;
        if (!id) return;
        logDebug("claim-victory requested");
        try {
          await invoke("lichess_bot_claim_victory", { gameIdOrUrl: id });
        } catch (err) {
          failBot(String(err));
        }
      },

      handleAccountEvent: (event) => routeAccountEvent(event),

      handleEventStreamExit: (reason) => {
        if (useLichessBotStore.getState().status !== "idle") {
          failBot(reason);
        }
      },

      stopListening: async () => {
        logDebug("stop listening requested");
        try {
          await invoke("lichess_stop_events");
          await invoke("lichess_stop_game");
        } finally {
          // Clear the clock-aware go builder on both sides -- either
          // side may hold it depending on which color the last game
          // assigned to the bot. A leaked builder would keep reading
          // stale `serverClocks` if the same engine store were later
          // reused in engine-vs-engine mode.
          engineStoreForSide("w").getState().setGoBuilder(null);
          engineStoreForSide("b").getState().setGoBuilder(null);
          set({
            status: "idle",
            errorMessage: null,
            activeGameId: null,
            serverClocks: null,
            opponentGone: null,
          });
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
        lagMarginMs: state.lagMarginMs,
      }),
    },
  ),
);
