import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Ply } from "../lib/chessRules";
import {
  isTerminalStatus,
  parseLichessLine,
  parseLichessOpponentGone,
  type LichessAccountEvent,
  type LichessAccountInfo,
  type LichessMoveUpdate,
  type LichessOpponentGone,
} from "../lib/lichess";
import { installLichessEventBusOnce } from "../lib/lichessEventBus";
import { useGameStore } from "./gameStore";

/** Every Lichess Tauri command that authenticates carries a `slot: TokenSlot`
 * discriminator (`"human"|"bot"`) so Rust picks the right keychain entry.
 * This module always uses `human` -- see `TokenSlot`'s doc comment in
 * `src-tauri/src/lichess.rs` for why the slot is a first-class enum. */
const HUMAN_SLOT = "human" as const;

/** Server-reported clock snapshot for the live-clock display. Populated
 * by every `gameState` update; `LiveGameClocks` interpolates locally
 * between updates using `updatedAtMs`. Shared shape with lichessBotStore. */
export interface LiveClocks {
  wtimeMs: number;
  btimeMs: number;
  wincMs: number;
  bincMs: number;
  /** `Date.now()` at the moment the server-side clocks were received. */
  updatedAtMs: number;
}

/** Display identity for one player in the live game. `title` is e.g.
 * `"BOT"` / `"GM"` or `null` when the account has none. Shared shape
 * with lichessBotStore so `LiveGameClocks` can read whichever store is
 * active without caring which mode drove the game. */
export interface LivePlayer {
  name: string;
  title: string | null;
}

export interface LivePlayers {
  white: LivePlayer | null;
  black: LivePlayer | null;
}

export type LichessStatus = "idle" | "connecting" | "connected" | "error" | "gameOver";

/** Long-poll status of `POST /api/board/seek`. `"seeking"` while the
 * seek request is in flight (Lichess holds it open until a match);
 * `"idle"` otherwise. Independent of the game-stream `status` above
 * because a match happens in a specific order (seek closes -> gameStart
 * on event stream -> game stream opens) and the two lifecycles overlap. */
export type SeekStatus = "idle" | "seeking";

/** Which color the caller wants to play in a seek/challenge. Mirrors
 * the Rust `ChallengeColor` enum; wire tags must match exactly. */
export type LichessColor = "random" | "white" | "black";

/** Time-control shape used by every human-mode initiator (seek, challenge
 * user, challenge AI). Kept as a shared type rather than duplicated per
 * action so a UI change (e.g. adding a preset picker) only edits one
 * shape. */
export interface LichessTimeControl {
  /** Base time in minutes, 0-180 (Lichess Board API limit). */
  minutes: number;
  /** Increment in seconds, 0-60. */
  increment: number;
}

/**
 * Which of the plies just appended (if any) is `side`'s own move that
 * still needs to be sent to Lichess. `null` when the last move was received
 * from the opponent (its color won't match `side`, since chess strictly
 * alternates) or has already been sent. Generic over `side` so both
 * lichessStore (the human's side) and lichessBotStore (the local engine's
 * side) can reuse it.
 */
export function pendingMoveToSend(
  plies: Ply[],
  side: "w" | "b",
  lastSentUci: string | null,
): string | null {
  const lastPly = plies[plies.length - 1];
  if (!lastPly || lastPly.color !== side) return null;
  if (lastPly.uci === lastSentUci) return null;
  return lastPly.uci;
}

/**
 * The subset of Lichess's full moves-so-far list not yet applied locally.
 * Diffing against the live ply count (not a separately tracked counter
 * incremented only when *receiving* a move) is what stays correct across
 * Lichess echoing back a move this app already applied locally after
 * sending it -- a stale separate counter would replay that echo through
 * `attemptMove` a second time and duplicate the ply.
 */
export function movesToApply(moves: string[], localPlyCount: number): string[] {
  return moves.slice(localPlyCount);
}

