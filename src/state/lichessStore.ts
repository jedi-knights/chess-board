import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Ply } from "../lib/chessRules";
import {
  isTerminalStatus,
  parseLichessLine,
  type LichessAccountInfo,
} from "../lib/lichess";
import { useGameStore } from "./gameStore";

/** Every Lichess Tauri command that authenticates carries a `slot: TokenSlot`
 * discriminator (`"human"|"bot"`) so Rust picks the right keychain entry.
 * This module always uses `human` -- see `TokenSlot`'s doc comment in
 * `src-tauri/src/lichess.rs` for why the slot is a first-class enum. */
const HUMAN_SLOT = "human" as const;

export type LichessStatus = "idle" | "connecting" | "connected" | "error" | "gameOver";

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
  errorMessage: string | null;
  lastSentUci: string | null;

  refreshHasToken: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
  /** Live-fetch `/api/account` under the human slot and cache the result.
   * Populates `verifiedAccount` on success, `verifyError` on failure. */
  verifyAccount: () => Promise<void>;
  connect: (gameIdOrUrl: string) => Promise<void>;
  disconnect: () => Promise<void>;
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

function applyIncomingMoves(update: ReturnType<typeof parseLichessLine>) {
  if (!update) return;
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

function installListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void listen<string>("lichess-game-stream", (event) => {
    applyIncomingMoves(parseLichessLine(event.payload));
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

export const useLichessStore = create<LichessStoreState>((set, get) => ({
  hasToken: false,
  verifiedAccount: null,
  verifyError: null,
  gameId: null,
  status: "idle",
  errorMessage: null,
  lastSentUci: null,

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
    set({ hasToken: false, verifiedAccount: null, verifyError: null });
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

  connect: async (gameIdOrUrl) => {
    // Re-entrancy guard, same reasoning as engineStore's startEngine: a
    // duplicate call while a connect is already in flight would otherwise
    // start a second stream task that immediately aborts the first one.
    if (!NOT_CONNECTED.has(get().status)) return;

    // Fair-play guard, mirrored on the frontend for a fast, clear error:
    // Rust's `token_for_slot_verified` will also refuse a BOT account on
    // the human slot, but running the check locally when the cached
    // verify result already answers it avoids a needless HTTP round-trip
    // just to produce the same error message.
    const verified = get().verifiedAccount;
    if (verified?.isBot) {
      failLichess(
        `the human slot's token belongs to a BOT account ("${verified.username}") -- put it in the bot slot instead`,
      );
      return;
    }

    installListenersOnce();
    set({
      status: "connecting",
      errorMessage: null,
      lastSentUci: null,
      gameId: gameIdOrUrl,
    });
    logDebug(`connecting: ${gameIdOrUrl}`);
    try {
      await invoke("lichess_stream_game", { gameIdOrUrl });
      set({ status: "connected" });
      logDebug("connected");
      // Only unlock moves once the stream is actually confirmed connected --
      // gameStore.startNewGame (called before this) resets the board but
      // deliberately leaves moves locked until now, same as engineStore.
      useGameStore.getState().enterPlayMode();
    } catch (err) {
      failLichess(String(err));
    }
  },

  disconnect: async () => {
    logDebug("disconnect requested");
    try {
      await invoke("lichess_stop_game");
    } finally {
      set({ status: "idle", errorMessage: null, gameId: null });
      useGameStore.getState().exitPlayMode();
    }
  },
}));
