import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  decideChallenge,
  isTerminalStatus,
  parseBotOnlineList,
  parseLichessLine,
  parseLichessOpponentGone,
  rulesFromLichessVariant,
  type LichessAccountEvent,
  type LichessAccountInfo,
  type LichessChallengeEvent,
  type LichessDeclineReason,
  type LichessMoveUpdate,
  type LichessOpponentGone,
} from "../lib/lichess";
import { installLichessEventBusOnce } from "../lib/lichessEventBus";
import { buildPgn, type PgnHeaders } from "../lib/pgnExport";
import type { GoOptions } from "../lib/uci";
import { ENGINE_NOT_RUNNING, engineStoreForSide } from "./engineStore";
import { useGameStore, type Rules } from "./gameStore";
import {
  movesToApply,
  pendingMoveToSend,
  type LichessColor,
  type LiveClocks,
  type LivePlayers,
} from "./lichessStore";

export type LichessBotStatus = "idle" | "listening" | "playing" | "error";

/** See `HUMAN_SLOT` in lichessStore.ts -- this module's counterpart for
 * the Bot slot. Rust decides which keychain entry gets read; JS just
 * tags every call with the string discriminator. */
const BOT_SLOT = "bot" as const;

/** How long to hide a bot after a decline, when Lichess doesn't tell
 * us the exact rate-limit window. 24 h matches the `bot.vsBot.day`
 * key's own daily reset cadence; a shorter TTL would surface
 * known-dead opponents to the user again before their quota resets,
 * a longer one would hide a bot that's since freed up. */
const DEFAULT_DECLINE_TTL_MS = 24 * 60 * 60 * 1000;

/** How long to hide a bot that refused bot-vs-bot challenges as a
 * policy (`noBot` decline reason / "I'm not accepting challenges
 * from bots." text). Set to one year rather than Infinity so the
 * entry eventually ages out in the pathological case where the bot
 * operator reconfigures their account to accept bots -- but
 * practically "forever" from the user's perspective. */
const NO_BOT_DECLINE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Detects whether a decline reason indicates a policy refusal of
 * bot-vs-bot challenges, as opposed to a rate-limit or variant
 * objection. Matches both the structured enum tag (`noBot`) and the
 * human-readable text Lichess surfaces by default when a bot sends
 * the reason, so this works whether the account stream delivered us
 * the code or the pre-formatted sentence. */
export function isNoBotPolicyDecline(reason: string | null): boolean {
  if (!reason) return false;
  if (reason === "noBot") return true;
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("challenges from bots") ||
    normalized.includes("challenges from bot accounts")
  );
}

/** Adds-or-refreshes an entry in the declined-bots list. If the
 * username is already there, bumps its `expiresAtMs` to the later of
 * the two (new attempt resets the clock, same shape as a sliding TTL).
 * Also prunes expired entries so the list doesn't grow unboundedly
 * across months of play. */
function upsertDeclinedBot(
  current: Array<{ username: string; expiresAtMs: number }>,
  username: string,
  ttlMs: number,
): Array<{ username: string; expiresAtMs: number }> {
  const now = Date.now();
  const alive = current.filter((e) => e.expiresAtMs > now);
  const existing = alive.find((e) => e.username === username);
  const expiresAtMs = Math.max(existing?.expiresAtMs ?? 0, now + ttlMs);
  const without = alive.filter((e) => e.username !== username);
  return [...without, { username, expiresAtMs }];
}

/** Parses `ratelimit.seconds` out of a Lichess-rejection error string
 * like `lichess rejected ...: 400 Bad Request {...,"ratelimit":{"key":
 * "bot.vsBot.day","seconds":21164}}`. Returns `null` when the field
 * isn't present, which is the common case (any other 400 shape).
 * Regex rather than full JSON parse because the whole string is
 * `prefix + " " + jsonBlob` -- splitting out the JSON is more
 * fragile than a direct field match. */