interface LichessStoreState {
  hasToken: boolean;
  /** Whatever the human slot's `GET /api/account` returned on the most
   * recent verify call. `null` while pending, unset, or after a token
   * clear -- the UI reads this to show the verified username and to gate
   * Connect on the account actually being non-BOT (fair-play). */
  verifiedAccount: LichessAccountInfo | null;
  /** Error from the most recent verify call, e.g. "this is a BOT
   * account -- put it in the bot slot". Kept separate from
   * `errorMessage` so a stale verify error doesn't wipe a live
   * connection failure and vice versa. */
  verifyError: string | null;
  gameId: string | null;
  status: LichessStatus;
  seekStatus: SeekStatus;
  errorMessage: string | null;
  lastSentUci: string | null;
  /** Most recent server clock snapshot for the live game. `null` until
   * the first `gameFull`/`gameState` with clock fields arrives. */
  serverClocks: LiveClocks | null;
  /** Lichess display identities for both sides. Only `gameFull` carries
   * this; `null` until the first `gameFull` arrives, cleared on
   * disconnect. `LiveGameClocks` reads it to show the opponent's name
   * next to their clock -- "Black / omcrosby" instead of a bare "Black". */
  players: LivePlayers | null;
  /** Opponent-gone state from the game stream's `opponentGone` line.
   * `null` when the opponent is present (or before the first such line).
   * `LiveGameActions` reads `claimWinInSeconds` to render the countdown
   * and enable the Claim Victory button. */
  opponentGone: LichessOpponentGone | null;

