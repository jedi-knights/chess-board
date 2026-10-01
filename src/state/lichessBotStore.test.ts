import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBlackEngineStore, useWhiteEngineStore } from "./engineStore";
import { useGameModeStore } from "./gameModeStore";
import { useGameStore } from "./gameStore";
import {
  isNoBotPolicyDecline,
  parseRateLimitSeconds,
  useLichessBotStore,
} from "./lichessBotStore";

// Same rationale as engineStore.test.ts / lichessStore.test.ts: `invoke`
// and `listen` are Tauri's IPC boundary, a genuine system edge. Everything
// asserted below goes through the store's own public state, not internal
// call traces alone.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;

// Same "not cleared between tests" pattern as engineStore.test.ts --
// `installListenersOnce` only registers callbacks once per module
// lifetime, and clearing the registered map would desync the test
// double from production.
const listeners = new Map<string, (event: { payload: unknown }) => void>();

beforeEach(() => {
  mockedListen.mockImplementation(
    (eventName: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, cb);
      return Promise.resolve(() => listeners.delete(eventName));
    },
  );
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined);

  useGameStore.getState().loadGame([]);
  useGameStore.getState().startNewGame({ w: "human", b: "human" });
  useGameStore.getState().enterPlayMode();

  // PR 4 moved the account-event listener into a shared `lichessEventBus`
  // that dispatches by the current game-mode preset. These tests target
  // bot-mode behavior, so pin the preset here -- otherwise every event
  // is dropped by the bus (correctly) and the accept/decline invokes
  // never fire.
  useGameModeStore.setState({ preset: "engine-vs-lichess" });
  useLichessBotStore.setState({
    hasToken: false,
    verifiedAccount: null,
    verifyError: null,
    acceptRated: false,
    lagMarginMs: 100,
    serverClocks: null,
    enginePath: null,
    movetimeMs: 1000,
    status: "idle",
    errorMessage: null,
    activeGameId: null,
    lastSentUci: null,
  });
  // Reset both engine stores to a clean idle -- earlier tests may leave
  // a ready-status engine, and handleGameStart's between-games reuse
  // branch depends on the initial engine state, not a leftover one.
  useWhiteEngineStore.setState({
    path: null,
    status: "idle",
    movetimeMs: 1000,
    lastInfo: null,
    searchInfoHistory: [],
    options: [],
    optionValues: {},
    errorMessage: null,
  });
  useBlackEngineStore.setState({
    path: null,
    status: "idle",
    movetimeMs: 1000,
    lastInfo: null,
    searchInfoHistory: [],
    options: [],
    optionValues: {},
    errorMessage: null,
  });
  useWhiteEngineStore.getState().setGoBuilder(null);
  useBlackEngineStore.getState().setGoBuilder(null);
});

function emit(eventName: string, payload: unknown) {
  listeners.get(eventName)?.({ payload });
}

/**
 * Fires the account event stream through the same seam Rust would, so the
 * store's `installListenersOnce()` listener runs its full switch/route.
 * Requires the listener to have been installed -- call `startListening`
 * (with a verified BOT account) once per test that needs this.
 */
function emitAccountEvent(event: unknown) {
  emit("lichess-event-stream", JSON.stringify(event));
}

async function startBotListening() {
  useLichessBotStore.setState({
    enginePath: "/bin/engine",
    verifiedAccount: { id: "mybot", username: "MyBot", isBot: true },
  });
  await useLichessBotStore.getState().startListening();
}

