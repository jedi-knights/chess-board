import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ply } from "../lib/chessRules";
import { useGameStore } from "./gameStore";
import { movesToApply, pendingMoveToSend, useLichessStore } from "./lichessStore";

// Same rationale as engineStore.test.ts: `invoke`/`listen` are Tauri's IPC
// boundary, a genuine system edge -- mocking them here is not a same-team
// collaborator mock. Assertions go through lichessStore's/gameStore's own
// public state, never internal call traces alone.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;

const listeners = new Map<string, (event: { payload: unknown }) => void>();

function emit(eventName: string, payload: unknown) {
  listeners.get(eventName)?.({ payload });
}

function ply(uci: string, color: "w" | "b"): Ply {
  return { san: uci, uci, fenBefore: "", fenAfter: "", color };
}

beforeEach(() => {
  // Deliberately not cleared -- `installListenersOnce` only ever calls
  // `listen()` once per module lifetime, same as production; see
  // engineStore.test.ts for the same reasoning.
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

  useLichessStore.setState({
    hasToken: false,
    verifiedAccount: null,
    verifyError: null,
    gameId: null,
    status: "idle",
    seekStatus: "idle",
    errorMessage: null,
    lastSentUci: null,
    serverClocks: null,
  });
});

describe("pendingMoveToSend", () => {
  it("returns null when there are no plies yet", () => {
    expect(pendingMoveToSend([], "w", null)).toBeNull();
  });

  it("returns the human's last move when it hasn't been sent yet", () => {
    const plies = [ply("e2e4", "w")];
    expect(pendingMoveToSend(plies, "w", null)).toBe("e2e4");
  });

  it("returns null when the last move was the opponent's, not the human's", () => {
    const plies = [ply("e2e4", "w"), ply("e7e5", "b")];
    expect(pendingMoveToSend(plies, "w", "e2e4")).toBeNull();
  });

  it("returns null when the human's last move was already sent", () => {
    const plies = [ply("e2e4", "w")];
    expect(pendingMoveToSend(plies, "w", "e2e4")).toBeNull();
  });

  it("works symmetrically for a human playing black", () => {
    const plies = [ply("e2e4", "w"), ply("e7e5", "b")];
    expect(pendingMoveToSend(plies, "b", null)).toBe("e7e5");
  });
});

describe("movesToApply", () => {
  it("returns every move on a fresh connection", () => {
    expect(movesToApply(["e2e4", "e7e5"], 0)).toEqual(["e2e4", "e7e5"]);
  });

  it("returns only the moves not yet applied locally", () => {
    expect(movesToApply(["e2e4", "e7e5", "g1f3"], 2)).toEqual(["g1f3"]);
  });

  it("returns nothing when Lichess echoes back a move already applied locally", () => {
    expect(movesToApply(["e2e4"], 1)).toEqual([]);
  });

  it("returns nothing when there are no new moves at all", () => {
    expect(movesToApply([], 0)).toEqual([]);
  });
});

describe("refreshHasToken / setToken / clearToken", () => {
  it("refreshHasToken reflects whatever the backend reports and asks about the human slot", async () => {
    mockedInvoke.mockResolvedValueOnce(true);
    await useLichessStore.getState().refreshHasToken();
    expect(useLichessStore.getState().hasToken).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_token_has", { slot: "human" });
  });

  it("refreshHasToken defaults to false when the backend call fails", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("no keychain"));
    await useLichessStore.getState().refreshHasToken();
    expect(useLichessStore.getState().hasToken).toBe(false);
  });

  it("setToken stores the token in the human slot and flips hasToken", async () => {
    await useLichessStore.getState().setToken("secret-token");
    expect(useLichessStore.getState().hasToken).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_token_set", {
      slot: "human",
      token: "secret-token",
    });
  });

  it("setToken invalidates any previously-verified account", async () => {
    useLichessStore.setState({
      verifiedAccount: { id: "old", username: "old", isBot: false },
      verifyError: null,
    });
    await useLichessStore.getState().setToken("fresh");
    expect(useLichessStore.getState().verifiedAccount).toBeNull();
  });

  it("clearToken removes the human-slot token, resets hasToken, and drops the verified account", async () => {
    useLichessStore.setState({
      hasToken: true,
      verifiedAccount: { id: "u", username: "u", isBot: false },
    });
    await useLichessStore.getState().clearToken();
    expect(useLichessStore.getState().hasToken).toBe(false);
    expect(useLichessStore.getState().verifiedAccount).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_token_clear", { slot: "human" });
  });
});