export function parseRateLimitSeconds(errorMessage: string): number | null {
  const match = errorMessage.match(/"seconds"\s*:\s*(\d+)/);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

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
  /** Persisted preference for *outgoing* challenges from the Browse-
   * Online-Bots list: color request and whether the challenge is rated.
   * Separate from `acceptRated` (which gates incoming challenges) --
   * the operator may want to deliberately rate their own bot by
   * challenging others while still rejecting rated challenges from
   * strangers. Defaults are `"white"` and `true` because the one
   * operator this app is built for prefers that; the fair-play
   * reasoning behind "default off" lives on `acceptRated`. */
  challengeColor: LichessColor;
  sendRated: boolean;
  /** Persisted clock for outgoing challenges, in Lichess's own
   * `clock.limit` (minutes) + `clock.increment` (seconds) form. The
   * (min, inc) pair determines the time-control category (Bullet /
   * Blitz / Rapid / Classical) Lichess assigns to the game; the
   * challenge UI exposes a named-preset dropdown and these two
   * fields are the authoritative state behind it. Default is
   * Blitz 5+3. */
  clockLimitMinutes: number;
  clockIncrementSeconds: number;
  /** Persisted milliseconds to subtract from the engine's own-clock
   * value in `go wtime/btime` so network and IPC latency doesn't push
   * a tight game into a time forfeit. Default 100 ms. */
  lagMarginMs: number;
  /** Most recent server clock snapshot for the live game -- shared shape
   * with lichessStore. Populated by every `gameState` update, cleared
   * on game end and on stopListening. */
  serverClocks: LiveClocks | null;
  /** Display identities (name + title) for the live game. Only `gameFull`
   * carries these; `null` outside a live game. Same role and shape as
   * lichessStore's `players` -- `LiveGameClocks` reads whichever store
   * is active to label the clocks with the actual Lichess usernames. */
  players: LivePlayers | null;
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
  /** Starting FEN captured from the *most recently accepted* incoming
   * challenge, carried across to `handleGameStart` so the fresh game
   * starts with the right `startFen` seeded on `gameStore` *before*
   * the engine's first `maybeRequestEngineMove` fires. Without this,
   * a "From Position" bot game would race: the engine sees startFen
   * = null at `enterPlayMode()` and sends a move for standard
   * startpos, which Lichess then rejects as illegal. Cleared on game
   * finish and on stopListening. `null` means a standard-startpos
   * game, which is the common case. */
  pendingStartFen: string | null;
  /** Variant of the most recently accepted challenge, carried across to
   * `handleGameStart` so the fresh game starts with the right
   * `gameStore.rules` seeded. Standard/null → "chess"; "chess960" →
   * "chess960". Cleared on game finish / stopListening alongside
   * pendingStartFen. */
  pendingRules: Rules;
  /** Base clock in ms, captured from `gameFull`'s top-level `clock.initial`
   * once per game (the only line that carries it; subsequent `gameState`
   * updates don't). Used purely by the on-disk PGN recording to populate
   * the `TimeControl` tag. `null` for correspondence/unlimited games (no
   * clock block) and between games. Paired with `clockIncrementBaseMs`
   * below -- both must be non-null to emit a TimeControl tag. */
  clockInitialMs: number | null;
  clockIncrementBaseMs: number | null;
  lastSentUci: string | null;
  /** Most recent `challengeDeclined` event on our account stream for
   * an *outgoing* challenge we sent (via "Browse online bots →
   * Challenge" or `lichess_challenge_bot`). Cleared when a new
   * outgoing challenge is sent. The `reason` is Lichess's own text,
   * e.g. "I'm not accepting challenges from bots." -- many bots
   * auto-decline bot-vs-bot. `username` is the bot that declined,
   * for the UI's "Alice declined: ..." phrasing. */
  lastOutgoingChallengeDecline: { username: string | null; reason: string | null } | null;
  /** Bot usernames we've already tried and been rejected by, with a
   * per-entry expiry timestamp (epoch ms). Populated from two sources:
   *   - `challengeDeclined` events on our account stream (bot said no)
   *   - 4xx responses from `lichess_challenge_bot` (rate limit, offline,
   *     API-level refuse)
   * The Browse-Online-Bots list is filtered through this so the user
   * doesn't re-click the same dead ends. **Persisted across sessions**
   * so a known-rate-limited bot stays hidden through a dev-server
   * restart or an overnight close -- a dev-mode Rust rebuild shouldn't
   * surface maia1 again when the user already learned it's capped.
   *
   * Entries have a TTL (default 24 h, matching Lichess's daily rate
   * window) so a bot that was limited yesterday reappears in the list
   * once its quota resets. When the Lichess 400 response includes a
   * `ratelimit.seconds` field, that exact value is used; otherwise
   * the default kicks in. Expired entries are purged lazily on each
   * filter pass and on store rehydrate. */
  declinedBots: Array<{ username: string; expiresAtMs: number }>;

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
  /** Abandon an in-flight `oauthLogin`. Same contract as the
   * human-side counterpart. */
  cancelOauthLogin: () => Promise<void>;
  setEnginePath: (path: string) => void;
  setMovetimeMs: (ms: number) => void;
  setAcceptRated: (v: boolean) => void;
  setChallengeColor: (color: LichessColor) => void;
  setSendRated: (v: boolean) => void;
  setClockLimitMinutes: (minutes: number) => void;
  setClockIncrementSeconds: (seconds: number) => void;
  setLagMarginMs: (ms: number) => void;
  /** Called by the Browse-Online-Bots UI when the user initiates a new
   * challenge: clears the previous decline-reason banner (so it isn't
   * mistaken for the result of the fresh attempt) and, on success,
   * records the target username as "pending" for the moment. */
  clearOutgoingChallengeDecline: () => void;
  /** Called when a `lichess_challenge_bot` POST fails with any status
   * -- rate limit, 400 Bad Request, offline opponent. Adds the
   * username to the declined-bots list with an expiry timestamp.
   * `rateLimitSeconds` (when present, parsed from Lichess's response
   * via `parseRateLimitSeconds`) sets a precise expiry; otherwise the
   * default 24 h TTL applies. */
  recordBotChallengeFailure: (username: string, rateLimitSeconds?: number) => void;
  /** Irreversible on Lichess's side -- see lichess.rs's lichess_bot_upgrade
   * doc comment. The caller (the UI) is responsible for a separate,
   * explicit confirmation step before calling this. Returns whether it
   * succeeded, so the UI can decide what to do next (e.g. clear a
   * confirmation field only on success) without needing a try/catch. */
  upgradeToBotAccount: () => Promise<boolean>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  /** Transient (not persisted) auto-run state. When true, the store
   * walks the current online-bot list top-to-bottom, firing challenges,
   * re-fetching the list once it's exhausted, and continuing until
   * `stopAutoRun` is called. Each iteration respects the same
   * `declinedBots` filter the Browse-Online-Bots list uses so already-
   * known-dead opponents are skipped. */
  autoRunning: boolean;
  /** Remaining usernames to try in the current auto-run cycle, in order. */
  autoRunQueue: string[];
  /** The username whose challenge POST was most recently fired and whose
   * response we're awaiting. `null` between iterations or when not
   * auto-running. Acts as a re-entry guard: `autoRunStep` returns early
   * when this is non-null. */
  autoRunCurrentUsername: string | null;
  /** Idempotent on `autoRunning === true`. Requires `status === "listening"`;
   * silently no-ops otherwise (the UI gates the button on canChallenge). */
  startAutoRun: () => void;
  /** Idempotent. Cancels any pending retry timeout. Does *not* resign a
   * currently-active game -- stopping auto-run just means "don't queue
   * more", so the current game plays to its natural end. */
  stopAutoRun: () => void;
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
  useLichessBotStore.setState({
    status: "error",
    errorMessage: message,
    activeGameId: null,
    pendingStartFen: null,
    pendingRules: "chess",
  });
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
    // Cache the accepted challenge's initialFen so handleGameStart can
    // seed gameStore.startFen *before* the engine's first move fires --
    // see pendingStartFen's doc comment. The bot plays one game at a
    // time (concurrent challenges are declined by decideChallenge), so
    // last-write-wins is unambiguous. Standard-startpos challenges
    // leave this null, which is also the default.
    useLichessBotStore.setState({
      pendingStartFen: challenge.initialFen,
      pendingRules: rulesFromLichessVariant(challenge.variant),
    });
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
  const state = useLichessBotStore.getState();
  // Lichess's `/api/stream/event` catches you up on current state on every
  // reconnect: if a game is already in progress, you get a *fresh*
  // `gameStart` for it. Without this guard a reconnect would run the full
  // handleGameStart path again, which calls `startNewGame({...})` and
  // resets `plies` to []. The engine would then recompute from startpos
  // and send `e2e4` to a server whose real state has moved on, producing
  // "Piece on e2 cannot move to e4" 400s and tight-looping (debug.log
  // showed this behavior on 2026-09-30). Human mode is already immune via
  // `connectImpl`'s NOT_CONNECTED gate; this is the bot-side mirror.
  if (state.activeGameId === gameId && state.status === "playing") {
    logDebug(`duplicate gameStart for active game ${gameId}; ignoring`);
    return;
  }
  const { enginePath, movetimeMs } = state;
  if (!enginePath) {
    failBot("a game started, but no engine binary is selected");
    return;
  }
  const engine = engineStoreForSide(botColor);

  // The "Preview engine options" affordance in LichessBotControls spawns
  // the engine on the White store so the operator can tweak options
  // before accepting a challenge. In bot mode the engine binary is the
  // same regardless of color, so a preview edit should apply even when
  // Lichess assigns Black -- copy White's overrides over to Black's
  // store before Black's engine spawns. Also stops a running preview on
  // the opposite side so an idle leftover process doesn't leak.
  if (botColor === "b") {
    const whiteState = engineStoreForSide("w").getState();
    engine.setState((state) => ({
      optionOverrides: { ...state.optionOverrides, ...whiteState.optionOverrides },
    }));
    if (!ENGINE_NOT_RUNNING.has(whiteState.status)) {
      logDebug("stopping leftover preview engine on white before starting black");
      await engineStoreForSide("w").getState().stopEngine();
    }
  }

  logDebug(`game starting: ${gameId}, engine plays ${botColor}`);
  // A game is starting -- if auto-run was waiting on a challenge
  // response, cancel the timeout and clear the pending username.
  // Status will transition to "playing" during this function, so
  // `autoRunStep` naturally stays paused until terminal cleanup.
  clearAutoRunTimeout();
  useLichessBotStore.setState({
    activeGameId: gameId,
    lastSentUci: null,
    errorMessage: null,
    serverClocks: null,
    players: null,
    opponentGone: null,
    autoRunCurrentUsername: null,
    // Reset the clock-baseline capture; the first `gameFull` for this
    // game will repopulate them. Clearing here guards against a stale
    // previous-game TimeControl leaking into this one's PGN recording
    // if gameFull somehow doesn't deliver `clock` (unlimited game etc.).
    clockInitialMs: null,
    clockIncrementBaseMs: null,
  });

  // Same ordering as EngineControls/LichessControls: reset the board
  // *before* the engine or the game stream is confirmed, so nothing stale
  // from a previous game can land on the fresh one. `pendingStartFen`
  // and `pendingRules` are captured in handleChallenge; passing them
  // here means a Chess960 or From Position challenge's custom state is
  // live before the engine fires its first `maybeRequestEngineMove`.
  const pending = useLichessBotStore.getState().pendingStartFen;
  const pendingRules = useLichessBotStore.getState().pendingRules;
  useGameStore.getState().startNewGame(
    {
      w: botColor === "w" ? "engine" : "lichess",
      b: botColor === "w" ? "lichess" : "engine",
    },
    undefined,
    pending,
    pendingRules,
  );
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

/** Same role as the human-store counterpart: capture gameFull's player
 * display names/titles so `LiveGameClocks` can show the opponent's
 * handle next to their clock. Mid-game `gameState` lines carry no
 * player block, so a null name is normal and must not clobber what
 * was previously captured. */
function applyBotPlayers(update: LichessMoveUpdate) {
  if (update.whiteName === null && update.blackName === null) return;
  useLichessBotStore.setState({
    players: {
      white: update.whiteName ? { name: update.whiteName, title: update.whiteTitle } : null,
      black: update.blackName ? { name: update.blackName, title: update.blackTitle } : null,
    },
  });
}

/** Maps a Lichess variant key to the PGN `Variant` tag spelling that
 * python-chess / lc0 / Stockfish's training pipeline recognize. The
 * default `"Standard"` is returned for `null` and `"standard"` so the
 * tag is always populated for a successful recording. */
function variantToPgnName(key: string | null): string {
  switch (key) {
    case "chess960":
      return "Chess960";
    case "kingOfTheHill":
      return "King of the Hill";
    case "threeCheck":
      return "Three-check";
    case "antichess":
      return "Antichess";
    case "atomic":
      return "Atomic";
    case "horde":
      return "Horde";
    case "racingKings":
      return "Racing Kings";
    case "crazyhouse":
      return "Crazyhouse";
    default:
      return "Standard";
  }
}

/** Lichess's `winner` + terminal `status` → PGN Result tag. */
function resultTag(winner: "white" | "black" | null, status: string): string {
  if (winner === "white") return "1-0";
  if (winner === "black") return "0-1";
  if (status === "draw" || status === "stalemate") return "1/2-1/2";
  return "*";
}

/** Sanitizes a Lichess username for use in a filename. Lichess
 * usernames are already `[a-zA-Z0-9_-]{3,20}` so this is a no-op for
 * valid names; strips anything else defensively so a weird edge case
 * can't produce a path separator or similar. */
function sanitizeForFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Builds a PGN from current store state + the terminal update and
 * fire-and-forgets a write to `<app_data_dir>/recordings/<name>.pgn`.
 * Called from the terminal-status branch of `applyIncomingBotMoves`
 * before the state teardown so `activeGameId`, players, and clock
 * baselines are still populated. Errors are logged but don't disrupt
 * the auto-run handoff -- recording is a nice-to-have, not a hard
 * dependency of the game loop. */
function recordFinishedGameToDisk(update: LichessMoveUpdate) {
  const bot = useLichessBotStore.getState();
  const game = useGameStore.getState();
  const gameId = bot.activeGameId;
  if (!gameId) return;
  const whiteName = bot.players?.white?.name ?? update.whiteName ?? "unknown";
  const blackName = bot.players?.black?.name ?? update.blackName ?? "unknown";
  const whiteTitle = bot.players?.white?.title ?? update.whiteTitle ?? undefined;
  const blackTitle = bot.players?.black?.title ?? update.blackTitle ?? undefined;
  const result = resultTag(update.winner, update.status);
  // UTC date in PGN's standard "YYYY.MM.DD" shape (period-separated).
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const pgnDate = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`;
  // ISO date for the filename (hyphens, universally sort-friendly).
  const fileDate = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const timeControl =
    bot.clockInitialMs !== null && bot.clockIncrementBaseMs !== null
      ? `${Math.round(bot.clockInitialMs / 1000)}+${Math.round(bot.clockIncrementBaseMs / 1000)}`
      : undefined;
  const headers: PgnHeaders = {
    Event: "Lichess bot game",
    Site: `https://lichess.org/${gameId}`,
    Date: pgnDate,
    Round: "-",
    White: whiteName,
    Black: blackName,
    Result: result,
    WhiteTitle: whiteTitle ?? undefined,
    BlackTitle: blackTitle ?? undefined,
    Variant: variantToPgnName(update.variant),
    TimeControl: timeControl,
  };
  const pgn = buildPgn(game.plies, headers, game.startFen ?? undefined);
  const filename = `${fileDate}_${gameId}_${sanitizeForFilename(whiteName)}_vs_${sanitizeForFilename(blackName)}.pgn`;
  appendDebugLog(`[lichess-bot] recording game to ${filename}`);
  invoke("recording_write_pgn", { filename, contents: pgn }).catch((err) => {
    appendDebugLog(`[lichess-bot] recording failed: ${String(err)}`);
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
  applyBotPlayers(update);
  // gameFull's top-level `clock.initial`/`clock.increment` only arrives
  // on the first update of the game -- capture them for the on-disk
  // PGN's TimeControl tag.
  if (update.clockInitialMs !== null && update.clockIncrementBaseMs !== null) {
    useLichessBotStore.setState({
      clockInitialMs: update.clockInitialMs,
      clockIncrementBaseMs: update.clockIncrementBaseMs,
    });
  }
  // "From Position" challenges arrive with a non-null `initialFen` on
  // the gameFull line only -- set it before applying any moves so the
  // engine's `position fen ...` command (buildPositionCommand picks
  // this up from gameStore.startFen) and attemptMove both agree on
  // the custom start. Same reasoning as lichessStore's branch.
  if (update.initialFen !== null) {
    useGameStore.getState().setStartFen(update.initialFen);
  }
  if (update.variant !== null) {
    useGameStore.getState().setRules(rulesFromLichessVariant(update.variant));
  }

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
    // Record the finished game to disk BEFORE the state teardown below
    // wipes activeGameId / clock baselines. Fire-and-forget: a write
    // failure logs via the catch but must not disrupt the auto-run
    // handoff below.
    recordFinishedGameToDisk(update);
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
      pendingStartFen: null,
      pendingRules: "chess",
      serverClocks: null,
      clockInitialMs: null,
      clockIncrementBaseMs: null,
      // Deliberately NOT cleared on terminal status: WinnerBanner reads
      // `players` to show the actual opponent name (e.g. "StockfishBot
      // wins by checkmate") instead of a generic "Lichess wins". The
      // next game's `handleGameStart` nulls `players` before `gameFull`
      // repopulates it, so there's no stale-name leak into a new game;
      // this matches the human-side lichessStore, which also preserves
      // `players` across game-over.
      opponentGone: null,
    });
    useGameStore.getState().exitPlayMode();
    invoke("lichess_stop_game").catch(() => {});
    // Resume auto-run now that we're back to "listening".
    if (useLichessBotStore.getState().autoRunning) {
      void autoRunStep();
    }
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
    case "challengeDeclined": {
      // Two shapes converge here:
      //   1. Lichess echoes back our own decline (we called
      //      `lichess_challenge_decline` on an incoming challenge --
      //      `challengerId` is the opponent, `destUserId` is us).
      //   2. Our outgoing challenge (sent via `lichess_challenge_bot`
      //      from "Browse online bots → Challenge") got rejected by
      //      the target (`challengerId` is us, `destUser*` is them).
      //      Many bots auto-decline bot-vs-bot to stay under Lichess's
      //      bot.vsBot.day rate limit.
      // Compare against our verified id to tell them apart: only
      // outgoing declines are UI-worthy, since incoming declines
      // echoing back our own action aren't new information.
      const myId = useLichessBotStore.getState().verifiedAccount?.id ?? null;
      const isOutgoing = myId !== null && event.challengerId === myId;
      if (isOutgoing) {
        const username = event.destUserName ?? event.destUserId;
        // A `noBot` policy refusal is permanent-ish (bot operator opted
        // out of bot-vs-bot play) -- hide for ~a year rather than a
        // day. Rate-limit declines ("later", "generic" + ratelimit
        // body) and variant/time-control objections stay on the 24 h
        // default because they're transient.
        const ttlMs = isNoBotPolicyDecline(event.reason)
          ? NO_BOT_DECLINE_TTL_MS
          : DEFAULT_DECLINE_TTL_MS;
        useLichessBotStore.setState((state) => ({
          lastOutgoingChallengeDecline: {
            username,
            reason: event.reason,
          },
          declinedBots: username
            ? upsertDeclinedBot(state.declinedBots, username, ttlMs)
            : state.declinedBots,
        }));
        // Advance auto-run if this decline was for the bot we're
        // currently waiting on. The username comparison guards against
        // a late-arriving decline for a prior (already-timed-out) try
        // triggering a double-step.
        const current = useLichessBotStore.getState();
        if (
          current.autoRunning &&
          current.autoRunCurrentUsername !== null &&
          username === current.autoRunCurrentUsername
        ) {
          clearAutoRunTimeout();
          useLichessBotStore.setState({ autoRunCurrentUsername: null });
          scheduleAutoRunRetry(AUTO_RUN_PACING_MS);
        }
      }
      logDebug(
        `challenge ${event.challengeId} declined${event.reason ? ` (${event.reason})` : ""}`,
      );
      break;
    }
    case "gameFinish":
      // Redundant with the terminal status inside the game stream,
      // which also flips status to "listening". Kept as a defense-
      // in-depth log line: if the game stream missed the terminal
      // status for any reason, this confirms the game ended.
      logDebug(`gameFinish event for ${event.gameId}`);
      break;
  }
}