describe("refreshHasToken / setToken / clearToken", () => {
  it("refreshHasToken asks about the bot slot specifically", async () => {
    mockedInvoke.mockResolvedValueOnce(true);
    await useLichessBotStore.getState().refreshHasToken();
    expect(useLichessBotStore.getState().hasToken).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_token_has", { slot: "bot" });
  });

  it("setToken stores the token in the bot slot and invalidates the verified account", async () => {
    useLichessBotStore.setState({
      verifiedAccount: { id: "old", username: "old", isBot: true },
    });
    await useLichessBotStore.getState().setToken("bot-token");
    expect(useLichessBotStore.getState().hasToken).toBe(true);
    expect(useLichessBotStore.getState().verifiedAccount).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_token_set", {
      slot: "bot",
      token: "bot-token",
    });
  });

  it("clearToken removes the bot-slot token and drops the verified account", async () => {
    useLichessBotStore.setState({
      hasToken: true,
      verifiedAccount: { id: "b", username: "b", isBot: true },
    });
    await useLichessBotStore.getState().clearToken();
    expect(useLichessBotStore.getState().hasToken).toBe(false);
    expect(useLichessBotStore.getState().verifiedAccount).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_token_clear", { slot: "bot" });
  });
});

describe("oauthLogin", () => {
  it("stores the token, populates verifiedAccount, and forwards the bot slot", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "lichess_oauth_login"
        ? Promise.resolve({ id: "botty", username: "Botty", isBot: true })
        : Promise.resolve(undefined),
    );
    await useLichessBotStore.getState().oauthLogin();
    const state = useLichessBotStore.getState();
    expect(state.hasToken).toBe(true);
    expect(state.verifiedAccount).toEqual({ id: "botty", username: "Botty", isBot: true });
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_oauth_login", { slot: "bot" });
  });

  it("captures errors in verifyError without setting hasToken", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "lichess_oauth_login"
        ? Promise.reject(new Error("state mismatch"))
        : Promise.resolve(undefined),
    );
    await useLichessBotStore.getState().oauthLogin();
    const state = useLichessBotStore.getState();
    expect(state.hasToken).toBe(false);
    expect(state.verifyError).toContain("state mismatch");
  });
});

describe("verifyAccount", () => {
  it("populates verifiedAccount on success", async () => {
    mockedInvoke.mockResolvedValueOnce({ id: "botty", username: "Botty", isBot: true });
    useLichessBotStore.setState({ verifyError: "stale" });
    await useLichessBotStore.getState().verifyAccount();
    const state = useLichessBotStore.getState();
    expect(state.verifiedAccount).toEqual({ id: "botty", username: "Botty", isBot: true });
    expect(state.verifyError).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_verify_account", { slot: "bot" });
  });

  it("records the error and drops any stale verified account on failure", async () => {
    useLichessBotStore.setState({
      verifiedAccount: { id: "b", username: "b", isBot: true },
    });
    mockedInvoke.mockRejectedValueOnce(new Error("network down"));
    await useLichessBotStore.getState().verifyAccount();
    const state = useLichessBotStore.getState();
    expect(state.verifiedAccount).toBeNull();
    expect(state.verifyError).toContain("network down");
  });
});

describe("startListening fair-play guard", () => {
  it("refuses to listen when the verified bot-slot account is not a BOT", async () => {
    // Fair-play guard, defense-in-depth: Rust also refuses this via
    // `enforce_slot_matches`, but the frontend check avoids a needless
    // HTTP round-trip whose only outcome is the same error.
    useLichessBotStore.setState({
      enginePath: "/bin/engine",
      verifiedAccount: { id: "alice", username: "Alice", isBot: false },
    });
    await useLichessBotStore.getState().startListening();
    const state = useLichessBotStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("non-BOT account");
    // Never even called the events-stream command.
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_stream_events", expect.anything());
  });

  it("allows listening when the verified account is a BOT", async () => {
    useLichessBotStore.setState({
      enginePath: "/bin/engine",
      verifiedAccount: { id: "b", username: "B", isBot: true },
    });
    await useLichessBotStore.getState().startListening();
    expect(useLichessBotStore.getState().status).toBe("listening");
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_stream_events", { slot: "bot" });
  });
});