describe("verifyAccount", () => {
  it("populates verifiedAccount on success and clears any stale error", async () => {
    mockedInvoke.mockResolvedValueOnce({ id: "alice", username: "Alice", isBot: false });
    useLichessStore.setState({ verifyError: "stale" });
    await useLichessStore.getState().verifyAccount();
    const state = useLichessStore.getState();
    expect(state.verifiedAccount).toEqual({ id: "alice", username: "Alice", isBot: false });
    expect(state.verifyError).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_verify_account", { slot: "human" });
  });

  it("records the error and drops any stale verified account on failure", async () => {
    useLichessStore.setState({ verifiedAccount: { id: "u", username: "u", isBot: false } });
    mockedInvoke.mockRejectedValueOnce(new Error("401 Unauthorized"));
    await useLichessStore.getState().verifyAccount();
    const state = useLichessStore.getState();
    expect(state.verifiedAccount).toBeNull();
    expect(state.verifyError).toContain("401");
  });
});

describe("joinGameById", () => {
  it("success path: status becomes connected and gameStore unlocks moves", async () => {
    useGameStore.getState().exitPlayMode();
    await useLichessStore.getState().joinGameById("game-1");
    expect(useLichessStore.getState().status).toBe("connected");
    expect(useGameStore.getState().mode).toBe("play");
  });

  it("failure path: status becomes error and gameStore exits play mode", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "lichess_stream_game"
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(undefined),
    );
    await useLichessStore.getState().joinGameById("game-1");
    const state = useLichessStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("network down");
    expect(useGameStore.getState().mode).toBe("replay");
  });

  it("refuses to connect when the human-slot token belongs to a BOT account", async () => {
    // Fair-play guard, defense-in-depth: Rust also refuses this, but the
    // frontend check produces the error without a needless HTTP round-trip.
    useLichessStore.setState({
      verifiedAccount: { id: "botty", username: "botty", isBot: true },
    });
    await useLichessStore.getState().joinGameById("game-1");
    const state = useLichessStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("BOT account");
    expect(state.errorMessage).toContain("bot slot");
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_stream_game", expect.anything());
  });

  it("resets controllers to a placeholder ({ w: lichess, b: lichess }) until gameFull arrives", async () => {
    useGameStore.getState().startNewGame({ w: "human", b: "engine" });
    await useLichessStore.getState().joinGameById("game-1");
    // Board is primed with the placeholder -- both sides Lichess-controlled.
    // No moves can be made through selectSquare until gameFull promotes
    // one side to "human". Verified via the mode/controllers pair rather
    // than the mode alone (mode is "play" because connect succeeded).
    expect(useGameStore.getState().controllers).toEqual({ w: "lichess", b: "lichess" });
  });
});

describe("seek", () => {
  it("marks seekStatus 'seeking' during the request and back to 'idle' on completion", async () => {
    let resolveSeek!: (v: undefined) => void;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "lichess_seek") return new Promise<undefined>((r) => { resolveSeek = r; });
      return Promise.resolve(undefined);
    });
    const seekPromise = useLichessStore.getState().seek({
      time: { minutes: 5, increment: 3 },
      rated: false,
      color: "random",
    });
    // Give the microtasks queued before `invoke("lichess_seek")` a chance
    // to run so seekStatus flips to "seeking" before we peek.
    await new Promise((r) => setTimeout(r, 0));
    expect(useLichessStore.getState().seekStatus).toBe("seeking");
    resolveSeek(undefined);
    await seekPromise;
    expect(useLichessStore.getState().seekStatus).toBe("idle");
  });

  it("refuses on a BOT account without invoking lichess_seek", async () => {
    useLichessStore.setState({
      verifiedAccount: { id: "b", username: "b", isBot: true },
    });
    await useLichessStore.getState().seek({
      time: { minutes: 5, increment: 3 },
      rated: false,
      color: "random",
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_seek", expect.anything());
    expect(useLichessStore.getState().status).toBe("error");
  });

  it("stopSeek invokes the Rust cancel and resets seekStatus", async () => {
    useLichessStore.setState({ seekStatus: "seeking" });
    await useLichessStore.getState().stopSeek();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_stop_seek");
    expect(useLichessStore.getState().seekStatus).toBe("idle");
  });
});

