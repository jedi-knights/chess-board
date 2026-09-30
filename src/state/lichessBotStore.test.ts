import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "./gameStore";
import { useLichessBotStore } from "./lichessBotStore";

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

  useLichessBotStore.setState({
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
  });
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

describe("setAcceptRated", () => {
  it("flips the persisted preference", () => {
    expect(useLichessBotStore.getState().acceptRated).toBe(false);
    useLichessBotStore.getState().setAcceptRated(true);
    expect(useLichessBotStore.getState().acceptRated).toBe(true);
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