describe("account event stream routes challenges through decideChallenge", () => {
  function fullChallenge(overrides: Record<string, unknown> = {}) {
    return {
      type: "challenge",
      challenge: {
        id: "abcd1234",
        challenger: { id: "alice", name: "Alice", title: null },
        destUser: { id: "mybot" },
        variant: { key: "standard" },
        speed: "blitz",
        rated: false,
        timeControl: { type: "clock", limit: 300, increment: 3 },
        ...overrides,
      },
    };
  }

  it("accepts a plain standard casual blitz challenge from someone else", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent(fullChallenge());
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_accept", {
      slot: "bot",
      challengeId: "abcd1234",
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_decline", expect.anything());
  });

  it("drops a self-challenge without calling accept or decline", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent(
      fullChallenge({ challenger: { id: "mybot", name: "MyBot", title: "BOT" } }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_accept", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_decline", expect.anything());
  });

  it("declines a variant challenge with reason 'variant'", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent(fullChallenge({ variant: { key: "chess960" } }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_decline", {
      slot: "bot",
      challengeId: "abcd1234",
      reason: "variant",
    });
  });

  it("declines a rated challenge with reason 'rated' by default", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent(fullChallenge({ rated: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_decline", {
      slot: "bot",
      challengeId: "abcd1234",
      reason: "rated",
    });
  });

  it("accepts a rated challenge once acceptRated is on", async () => {
    await startBotListening();
    useLichessBotStore.getState().setAcceptRated(true);
    mockedInvoke.mockClear();

    emitAccountEvent(fullChallenge({ rated: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_accept", {
      slot: "bot",
      challengeId: "abcd1234",
    });
  });

  it("declines a challenge with 'later' when a game is already in progress", async () => {
    await startBotListening();
    useLichessBotStore.setState({ activeGameId: "otherGame" });
    mockedInvoke.mockClear();

    emitAccountEvent(fullChallenge());
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_decline", {
      slot: "bot",
      challengeId: "abcd1234",
      reason: "later",
    });
  });

  it("declines a custom-starting-FEN challenge with reason 'generic'", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent(
      fullChallenge({ initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_decline", {
      slot: "bot",
      challengeId: "abcd1234",
      reason: "generic",
    });
  });

  it("declines a correspondence challenge with reason 'timeControl'", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent(
      fullChallenge({
        speed: "correspondence",
        timeControl: { type: "correspondence", daysPerTurn: 3 },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_decline", {
      slot: "bot",
      challengeId: "abcd1234",
      reason: "timeControl",
    });
  });

  it("ignores challengeCanceled, challengeDeclined, and gameFinish (log-only)", async () => {
    await startBotListening();
    mockedInvoke.mockClear();

    emitAccountEvent({ type: "challengeCanceled", challenge: { id: "abcd1234" } });
    emitAccountEvent({
      type: "challengeDeclined",
      challenge: { id: "abcd1234", reason: "variant" },
    });
    emitAccountEvent({ type: "gameFinish", game: { gameId: "abcd1234" } });
    await new Promise((r) => setTimeout(r, 0));

    // None of these should touch accept/decline endpoints.
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_accept", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_decline", expect.anything());
  });
});

describe("setAcceptRated / setLagMarginMs", () => {
  it("flips the persisted acceptRated preference", () => {
    expect(useLichessBotStore.getState().acceptRated).toBe(false);
    useLichessBotStore.getState().setAcceptRated(true);
    expect(useLichessBotStore.getState().acceptRated).toBe(true);
  });

  it("updates the persisted lag margin", () => {
    expect(useLichessBotStore.getState().lagMarginMs).toBe(100);
    useLichessBotStore.getState().setLagMarginMs(250);
    expect(useLichessBotStore.getState().lagMarginMs).toBe(250);
  });
});