  refreshHasToken: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
  /** Live-fetch `/api/account` under the human slot and cache the result.
   * Populates `verifiedAccount` on success, `verifyError` on failure. */
  verifyAccount: () => Promise<void>;
  /** OAuth 2.0 + PKCE login for the human slot: opens a Lichess
   * authorize tab in the user's browser, catches the callback on a
   * loopback listener, stores the resulting token in the OS keychain,
   * and populates `verifiedAccount`. Alternative to `setToken` for
   * users who don't want to paste a PAT. */
  oauthLogin: () => Promise<void>;
  /** Abandon an in-flight `oauthLogin`. Useful when the user closed
   * the browser tab or signed in as the wrong account and wants to
   * retry without waiting out the 5-minute Rust-side timeout. */
  cancelOauthLogin: () => Promise<void>;
  /** Board API seek. Opens the account event stream (so `gameStart` can
   * auto-connect the game stream on match) then POSTs the seek. The
   * seek request stays open on the server until matched or aborted. */
  seek: (opts: { time: LichessTimeControl; rated: boolean; color: LichessColor }) => Promise<void>;
  /** Aborts an in-flight seek. Idempotent when no seek is active. */
  stopSeek: () => Promise<void>;
  /** Challenges a specific Lichess user by name. Same auto-connect flow
   * as seek: the account event stream fires `gameStart` when the
   * opponent accepts. */
  challengeUser: (opts: {
    username: string;
    time: LichessTimeControl;
    rated: boolean;
    color: LichessColor;
  }) => Promise<void>;
  /** Challenges the Lichess AI (Stockfish, level 1-8). Always casual. */
  challengeAi: (opts: {
    level: number;
    time: LichessTimeControl;
    color: LichessColor;
  }) => Promise<void>;
  /** Connect to an existing game by id -- kept as a fallback alongside
   * seek/challenge/AI for cases like "opponent already sent me a
   * challenge on lichess.org and I want to play it here". */
  joinGameById: (gameIdOrUrl: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** In-game actions (Board API). Each POSTs against the current
   * `gameId`; a `null` gameId is a no-op (the UI already gates on it,
   * but the store stays defensive). */
  resign: () => Promise<void>;
  abort: () => Promise<void>;
  /** Agree to a draw (Lichess treats /draw/yes as both "offer" and
   * "accept" depending on whether an opponent's offer is pending). */
  agreeToDraw: () => Promise<void>;
  declineDraw: () => Promise<void>;
  /** Claim victory when the opponent has been gone long enough for
   * Lichess's `claimWinInSeconds` countdown to have elapsed. */
  claimVictory: () => Promise<void>;
  /** Called by `lichessEventBus` for every event on the account event
   * stream while `human-vs-lichess` is the active mode. `gameStart`
   * auto-connects the game stream; other events are logged for the
   * debug timeline. */
  handleAccountEvent: (event: LichessAccountEvent) => void;
  handleEventStreamExit: (reason: string) => void;
}

/** Fire-and-forget append to the on-disk debug log, same convention as
 * engineStore.ts -- a logging failure must never cascade into a
 * user-visible error of its own. */
function logDebug(message: string) {
  invoke("debug_log_append", { message: `[lichess] ${message}` }).catch(() => {});
}

/** Every path that ends the game's connection to Lichess goes through
 * here, pairing status + gameStore.exitPlayMode the same way engineStore's
 * failEngine does -- see that module's comment for the bug this avoids. */
function failLichess(message: string) {
  logDebug(`FAILED: ${message}`);
  useLichessStore.setState({ status: "error", errorMessage: message });
  useGameStore.getState().exitPlayMode();
}

/** Snapshots the update's clock fields into the store *before* the
 * moves in the same update are applied. attemptMove fires a synchronous
 * gameStore.subscribe callback in engineStore that may build a `go`
 * line reading `serverClocks`; updating after would cause every
 * such request to see the previous update's stale values. Returns the
 * previous snapshot so the caller can compute think-times against it. */
function commitServerClocksEarly(update: LichessMoveUpdate) {
  const prev = useLichessStore.getState().serverClocks;
  if (update.wtimeMs !== null && update.btimeMs !== null) {
    useLichessStore.setState({
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

/** Populates `thinkTimeSeconds` on the last-appended live ply using the
 * captured pre-update clocks. Only annotates when exactly one new ply
 * was applied and the game has clock fields at all -- multi-move
 * catch-ups on reconnect can't attribute per-move think-times correctly,
 * and correspondence games have no wtime/btime. Both are honest
 * `undefined`s in the move log, not fabrications. */
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

/** Derives which side (`"w" | "b" | null`) the verified human account
 * plays in this game, by comparing the account's id against the
 * `white.id` / `black.id` in a `gameFull` line. `null` when the account
 * isn't verified yet, when the line isn't a `gameFull` (subsequent
 * `gameState` lines don't carry ids), or when neither id matches --
 * the last case is a spectator connection, which this app doesn't
 * currently support in human mode. */
function deriveHumanSide(update: LichessMoveUpdate): "w" | "b" | null {
  const account = useLichessStore.getState().verifiedAccount;
  if (!account) return null;
  if (update.whiteId === account.id) return "w";
  if (update.blackId === account.id) return "b";
  return null;
}

/** Captures the display name/title for each side from a `gameFull` line
 * into the store so `LiveGameClocks` can show "Black / omcrosby (BOT)"
 * instead of a bare "Black". Only `gameFull` carries these -- later
 * `gameState` lines don't, so a missing name is normal mid-game and
 * must not clobber what was previously captured. */
function applyPlayers(update: LichessMoveUpdate) {
  if (update.whiteName === null && update.blackName === null) return;
  useLichessStore.setState({
    players: {
      white: update.whiteName ? { name: update.whiteName, title: update.whiteTitle } : null,
      black: update.blackName ? { name: update.blackName, title: update.blackTitle } : null,
    },
  });
}

/** Called once per game as soon as the first `gameFull` arrives with
 * enough info to pick sides. Promotes the initial "both lichess"
 * placeholder to a real `{ human, lichess }` pair and updates POV to
 * match. Idempotent -- re-running on a stale `gameFull` reproduces the
 * same controllers set. */
function applyDerivedControllers(update: LichessMoveUpdate) {
  if (update.whiteId === null && update.blackId === null) return;
  const humanSide = deriveHumanSide(update);
  if (humanSide === null) {
    // Spectator: leave placeholder as-is; moves stay locked because
    // neither side is human-controlled. Log so a user staring at a
    // "why can't I move" UI can find the reason in debug.log.
    logDebug(
      `neither white (${update.whiteId ?? "?"}) nor black (${update.blackId ?? "?"}) matches this account`,
    );
    return;
  }
  useGameStore.getState().setControllers(
    {
      w: humanSide === "w" ? "human" : "lichess",
      b: humanSide === "b" ? "human" : "lichess",
    },
    humanSide,
  );
}

function applyIncomingMoves(update: ReturnType<typeof parseLichessLine>) {
  if (!update) return;
  // Update serverClocks *before* the move loop -- see the identical
  // note in lichessBotStore.ts. Human mode doesn't have a local engine
  // reading these clocks today, but the ordering is still correct: any
  // future subscriber (a live-clock component that re-renders on each
  // update) would otherwise briefly see the previous update's values.
  const prevClocks = commitServerClocksEarly(update);

  // Derive the human side from `gameFull`'s player ids before applying
  // any moves in the same update, so if a mid-game gameFull carries
  // existing moves, they land under the right controllers/POV.
  applyDerivedControllers(update);
  applyPlayers(update);
  // "From Position" games arrive with a non-null `initialFen` on the
  // gameFull line only -- set it before applying any moves so the
  // first move validates against the custom start, not standard
  // startpos. On gameState lines the parser returns `null` here, so
  // calling setStartFen is a safe no-op on anything after gameFull.
  if (update.initialFen !== null) {
    useGameStore.getState().setStartFen(update.initialFen);
  }
  // Variant arrives only on gameFull. Chess960 is the only accepted
  // non-standard today (see decideChallenge); other variants would
  // never reach this branch. Set rules before applying moves so a
  // multi-move catch-up (reconnect to a game in progress) validates
  // under the right rule set.
  if (update.variant !== null) {
    useGameStore.getState().setRules(update.variant === "chess960" ? "chess960" : "chess");
  }

  const newMoves = movesToApply(update.moves, useGameStore.getState().plies.length);
  for (const uci of newMoves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    const applied = useGameStore.getState().attemptMove(from, to, promotion);
    if (!applied) {
      failLichess(`lichess sent an illegal move: ${uci}`);
      return;
    }
  }

  annotateLastPlyThinkTime(prevClocks, update, newMoves.length);

  if (isTerminalStatus(update.status)) {
    logDebug(`game over: ${update.status}`);
    useLichessStore.setState({ status: "gameOver" });
    useGameStore.getState().exitPlayMode();
    invoke("lichess_stop_game").catch(() => {});
  }
}

/** Sends the human's own just-made move to Lichess -- the push counterpart
 * to engineStore's maybeRequestEngineMove (which pulls a move from the
 * engine). Called after every ply append; naturally skips the move it just
 * received from Lichess, since that ply's color is the opponent's. */
function maybeSendHumanMove() {
  const lichess = useLichessStore.getState();
  const game = useGameStore.getState();
  if (lichess.status !== "connected") return;
  if (game.mode !== "play" || game.ply !== game.plies.length) return;

  const humanSide = game.controllers.w === "human" ? "w" : "b";
  const uci = pendingMoveToSend(game.plies, humanSide, lichess.lastSentUci);
  if (!uci) return;

  useLichessStore.setState({ lastSentUci: uci });
  logDebug(`sending move: ${uci}`);
  invoke("lichess_make_move", { gameIdOrUrl: lichess.gameId, uciMove: uci }).catch((err) =>
    failLichess(String(err)),
  );
}

let listenersInstalled = false;

/** Human-mode's per-game stream listeners (`lichess-game-stream` /
 * `lichess-game-exit`). The *account* event stream is shared with
 * `lichessBotStore` via `lichessEventBus` -- installed separately in
 * `primeForNewSession`. */
function installLichessGameListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void listen<string>("lichess-game-stream", (event) => {
    // Every incoming line is checked against both parsers -- Lichess
    // multiplexes gameFull/gameState/opponentGone (and chatLine, which
    // both parsers correctly return `null` for) onto the same stream.
    // Running both is cheaper than dispatching on `type` in a third seam.
    const move = parseLichessLine(event.payload);
    if (move) applyIncomingMoves(move);
    const gone = parseLichessOpponentGone(event.payload);
    if (gone) {
      useLichessStore.setState({ opponentGone: gone });
      logDebug(
        `opponent ${gone.gone ? "gone" : "back"}${
          gone.claimWinInSeconds !== null ? ` (claim in ${gone.claimWinInSeconds}s)` : ""
        }`,
      );
    }
  });

  void listen<string>("lichess-game-exit", (event) => {
    if (useLichessStore.getState().status === "connected") {
      failLichess(event.payload);
    }
  });

  useGameStore.subscribe((state, prevState) => {
    if (state.plies.length !== prevState.plies.length) {
      maybeSendHumanMove();
    }
  });
}

const NOT_CONNECTED = new Set<LichessStatus>(["idle", "error", "gameOver"]);

/** Fair-play precheck, defense-in-depth over the Rust guard. Any
 * initiator (`seek`, `challengeUser`, `challengeAi`, `joinGameById`)
 * runs this first so a BOT-account token produces the same clear error
 * without a wasted HTTP round-trip. */
function refuseIfBotAccount(): boolean {
  const verified = useLichessStore.getState().verifiedAccount;
  if (verified?.isBot) {
    failLichess(
      `the human slot's token belongs to a BOT account ("${verified.username}") -- put it in the bot slot instead`,
    );
    return true;
  }
  return false;
}

/** Places the store in the just-before-any-Lichess-call state that
 * every initiator (seek, challenge, join-by-id) needs. Resets the board
 * with a placeholder `{ w: "lichess", b: "lichess" }` -- moves stay
 * locked (per CLAUDE.md's ordering rule) until `gameFull` derives the
 * human's real side and `enterPlayMode` runs. */
function primeForNewSession(): void {
  installLichessGameListenersOnce();
  installLichessEventBusOnce();
  useGameStore.getState().startNewGame({ w: "lichess", b: "lichess" });
  useLichessStore.setState({
    status: "idle",
    errorMessage: null,
    lastSentUci: null,
    gameId: null,
    serverClocks: null,
    players: null,
    opponentGone: null,
  });
}

/** Shared connect-to-a-game-id flow, called by both `joinGameById`
 * (user paste) and `handleAccountEvent` (auto-connect on `gameStart`).
 * The caller is responsible for `primeForNewSession` beforehand. */
async function connectImpl(gameIdOrUrl: string): Promise<void> {
  if (!NOT_CONNECTED.has(useLichessStore.getState().status)) return;
  useLichessStore.setState({
    status: "connecting",
    errorMessage: null,
    lastSentUci: null,
    gameId: gameIdOrUrl,
    serverClocks: null,
    players: null,
  });
  logDebug(`connecting: ${gameIdOrUrl}`);
  try {
    await invoke("lichess_stream_game", { gameIdOrUrl });
    useLichessStore.setState({ status: "connected" });
    logDebug("connected");
    // Only unlock moves once the stream is actually confirmed connected --
    // gameStore.startNewGame (called before this) resets the board but
    // deliberately leaves moves locked until now, same as engineStore.
    useGameStore.getState().enterPlayMode();
  } catch (err) {
    failLichess(String(err));
  }
}

async function startAccountEventStreamOnce(): Promise<void> {
  installLichessEventBusOnce();
  // Idempotent server-side: hitting `/api/stream/event` while one is
  // already open just returns a fresh stream. Log the error but don't
  // fail the initiator -- the seek/challenge itself is what the user
  // actually cares about; if the event stream doesn't come up, they
  // can still connect manually by pasting the game id.
  try {
    await invoke("lichess_stream_events", { slot: HUMAN_SLOT });
  } catch (err) {
    logDebug(`event stream start failed: ${String(err)}`);
  }
}

export const useLichessStore = create<LichessStoreState>((set) => ({
  hasToken: false,
  verifiedAccount: null,
  verifyError: null,
  gameId: null,
  status: "idle",
  seekStatus: "idle",
  errorMessage: null,
  lastSentUci: null,
  serverClocks: null,
  players: null,
  opponentGone: null,

  refreshHasToken: async () => {
    const hasToken = await invoke<boolean>("lichess_token_has", { slot: HUMAN_SLOT }).catch(
      () => false,
    );
    set({ hasToken });
  },

  setToken: async (token) => {
    await invoke("lichess_token_set", { slot: HUMAN_SLOT, token });
    // A new token means any previously verified account for this slot
    // is stale -- Rust already invalidated its own cache; mirror that
    // on the frontend so the UI doesn't briefly show the old username
    // before the next verify call lands.
    set({ hasToken: true, verifiedAccount: null, verifyError: null });
  },

  clearToken: async () => {
    await invoke("lichess_token_clear", { slot: HUMAN_SLOT });
    // Also clears `errorMessage` -- a stale connect/seek failure from
    // the previous session would otherwise linger even after the user
    // has acted on it by clearing the token.
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
        slot: HUMAN_SLOT,
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
        slot: HUMAN_SLOT,
      });
      set({
        hasToken: true,
        verifiedAccount: info,
        verifyError: null,
      });
      logDebug(`oauth login succeeded as ${info.username}`);
    } catch (err) {
      // Distinguish the user-driven cancel from a real failure -- the
      // UI shouldn't show "OAuth sign-in canceled" as a red error line
      // when the user themselves clicked Cancel.
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
      // Cancel is best-effort; a failing cancel is still useful info
      // to log, but shouldn't become its own user-visible error.
      logDebug(`oauth cancel failed: ${String(err)}`);
    }
  },

  seek: async ({ time, rated, color }) => {
    if (refuseIfBotAccount()) return;
    primeForNewSession();
    await startAccountEventStreamOnce();
    set({ seekStatus: "seeking" });
    logDebug(`seek: ${time.minutes}+${time.increment} rated=${rated} color=${color}`);
    try {
      await invoke("lichess_seek", {
        minutes: time.minutes,
        increment: time.increment,
        rated,
        color,
      });
      // Seek returns when the server closes the connection -- either
      // matched (gameStart fires on the event stream, handleAccountEvent
      // auto-connects) or aborted via stopSeek. Either way, we're no
      // longer actively seeking here.
      set({ seekStatus: "idle" });
    } catch (err) {
      set({ seekStatus: "idle" });
      failLichess(String(err));
    }
  },

  stopSeek: async () => {
    logDebug("stop seek requested");
    try {
      await invoke("lichess_stop_seek");
    } finally {
      set({ seekStatus: "idle" });
    }
  },

  challengeUser: async ({ username, time, rated, color }) => {
    if (refuseIfBotAccount()) return;
    primeForNewSession();
    await startAccountEventStreamOnce();
    logDebug(`challenge user: ${username} ${time.minutes}+${time.increment} rated=${rated}`);
    try {
      await invoke("lichess_challenge_user", {
        username,
        minutes: time.minutes,
        increment: time.increment,
        rated,
        color,
      });
    } catch (err) {
      failLichess(String(err));
    }
  },

  challengeAi: async ({ level, time, color }) => {
    if (refuseIfBotAccount()) return;
    primeForNewSession();
    await startAccountEventStreamOnce();
    logDebug(`challenge AI level ${level}: ${time.minutes}+${time.increment} color=${color}`);
    try {
      await invoke("lichess_challenge_ai", {
        level,
        minutes: time.minutes,
        increment: time.increment,
        color,
      });
    } catch (err) {
      failLichess(String(err));
    }
  },

  joinGameById: async (gameIdOrUrl) => {
    if (refuseIfBotAccount()) return;
    primeForNewSession();
    await startAccountEventStreamOnce();
    await connectImpl(gameIdOrUrl);
  },

  handleAccountEvent: (event) => {
    switch (event.type) {
      case "gameStart":
        logDebug(`gameStart: ${event.gameId} (bot side: ${event.botColor})`);
        // Auto-connect. `primeForNewSession` was already called by the
        // initiator (seek/challenge/etc); the game stream just needs to
        // open. Even if the user hits `joinGameById` mid-seek and then
        // Lichess later fires a gameStart for a different id, the guard
        // inside `connectImpl` no-ops (status is "connected" already).
        void connectImpl(event.gameId);
        // Seek matched (or challenge accepted) -> no longer seeking.
        useLichessStore.setState({ seekStatus: "idle" });
        break;
      case "challenge":
        // Outbound challenge that Lichess is confirming to us, or an
        // inbound challenge from another user. Human mode doesn't
        // auto-accept -- surfaced in debug.log only for now.
        logDebug(`challenge event: ${event.challengeId} from ${event.challenger?.id ?? "?"}`);
        break;
      case "challengeCanceled":
        logDebug(`challenge canceled: ${event.challengeId}`);
        break;
      case "challengeDeclined":
        logDebug(
          `challenge declined: ${event.challengeId}${event.reason ? ` (${event.reason})` : ""}`,
        );
        break;
      case "gameFinish":
        logDebug(`gameFinish: ${event.gameId}`);
        break;
    }
  },

  handleEventStreamExit: (reason) => {
    if (useLichessStore.getState().status === "connected") {
      failLichess(reason);
    } else {
      logDebug(`event stream ended: ${reason}`);
    }
  },

  resign: async () => {
    const gameId = useLichessStore.getState().gameId;
    if (!gameId) return;
    logDebug("resign requested");
    try {
      await invoke("lichess_resign", { gameIdOrUrl: gameId });
    } catch (err) {
      failLichess(String(err));
    }
  },

  abort: async () => {
    const gameId = useLichessStore.getState().gameId;
    if (!gameId) return;
    logDebug("abort requested");
    try {
      await invoke("lichess_abort", { gameIdOrUrl: gameId });
    } catch (err) {
      failLichess(String(err));
    }
  },

  agreeToDraw: async () => {
    const gameId = useLichessStore.getState().gameId;
    if (!gameId) return;
    logDebug("draw/yes requested");
    try {
      await invoke("lichess_draw", { gameIdOrUrl: gameId, accept: true });
    } catch (err) {
      failLichess(String(err));
    }
  },

  declineDraw: async () => {
    const gameId = useLichessStore.getState().gameId;
    if (!gameId) return;
    logDebug("draw/no requested");
    try {
      await invoke("lichess_draw", { gameIdOrUrl: gameId, accept: false });
    } catch (err) {
      failLichess(String(err));
    }
  },

  claimVictory: async () => {
    const gameId = useLichessStore.getState().gameId;
    if (!gameId) return;
    logDebug("claim-victory requested");
    try {
      await invoke("lichess_claim_victory", { gameIdOrUrl: gameId });
    } catch (err) {
      failLichess(String(err));
    }
  },

  disconnect: async () => {
    logDebug("disconnect requested");
    try {
      await invoke("lichess_stop_game");
      await invoke("lichess_stop_events").catch(() => {});
      await invoke("lichess_stop_seek").catch(() => {});
    } finally {
      set({
        status: "idle",
        seekStatus: "idle",
        errorMessage: null,
        gameId: null,
        serverClocks: null,
        players: null,
        opponentGone: null,
      });
      useGameStore.getState().exitPlayMode();
    }
  },
}));