// -------------------------- Auto-run state machine --------------------------
//
// The auto-run facility keeps challenging online bots top-to-bottom of the
// Browse-Online-Bots list until one accepts. On exhaustion (every bot in
// the fetched list is either in the decline-TTL window or has already been
// tried this cycle) it re-fetches and starts over. Transitions out of
// `status === "listening"` (into "playing" / "idle" / "error") naturally
// pause the loop; it resumes from the terminal-status cleanup when the
// game ends.
//
// Design shape, same mode-local-timing idiom as `pump_ndjson_stream`'s
// retry schedule in `lichess.rs`:
//   - `autoRunStep` is the single state-advance entrypoint. It no-ops when
//     `!autoRunning`, when `autoRunCurrentUsername !== null` (we're already
//     mid-challenge), or when `status !== "listening"` (in a game, idle,
//     errored). Every other path triggers it via `scheduleAutoRunRetry`
//     or directly.
//   - A single `autoRunTimeout` handle holds the pending retry so Stop /
//     a response event can cancel cleanly. Not stored on the zustand
//     state because it's a timer id, not UI state.

/** Wait after an auto-run challenge POST succeeds for the target to
 * accept (gameStart) or decline (challengeDeclined). If neither fires
 * within this window, move on to the next bot. 15 s is comfortably
 * above the typical Lichess bot response time (~1-3 s) and below the
 * attention-span threshold where a user would wonder why the UI is
 * stuck. */