describe("handleGameStart between-games reuse (ucinewgame)", () => {
  it("reuses a ready engine on the same path via ucinewgame + isready, not a full restart", async () => {
    await startBotListening();
    useLichessBotStore.setState({ enginePath: "/bin/engine" });
    // Run a real startEngine so the store's plies-subscription is wired
    // (setState alone leaves it un-installed) and status transitions to
    // "ready" through the real path.
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    mockedInvoke.mockClear();

    // gameStart -> bot plays white.
    emitAccountEvent({ type: "gameStart", game: { gameId: "gameA123", color: "white" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Should have sent ucinewgame + isready to the existing engine, NOT
    // engine_start (which would restart the whole process).
    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "w",
      line: "ucinewgame",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "w",
      line: "isready",
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("engine_start", expect.anything());
  });

  it("stops and restarts when the engine path changed since the previous game", async () => {
    await startBotListening();
    // Start on the old path, then flip the bot's engine choice to a new
    // one -- handleGameStart should notice path drift and restart.
    await useWhiteEngineStore.getState().startEngine("/bin/old-engine");
    useLichessBotStore.setState({ enginePath: "/bin/new-engine" });
    mockedInvoke.mockClear();

    emitAccountEvent({ type: "gameStart", game: { gameId: "gameA123", color: "white" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Path differs -> full restart path.
    expect(mockedInvoke).toHaveBeenCalledWith("engine_stop", { side: "w" });
    expect(mockedInvoke).toHaveBeenCalledWith("engine_start", {
      side: "w",
      path: "/bin/new-engine",
    });
  });
});

describe("handleGameStart installs a clock-driven goBuilder", () => {
  it("go includes wtime/btime/winc/binc + movetime cap once server clocks arrive", async () => {
    // Fix Date.now() so the elapsed-since-server-update subtraction is
    // deterministic (elapsed = 0 -> only lagMarginMs subtracted from
    // the bot's own clock).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await startBotListening();
      useLichessBotStore.setState({
        enginePath: "/bin/engine",
        movetimeMs: 5000,
        lagMarginMs: 100,
      });
      // Bot plays *black* here so the initial handleGameStart -> checkTurn
      // path doesn't immediately send a `go` before any clocks arrive
      // (initial side to move is white). Then a white move via the
      // stream gives the bot its turn. Call startEngine (not a raw
      // setState) so the gameStore.subscribe listener actually gets
      // installed -- that's what wires plies-length changes into
      // maybeRequestEngineMove.
      await useBlackEngineStore.getState().startEngine("/bin/engine");

      emitAccountEvent({ type: "gameStart", game: { gameId: "gameA123", color: "black" } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // First gameState establishes the clock baseline (empty move list).
      emit(
        "lichess-bot-game-stream",
        JSON.stringify({
          type: "gameState",
          moves: "",
          status: "started",
          wtime: 60000,
          btime: 60000,
          winc: 2000,
          binc: 2000,
        }),
      );
      // Clear now so the assertion catches only the clock-driven `go`.
      mockedInvoke.mockClear();
      // White plays e2e4 -- gives the bot (black) the turn.
      emit(
        "lichess-bot-game-stream",
        JSON.stringify({
          type: "gameState",
          moves: "e2e4",
          status: "started",
          wtime: 58000,
          btime: 60000,
          winc: 2000,
          binc: 2000,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      const goInvocations = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "engine_write_line" &&
          typeof args === "object" &&
          args !== null &&
          typeof (args as { line?: unknown }).line === "string" &&
          (args as { line: string }).line.startsWith("go "),
      );
      expect(goInvocations).not.toHaveLength(0);
      const lastGo = (goInvocations.at(-1)?.[1] as { line: string }).line;
      // Bot plays black, so only btime carries the lagMarginMs adjustment.
      // wtime stays at 58000 (white isn't thinking); btime = 60000 - 100.
      expect(lastGo).toContain("wtime 58000");
      expect(lastGo).toContain("btime 59900");
      expect(lastGo).toContain("winc 2000");
      expect(lastGo).toContain("binc 2000");
      expect(lastGo).toContain("movetime 5000");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clock tracking annotates last-ply think-time", () => {
  it("attaches thinkTimeSeconds to the ply just applied when clocks are known", async () => {
    await startBotListening();
    useLichessBotStore.setState({ enginePath: "/bin/engine" });
    useWhiteEngineStore.setState({ status: "ready", path: "/bin/engine" });

    // Bot plays black. Trigger the gameStart flow.
    emitAccountEvent({ type: "gameStart", game: { gameId: "gameC456", color: "black" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // First gameState: no plies yet, but establishes the clock baseline.
    emit(
      "lichess-bot-game-stream",
      JSON.stringify({
        type: "gameState",
        moves: "",
        status: "started",
        wtime: 60000,
        btime: 60000,
        winc: 2000,
        binc: 2000,
      }),
    );
    // White plays e2e4 -- consumed 3s off wtime (60 -> 59 with 2s inc; new is 60-3+2=59).
    emit(
      "lichess-bot-game-stream",
      JSON.stringify({
        type: "gameState",
        moves: "e2e4",
        status: "started",
        wtime: 59000,
        btime: 60000,
        winc: 2000,
        binc: 2000,
      }),
    );
    await Promise.resolve();

    const lastPly = useGameStore.getState().plies.at(-1);
    expect(lastPly?.color).toBe("w");
    // thinkTime = prev(60000) + winc(2000) - new(59000) = 3000 ms = 3s.
    expect(lastPly?.thinkTimeSeconds).toBe(3);
    expect(lastPly?.clockSeconds).toBe(59);
  });
});

describe("in-game actions", () => {
  it("resign forwards the current activeGameId and hits the bot-slot endpoint", async () => {
    await startBotListening();
    useLichessBotStore.setState({ activeGameId: "gameA123", status: "playing" });
    mockedInvoke.mockClear();

    await useLichessBotStore.getState().resign();

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_bot_resign", {
      gameIdOrUrl: "gameA123",
    });
  });

  it("abort / agreeToDraw / declineDraw / claimVictory forward the current game id", async () => {
    await startBotListening();
    useLichessBotStore.setState({ activeGameId: "gameA123", status: "playing" });
    mockedInvoke.mockClear();

    await useLichessBotStore.getState().abort();
    await useLichessBotStore.getState().agreeToDraw();
    await useLichessBotStore.getState().declineDraw();
    await useLichessBotStore.getState().claimVictory();

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_bot_abort", { gameIdOrUrl: "gameA123" });
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_bot_draw", {
      gameIdOrUrl: "gameA123",
      accept: true,
    });
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_bot_draw", {
      gameIdOrUrl: "gameA123",
      accept: false,
    });
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_bot_claim_victory", {
      gameIdOrUrl: "gameA123",
    });
  });

  it("actions are no-ops when there is no active game id", async () => {
    await startBotListening();
    // No activeGameId set; setState left it null.
    mockedInvoke.mockClear();
    await useLichessBotStore.getState().resign();
    await useLichessBotStore.getState().claimVictory();
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_bot_resign", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "lichess_bot_claim_victory",
      expect.anything(),
    );
  });
});

describe("opponentGone on the bot-game stream", () => {
  it("captures gone=true and clears on gone=false", async () => {
    await startBotListening();
    useLichessBotStore.setState({ status: "playing", activeGameId: "gameA123" });

    emit(
      "lichess-bot-game-stream",
      JSON.stringify({ type: "opponentGone", gone: true, claimWinInSeconds: 45 }),
    );
    expect(useLichessBotStore.getState().opponentGone).toEqual({
      gone: true,
      claimWinInSeconds: 45,
    });

    emit(
      "lichess-bot-game-stream",
      JSON.stringify({ type: "opponentGone", gone: false }),
    );
    expect(useLichessBotStore.getState().opponentGone).toEqual({
      gone: false,
      claimWinInSeconds: null,
    });
  });
});

describe("upgradeToBotAccount", () => {
  it("returns true on success and invalidates any pre-upgrade verified account", async () => {
    useLichessBotStore.setState({
      verifiedAccount: { id: "u", username: "u", isBot: false },
    });
    const ok = await useLichessBotStore.getState().upgradeToBotAccount();
    expect(ok).toBe(true);
    expect(useLichessBotStore.getState().verifiedAccount).toBeNull();
  });

  it("returns false on failure and records the error without touching verifiedAccount", async () => {
    useLichessBotStore.setState({
      verifiedAccount: { id: "u", username: "u", isBot: false },
    });
    // Rejecting by command name -- a `mockRejectedValueOnce` would be
    // consumed by the fire-and-forget `debug_log_append` call inside
    // `logDebug` first, leaving the real command to hit the default
    // resolve. Same reason engineStore.test.ts uses mockImplementation.
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "lichess_bot_upgrade"
        ? Promise.reject(new Error("already a bot"))
        : Promise.resolve(undefined),
    );
    const ok = await useLichessBotStore.getState().upgradeToBotAccount();
    expect(ok).toBe(false);
    expect(useLichessBotStore.getState().errorMessage).toContain("already a bot");
    // Pre-upgrade account survives -- the UI still shows what it was.
    expect(useLichessBotStore.getState().verifiedAccount?.username).toBe("u");
  });
});

describe("parseRateLimitSeconds", () => {
  it("extracts the seconds field from Lichess's 400 Bad Request body", () => {
    // Verbatim shape of the error the user actually hit: the Rust
    // error string is `<prefix>: <status> <reason> <jsonBody>`, so we
    // match a raw substring rather than trying to split out and
    // JSON-parse the embedded body.
    const err =
      'lichess rejected the challenge to maia1: 400 Bad Request {"error":"maia1 played 100 games against other bots today, please wait until 2026-10-01T07:06:08.826Z to challenge them.","ratelimit":{"key":"bot.vsBot.day","seconds":21164}}';
    expect(parseRateLimitSeconds(err)).toBe(21164);
  });

  it("tolerates whitespace variations around the colon", () => {
    expect(parseRateLimitSeconds('"seconds" : 60')).toBe(60);
    expect(parseRateLimitSeconds('"seconds":  3600')).toBe(3600);
  });

  it("returns null when the field is absent", () => {
    expect(parseRateLimitSeconds("lichess rejected the move e2e5: 400")).toBeNull();
    expect(parseRateLimitSeconds("network down")).toBeNull();
    expect(parseRateLimitSeconds("")).toBeNull();
  });

  it("returns null for non-positive or non-finite values", () => {
    expect(parseRateLimitSeconds('"seconds":0')).toBeNull();
    expect(parseRateLimitSeconds('"seconds":-5')).toBeNull();
  });
});

describe("isNoBotPolicyDecline", () => {
  it("matches the Lichess structured enum tag", () => {
    expect(isNoBotPolicyDecline("noBot")).toBe(true);
  });

  it("matches the human-readable text Lichess surfaces by default", () => {
    // The exact phrasing in the user's actual debug.log on a bot that
    // refused jk-bot. Keep this test wired to the verbatim string so
    // a future Lichess rewording surfaces as a test failure, not a
    // silent regression where the pattern stops matching.
    expect(isNoBotPolicyDecline("I'm not accepting challenges from bots.")).toBe(true);
    expect(isNoBotPolicyDecline("Not accepting challenges from bot accounts")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNoBotPolicyDecline("I DON'T ACCEPT CHALLENGES FROM BOTS")).toBe(true);
  });

  it("does not match transient decline reasons", () => {
    expect(isNoBotPolicyDecline("later")).toBe(false);
    expect(isNoBotPolicyDecline("rated")).toBe(false);
    expect(isNoBotPolicyDecline("timeControl")).toBe(false);
    expect(isNoBotPolicyDecline("Not right now, please try again later")).toBe(false);
  });

  it("does not match on `null` reasons", () => {
    expect(isNoBotPolicyDecline(null)).toBe(false);
  });
});