describe("challengeUser / challengeAi", () => {
  it("challengeUser forwards the shape Rust expects", async () => {
    mockedInvoke.mockClear();
    await useLichessStore.getState().challengeUser({
      username: "alice",
      time: { minutes: 5, increment: 3 },
      rated: true,
      color: "white",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_user", {
      username: "alice",
      minutes: 5,
      increment: 3,
      rated: true,
      color: "white",
    });
  });

  it("challengeAi forwards level and time-control fields", async () => {
    mockedInvoke.mockClear();
    await useLichessStore.getState().challengeAi({
      level: 3,
      time: { minutes: 10, increment: 5 },
      color: "black",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_challenge_ai", {
      level: 3,
      minutes: 10,
      increment: 5,
      color: "black",
    });
  });

  it("both refuse on a BOT account", async () => {
    useLichessStore.setState({
      verifiedAccount: { id: "b", username: "b", isBot: true },
    });
    await useLichessStore.getState().challengeUser({
      username: "alice",
      time: { minutes: 5, increment: 3 },
      rated: false,
      color: "random",
    });
    await useLichessStore.getState().challengeAi({
      level: 1,
      time: { minutes: 5, increment: 3 },
      color: "random",
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_user", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_challenge_ai", expect.anything());
  });
});

describe("handleAccountEvent", () => {
  it("gameStart auto-connects the game stream", async () => {
    useLichessStore.getState().handleAccountEvent({
      type: "gameStart",
      gameId: "abcd1234",
      botColor: "w",
    });
    // Auto-connect fires asynchronously.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_stream_game", {
      gameIdOrUrl: "abcd1234",
    });
  });

  it("gameStart clears seekStatus back to idle (seek was matched)", async () => {
    useLichessStore.setState({ seekStatus: "seeking" });
    useLichessStore.getState().handleAccountEvent({
      type: "gameStart",
      gameId: "abcd1234",
      botColor: "b",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(useLichessStore.getState().seekStatus).toBe("idle");
  });

  it("challenge* / gameFinish events are log-only, not connect triggers", async () => {
    mockedInvoke.mockClear();
    useLichessStore.getState().handleAccountEvent({
      type: "challenge",
      challengeId: "chal1234",
      challenger: { id: "alice", name: "Alice", title: null },
      destUser: null,
      variant: "standard",
      speed: "blitz",
      rated: false,
      initialFen: null,
      timeControl: {
        type: "clock",
        limitSeconds: 300,
        incrementSeconds: 3,
        daysPerTurn: null,
      },
    });
    useLichessStore.getState().handleAccountEvent({
      type: "gameFinish",
      gameId: "abcd1234",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedInvoke).not.toHaveBeenCalledWith("lichess_stream_game", expect.anything());
  });
});

describe("disconnect", () => {
  it("resets to idle, clears the game id, and exits play mode", async () => {
    await useLichessStore.getState().joinGameById("game-1");
    await useLichessStore.getState().disconnect();
    const state = useLichessStore.getState();
    expect(state.status).toBe("idle");
    expect(state.gameId).toBeNull();
    expect(useGameStore.getState().mode).toBe("replay");
  });

  it("also stops any in-flight event stream and seek", async () => {
    await useLichessStore.getState().joinGameById("game-1");
    mockedInvoke.mockClear();
    await useLichessStore.getState().disconnect();
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_stop_events");
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_stop_seek");
  });
});

describe("lichess-game-stream listener", () => {
  it("applies incoming moves not yet reflected locally", async () => {
    await useLichessStore.getState().joinGameById("game-1");

    emit(
      "lichess-game-stream",
      JSON.stringify({ type: "gameState", moves: "e2e4", status: "started" }),
    );

    expect(useGameStore.getState().plies.map((p) => p.uci)).toEqual(["e2e4"]);
  });

  it("derives human-side controllers from gameFull's white/black ids", async () => {
    useLichessStore.setState({
      verifiedAccount: { id: "me", username: "me", isBot: false },
    });
    await useLichessStore.getState().joinGameById("game-1");

    emit(
      "lichess-game-stream",
      JSON.stringify({
        type: "gameFull",
        id: "game-1",
        white: { id: "me", name: "Me" },
        black: { id: "opp", name: "Opp" },
        state: { type: "gameState", moves: "", status: "started" },
      }),
    );

    expect(useGameStore.getState().controllers).toEqual({ w: "human", b: "lichess" });
    expect(useGameStore.getState().pov).toBe("w");
  });

  it("derives human plays black when the verified id matches black", async () => {
    useLichessStore.setState({
      verifiedAccount: { id: "me", username: "me", isBot: false },
    });
    await useLichessStore.getState().joinGameById("game-1");

    emit(
      "lichess-game-stream",
      JSON.stringify({
        type: "gameFull",
        id: "game-1",
        white: { id: "opp", name: "Opp" },
        black: { id: "me", name: "Me" },
        state: { type: "gameState", moves: "", status: "started" },
      }),
    );

    expect(useGameStore.getState().controllers).toEqual({ w: "lichess", b: "human" });
    expect(useGameStore.getState().pov).toBe("b");
  });

  it("leaves the placeholder controllers when neither white nor black matches the verified account (spectator)", async () => {
    useLichessStore.setState({
      verifiedAccount: { id: "me", username: "me", isBot: false },
    });
    await useLichessStore.getState().joinGameById("game-1");

    emit(
      "lichess-game-stream",
      JSON.stringify({
        type: "gameFull",
        id: "game-1",
        white: { id: "alice", name: "Alice" },
        black: { id: "bob", name: "Bob" },
        state: { type: "gameState", moves: "", status: "started" },
      }),
    );

    // Neither side gets promoted to human -- moves stay locked, matching
    // Lichess Board API's spectator-connection semantics.
    expect(useGameStore.getState().controllers).toEqual({ w: "lichess", b: "lichess" });
  });

  it("a terminal status ends the game and stops it backend-side", async () => {
    await useLichessStore.getState().joinGameById("game-1");

    emit(
      "lichess-game-stream",
      JSON.stringify({ type: "gameState", moves: "", status: "resign" }),
    );

    expect(useLichessStore.getState().status).toBe("gameOver");
    expect(useGameStore.getState().mode).toBe("replay");
    expect(mockedInvoke).toHaveBeenCalledWith("lichess_stop_game");
  });

  it("an illegal move from Lichess fails the connection", async () => {
    await useLichessStore.getState().joinGameById("game-1");

    emit(
      "lichess-game-stream",
      JSON.stringify({ type: "gameState", moves: "e2e5", status: "started" }),
    );

    const state = useLichessStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("illegal move");
  });
});

describe("lichess-game-exit listener", () => {
  it("fails the connection when it was actually connected", async () => {
    await useLichessStore.getState().joinGameById("game-1");

    emit("lichess-game-exit", "stream closed by server");

    const state = useLichessStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("stream closed by server");
  });

  it("is a no-op when not currently connected (e.g. after a deliberate disconnect)", async () => {
    await useLichessStore.getState().joinGameById("game-1");
    await useLichessStore.getState().disconnect();

    emit("lichess-game-exit", "late, stale exit event");

    expect(useLichessStore.getState().status).toBe("idle");
  });
});

describe("maybeSendHumanMove (via gameStore subscription)", () => {
  it("sends the human's own move to Lichess once connected and controllers are set", async () => {
    await useLichessStore.getState().joinGameById("game-1");
    useGameStore.getState().setControllers({ w: "human", b: "lichess" }, "w");
    mockedInvoke.mockClear();

    useGameStore.getState().attemptMove("e2", "e4");

    expect(mockedInvoke).toHaveBeenCalledWith("lichess_make_move", {
      gameIdOrUrl: "game-1",
      uciMove: "e2e4",
    });
    expect(useLichessStore.getState().lastSentUci).toBe("e2e4");
  });

  it("fails the connection if sending the move itself rejects", async () => {
    await useLichessStore.getState().joinGameById("game-1");
    useGameStore.getState().setControllers({ w: "human", b: "lichess" }, "w");
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "lichess_make_move"
        ? Promise.reject(new Error("lichess unreachable"))
        : Promise.resolve(undefined),
    );

    useGameStore.getState().attemptMove("e2", "e4");
    await Promise.resolve();
    await Promise.resolve();

    const state = useLichessStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("lichess unreachable");
  });

  it("does not resend a move that was just received from the opponent", async () => {
    await useLichessStore.getState().joinGameById("game-1");
    useGameStore.getState().setControllers({ w: "lichess", b: "human" }, "b");
    mockedInvoke.mockClear();

    // White's move arrives via the stream, not from this human -- the
    // ply's color ("w") doesn't match the human's side ("b"), so nothing
    // should be sent back to Lichess for it.
    useGameStore.getState().attemptMove("e2", "e4");

    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "lichess_make_move",
      expect.anything(),
    );
  });
});