const AUTO_RUN_AWAIT_RESPONSE_MS = 15_000;
/** Minimum pause between consecutive auto-run challenges after a POST
 * failure or decline. Lichess's bot challenge endpoint has an
 * unpublished per-minute rate limit; this spaces out requests to stay
 * under it. The 15 s silent-bot wait above is itself enough pacing in
 * that case; this one covers the "immediate error, try next" path. */
const AUTO_RUN_PACING_MS = 1_000;
/** When the queue is empty and a fresh fetch returns no new candidates
 * (every online bot is in the decline-TTL window), wait this long
 * before trying again. Longer than the pacing delay because the only
 * way to break out of this loop is for a bot's decline-TTL to expire,
 * for Lichess to list a new online bot, or for the operator to click
 * Stop -- none of which happen on a one-second scale. */
const AUTO_RUN_IDLE_RETRY_MS = 30_000;

let autoRunTimeout: number | null = null;

function clearAutoRunTimeout() {
  if (autoRunTimeout !== null) {
    window.clearTimeout(autoRunTimeout);
    autoRunTimeout = null;
  }
}

function scheduleAutoRunRetry(ms: number) {
  clearAutoRunTimeout();
  autoRunTimeout = window.setTimeout(() => {
    autoRunTimeout = null;
    // Clear the pending-challenge latch before advancing. This is the
    // silent-bot path: POST landed, no gameStart / challengeDeclined
    // arrived within the window, so we move on. The decline and POST-
    // error paths clear this themselves before scheduling; this clear
    // is a no-op for them but required for the silent-bot path to not
    // get stuck in `autoRunStep`'s `autoRunCurrentUsername !== null`
    // re-entry guard.
    const stuck = useLichessBotStore.getState().autoRunCurrentUsername;
    if (stuck !== null) {
      appendDebugLog(`[lichess-bot] auto-run: no response from ${stuck}, moving on`);
      useLichessBotStore.setState({ autoRunCurrentUsername: null });
    }
    void autoRunStep();
  }, ms);
}

async function refillAutoRunQueue(): Promise<string[]> {
  try {
    const raw = await invoke<string>("lichess_bot_online", { nb: 200 });
    const bots = parseBotOnlineList(raw);
    const state = useLichessBotStore.getState();
    const now = Date.now();
    const declined = new Set(
      state.declinedBots.filter((e) => e.expiresAtMs > now).map((e) => e.username),
    );
    return bots.map((b) => b.username).filter((u) => !declined.has(u));
  } catch (err) {
    appendDebugLog(`[lichess-bot] auto-run refill failed: ${String(err)}`);
    return [];
  }
}

async function autoRunStep() {
  const state = useLichessBotStore.getState();
  if (!state.autoRunning) return;
  // Re-entry guard: a challenge is in flight; the response path will
  // advance us (or the 15 s timeout fallback will).
  if (state.autoRunCurrentUsername !== null) return;
  // In a game / idle / errored: wait for a listening state to resume
  // (the terminal-status cleanup and startListening both re-trigger).
  if (state.status !== "listening") return;

  let queue = state.autoRunQueue;
  if (queue.length === 0) {
    queue = await refillAutoRunQueue();
    if (!useLichessBotStore.getState().autoRunning) return;
    if (queue.length === 0) {
      appendDebugLog("[lichess-bot] auto-run: no candidates after refill, waiting");
      scheduleAutoRunRetry(AUTO_RUN_IDLE_RETRY_MS);
      return;
    }
  }

  const [username, ...rest] = queue;
  useLichessBotStore.setState({
    autoRunQueue: rest,
    autoRunCurrentUsername: username,
  });

  try {
    const { challengeColor, sendRated, clockLimitMinutes, clockIncrementSeconds } =
      useLichessBotStore.getState();
    appendDebugLog(`[lichess-bot] auto-run challenging ${username}`);
    await invoke("lichess_challenge_bot", {
      username,
      clockLimitSeconds: clockLimitMinutes * 60,
      clockIncrementSeconds,
      color: challengeColor,
      rated: sendRated,
    });
    // POST landed; wait for the target to accept, decline, or stay silent.
    scheduleAutoRunRetry(AUTO_RUN_AWAIT_RESPONSE_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendDebugLog(`[lichess-bot] auto-run POST failed for ${username}: ${message}`);
    const rateLimitSeconds = parseRateLimitSeconds(message) ?? undefined;
    useLichessBotStore.getState().recordBotChallengeFailure(username, rateLimitSeconds);
    useLichessBotStore.setState({ autoRunCurrentUsername: null });
    if (!useLichessBotStore.getState().autoRunning) return;
    scheduleAutoRunRetry(AUTO_RUN_PACING_MS);
  }
}

/** Fire-and-forget append to the on-disk debug log, mirroring the
 * engineStore closure helper but at module scope so the auto-run
 * state machine can log without a side-tagged prefix. */
function appendDebugLog(message: string) {
  invoke("debug_log_append", { message }).catch(() => {});
}

// ----------------------------------------------------------------------------

let listenersInstalled = false;

/** The bot-mode game stream (`lichess-bot-game-stream` /
 * `lichess-bot-game-exit`) is unique to this store, so its raw listeners
 * still live here. The *account* event stream is shared with
 * `lichessStore` via `lichessEventBus` -- both routes converge on
 * `handleAccountEvent` below.
 *
 * On HMR module replace, the `import.meta.hot?.dispose` callback
 * unlistens the Tauri subscriptions and the gameStore watcher, and
 * resets the latch so the fresh module instance can install cleanly --
 * without this, every edit to this module (or its import graph)
 * stacks another live listener on the same Rust events, causing
 * duplicate `handleGameStart` / `applyIncomingBotMoves` dispatches
 * and (via the gameStore subscriber) duplicate `maybeSendEngineMove`
 * calls that POST the engine's own move to Lichess twice. */
function installBotGameStreamListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  const streamUnlisten = listen<string>("lichess-bot-game-stream", (event) => {
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

  const exitUnlisten = listen<string>("lichess-bot-game-exit", (event) => {
    if (useLichessBotStore.getState().status === "playing") {
      failBot(event.payload);
    }
  });

  const unsubscribeGameStore = useGameStore.subscribe((state, prevState) => {
    if (state.plies.length !== prevState.plies.length) {
      maybeSendEngineMove();
    }
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      try {
        (await streamUnlisten)();
      } catch {
        // swallow: dispose must not throw; a failed unlisten leaks at
        // worst one listener (same outcome as before this fix).
      }
      try {
        (await exitUnlisten)();
      } catch {
        /* same */
      }
      unsubscribeGameStore();
      listenersInstalled = false;
    });
  }
}

const NOT_LISTENING = new Set<LichessBotStatus>(["idle", "error"]);

export const useLichessBotStore = create<LichessBotStoreState>()(
  persist(
    (set, get) => ({
      hasToken: false,
      verifiedAccount: null,
      verifyError: null,
      acceptRated: false,
      challengeColor: "white",
      sendRated: true,
      clockLimitMinutes: 5,
      clockIncrementSeconds: 3,
      lagMarginMs: 100,
      serverClocks: null,
      players: null,
      opponentGone: null,
      enginePath: null,
      movetimeMs: 1000,
      status: "idle",
      errorMessage: null,
      activeGameId: null,
      pendingStartFen: null,
      pendingRules: "chess",
      clockInitialMs: null,
      clockIncrementBaseMs: null,
      lastSentUci: null,
      lastOutgoingChallengeDecline: null,
      declinedBots: [],
      autoRunning: false,
      autoRunQueue: [],
      autoRunCurrentUsername: null,

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
        // Also clears `errorMessage` -- a stale "no bot token is set" or
        // other upgrade/listen failure from the previous session would
        // otherwise linger even after the user has acted on it by
        // clearing the token. Same rationale as engineStore.stopEngine's
        // own errorMessage clear.
        set({
          hasToken: false,
          verifiedAccount: null,
          verifyError: null,
          errorMessage: null,
        });
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
          // See lichessStore.oauthLogin -- distinguish user-driven
          // cancel from a real failure.
          const message = String(err);
          if (message.includes("canceled")) {
            set({ verifyError: null });
            logDebug("oauth login canceled by user");
          } else {
            set({ verifyError: message });
            logDebug(`oauth login failed: ${message}`);
          }
        }
      },

      cancelOauthLogin: async () => {
        logDebug("oauth cancel requested");
        try {
          await invoke("lichess_oauth_cancel");
        } catch (err) {
          logDebug(`oauth cancel failed: ${String(err)}`);
        }
      },

      setEnginePath: (enginePath) => set({ enginePath }),
      setMovetimeMs: (movetimeMs) => set({ movetimeMs }),
      setAcceptRated: (acceptRated) => set({ acceptRated }),
      setChallengeColor: (challengeColor) => set({ challengeColor }),
      setSendRated: (sendRated) => set({ sendRated }),
      setClockLimitMinutes: (clockLimitMinutes) => set({ clockLimitMinutes }),
      setClockIncrementSeconds: (clockIncrementSeconds) => set({ clockIncrementSeconds }),
      setLagMarginMs: (lagMarginMs) => set({ lagMarginMs }),

      clearOutgoingChallengeDecline: () => set({ lastOutgoingChallengeDecline: null }),

      recordBotChallengeFailure: (username, rateLimitSeconds) => {
        const ttlMs =
          rateLimitSeconds !== undefined && rateLimitSeconds > 0
            ? rateLimitSeconds * 1000
            : DEFAULT_DECLINE_TTL_MS;
        set((state) => ({
          declinedBots: upsertDeclinedBot(state.declinedBots, username, ttlMs),
        }));
      },

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
        set({
          status: "listening",
          errorMessage: null,
          activeGameId: null,
          pendingStartFen: null,
          pendingRules: "chess",
          lastSentUci: null,
        });
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
        // Stopping the listening session must also halt auto-run -- the
        // whole bot slot is going offline. Timeout + queue reset.
        clearAutoRunTimeout();
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
            pendingStartFen: null,
            pendingRules: "chess",
            clockInitialMs: null,
            clockIncrementBaseMs: null,
            serverClocks: null,
            players: null,
            opponentGone: null,
            autoRunning: false,
            autoRunQueue: [],
            autoRunCurrentUsername: null,
          });
          useGameStore.getState().exitPlayMode();
        }
      },

      startAutoRun: () => {
        const state = useLichessBotStore.getState();
        if (state.autoRunning) return;
        if (state.status !== "listening") return;
        logDebug("auto-run starting");
        set({
          autoRunning: true,
          autoRunQueue: [],
          autoRunCurrentUsername: null,
        });
        void autoRunStep();
      },

      stopAutoRun: () => {
        if (!useLichessBotStore.getState().autoRunning) return;
        logDebug("auto-run stopped");
        clearAutoRunTimeout();
        set({
          autoRunning: false,
          autoRunQueue: [],
          autoRunCurrentUsername: null,
        });
      },
    }),
    {
      name: "chess-board-lichess-bot-engine",
      partialize: (state) => ({
        enginePath: state.enginePath,
        movetimeMs: state.movetimeMs,
        acceptRated: state.acceptRated,
        challengeColor: state.challengeColor,
        sendRated: state.sendRated,
        clockLimitMinutes: state.clockLimitMinutes,
        clockIncrementSeconds: state.clockIncrementSeconds,
        lagMarginMs: state.lagMarginMs,
        // Persist declined bots so a dev-server restart or an
        // overnight close doesn't surface known-rate-limited
        // opponents again. The per-entry TTL (24 h default, exact
        // when Lichess tells us) handles the staleness side.
        declinedBots: state.declinedBots,
      }),
      // On rehydrate, drop any entries whose TTL has already elapsed
      // so the array doesn't accumulate stale usernames across weeks
      // of app use. Harmless when `declinedBots` is empty (fresh
      // installs or users who never challenged a bot).
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const now = Date.now();
        state.declinedBots = state.declinedBots.filter((e) => e.expiresAtMs > now);
      },
    },
  ),
);
