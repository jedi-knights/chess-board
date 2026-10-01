import { describe, expect, it } from "vitest";
import {
  decideChallenge,
  isTerminalStatus,
  parseBotOnlineList,
  parseLichessAccountEvent,
  parseLichessLine,
  parseLichessOpponentGone,
  rulesFromLichessVariant,
  type ChallengeDecisionContext,
  type LichessChallengeEvent,
} from "./lichess";

describe("parseLichessLine", () => {
  it("parses a gameFull line via its nested state and surfaces clock fields", () => {
    const line = JSON.stringify({
      type: "gameFull",
      id: "abcd1234",
      state: {
        type: "gameState",
        moves: "e2e4 e7e5",
        status: "started",
        wtime: 60000,
        btime: 58000,
        winc: 2000,
        binc: 2000,
      },
    });
    expect(parseLichessLine(line)).toEqual({
      moves: ["e2e4", "e7e5"],
      status: "started",
      wtimeMs: 60000,
      btimeMs: 58000,
      wincMs: 2000,
      bincMs: 2000,
      whiteId: null,
      blackId: null,
      whiteName: null,
      blackName: null,
      whiteTitle: null,
      blackTitle: null,
      initialFen: null,
      variant: null,
    });
  });

  it("parses a gameState line and surfaces clock fields", () => {
    const line = JSON.stringify({
      type: "gameState",
      moves: "e2e4 e7e5 g1f3",
      status: "started",
      wtime: 57123,
      btime: 55432,
      winc: 3000,
      binc: 3000,
    });
    expect(parseLichessLine(line)).toEqual({
      moves: ["e2e4", "e7e5", "g1f3"],
      status: "started",
      wtimeMs: 57123,
      btimeMs: 55432,
      wincMs: 3000,
      bincMs: 3000,
      whiteId: null,
      blackId: null,
      whiteName: null,
      blackName: null,
      whiteTitle: null,
      blackTitle: null,
      initialFen: null,
      variant: null,
    });
  });

  it("returns null clock fields when the game has no clock (correspondence/unlimited)", () => {
    const line = JSON.stringify({ type: "gameState", moves: "", status: "started" });
    expect(parseLichessLine(line)).toEqual({
      moves: [],
      status: "started",
      wtimeMs: null,
      btimeMs: null,
      wincMs: null,
      bincMs: null,
      whiteId: null,
      blackId: null,
      whiteName: null,
      blackName: null,
      whiteTitle: null,
      blackTitle: null,
      initialFen: null,
      variant: null,
    });
  });

  it("surfaces gameFull's white/black ids for the human-color-derivation seam", () => {
    const line = JSON.stringify({
      type: "gameFull",
      id: "abcd1234",
      white: { id: "alice", name: "Alice" },
      black: { id: "bob", name: "Bob" },
      state: {
        type: "gameState",
        moves: "",
        status: "started",
        wtime: 60000,
        btime: 60000,
        winc: 2000,
        binc: 2000,
      },
    });
    const parsed = parseLichessLine(line);
    expect(parsed?.whiteId).toBe("alice");
    expect(parsed?.blackId).toBe("bob");
  });

  it("surfaces gameFull's white/black display name and title for the clock label", () => {
    const line = JSON.stringify({
      type: "gameFull",
      id: "abcd1234",
      white: { id: "jk-bot", name: "jk-bot", title: "BOT" },
      black: { id: "omcrosby", name: "omcrosby" },
      state: {
        type: "gameState",
        moves: "",
        status: "started",
        wtime: 60000,
        btime: 60000,
      },
    });
    const parsed = parseLichessLine(line);
    expect(parsed?.whiteName).toBe("jk-bot");
    expect(parsed?.whiteTitle).toBe("BOT");
    expect(parsed?.blackName).toBe("omcrosby");
    expect(parsed?.blackTitle).toBeNull();
  });

  it("surfaces gameFull's variant key for Chess960 and leaves it null for standard", () => {
    const chess960 = JSON.stringify({
      type: "gameFull",
      id: "ab",
      variant: { key: "chess960", name: "Chess960" },
      state: { type: "gameState", moves: "", status: "started" },
    });
    expect(parseLichessLine(chess960)?.variant).toBe("chess960");

    const standard = JSON.stringify({
      type: "gameFull",
      id: "ab",
      variant: { key: "standard", name: "Standard" },
      state: { type: "gameState", moves: "", status: "started" },
    });
    expect(parseLichessLine(standard)?.variant).toBe("standard");

    // gameState lines don't carry variant.
    const gs = JSON.stringify({ type: "gameState", moves: "", status: "started" });
    expect(parseLichessLine(gs)?.variant).toBeNull();
  });

  it("surfaces gameFull's initialFen for From Position / Chess960 and normalizes 'startpos' to null", () => {
    const customFen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
    const custom = JSON.stringify({
      type: "gameFull",
      id: "ab",
      initialFen: customFen,
      state: { type: "gameState", moves: "", status: "started" },
    });
    expect(parseLichessLine(custom)?.initialFen).toBe(customFen);

    const startpos = JSON.stringify({
      type: "gameFull",
      id: "ab",
      initialFen: "startpos",
      state: { type: "gameState", moves: "", status: "started" },
    });
    expect(parseLichessLine(startpos)?.initialFen).toBeNull();

    const missing = JSON.stringify({
      type: "gameFull",
      id: "ab",
      state: { type: "gameState", moves: "", status: "started" },
    });
    expect(parseLichessLine(missing)?.initialFen).toBeNull();
  });

  it("returns null for missing white/black objects on gameFull", () => {
    const line = JSON.stringify({
      type: "gameFull",
      id: "abcd1234",
      state: {
        type: "gameState",
        moves: "",
        status: "started",
      },
    });
    const parsed = parseLichessLine(line);
    expect(parsed?.whiteId).toBeNull();
    expect(parsed?.blackId).toBeNull();
    expect(parsed?.whiteName).toBeNull();
    expect(parsed?.blackName).toBeNull();
    expect(parsed?.whiteTitle).toBeNull();
    expect(parsed?.blackTitle).toBeNull();
  });

  it("returns null for a chatLine event", () => {
    const line = JSON.stringify({ type: "chatLine", username: "someone", text: "gl hf" });
    expect(parseLichessLine(line)).toBeNull();
  });

  it("returns null for an opponentGone event", () => {
    const line = JSON.stringify({ type: "opponentGone", gone: true });
    expect(parseLichessLine(line)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLichessLine("not json")).toBeNull();
  });

  it("returns null for a gameState line missing required fields", () => {
    expect(parseLichessLine(JSON.stringify({ type: "gameState" }))).toBeNull();
  });
});

describe("parseLichessOpponentGone", () => {
  it("parses gone=true with a claimWinInSeconds countdown", () => {
    const line = JSON.stringify({
      type: "opponentGone",
      gone: true,
      claimWinInSeconds: 30,
    });
    expect(parseLichessOpponentGone(line)).toEqual({
      gone: true,
      claimWinInSeconds: 30,
    });
  });

  it("parses gone=false as the opponent returning (claim clears)", () => {
    const line = JSON.stringify({ type: "opponentGone", gone: false });
    expect(parseLichessOpponentGone(line)).toEqual({
      gone: false,
      claimWinInSeconds: null,
    });
  });

  it("returns null claimWinInSeconds when the game type doesn't support claim (correspondence)", () => {
    const line = JSON.stringify({ type: "opponentGone", gone: true });
    expect(parseLichessOpponentGone(line)).toEqual({
      gone: true,
      claimWinInSeconds: null,
    });
  });

  it("returns null for non-opponentGone lines", () => {
    expect(
      parseLichessOpponentGone(JSON.stringify({ type: "gameState", moves: "", status: "started" })),
    ).toBeNull();
    expect(parseLichessOpponentGone("not json")).toBeNull();
  });
});

describe("isTerminalStatus", () => {
  it("treats in-progress statuses as non-terminal", () => {
    expect(isTerminalStatus("started")).toBe(false);
    expect(isTerminalStatus("created")).toBe(false);
  });

  it("treats every known ending as terminal", () => {
    expect(isTerminalStatus("mate")).toBe(true);
    expect(isTerminalStatus("resign")).toBe(true);
    expect(isTerminalStatus("draw")).toBe(true);
    expect(isTerminalStatus("outoftime")).toBe(true);
    expect(isTerminalStatus("aborted")).toBe(true);
  });
});

describe("parseLichessAccountEvent", () => {
  it("parses a full challenge event with challenger, variant, speed, rated, and time control", () => {
    const line = JSON.stringify({
      type: "challenge",
      challenge: {
        id: "abcd1234",
        challenger: { id: "alice", name: "Alice", title: null },
        destUser: { id: "mybot" },
        variant: { key: "standard" },
        speed: "blitz",
        rated: true,
        timeControl: { type: "clock", limit: 300, increment: 3 },
      },
    });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "challenge",
      challengeId: "abcd1234",
      challenger: { id: "alice", name: "Alice", title: null },
      destUser: { id: "mybot" },
      variant: "standard",
      speed: "blitz",
      rated: true,
      initialFen: null,
      timeControl: { type: "clock", limitSeconds: 300, incrementSeconds: 3, daysPerTurn: null },
    });
  });

  it("surfaces a custom starting FEN when present", () => {
    const line = JSON.stringify({
      type: "challenge",
      challenge: {
        id: "custfen00",
        variant: { key: "standard" },
        speed: "blitz",
        rated: false,
        initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        timeControl: { type: "clock", limit: 300, increment: 3 },
      },
    });
    const parsed = parseLichessAccountEvent(line);
    expect(parsed?.type).toBe("challenge");
    if (parsed?.type === "challenge") {
      expect(parsed.initialFen).toContain("rnbqkbnr");
    }
  });

  it("reads a chess960 variant as the non-standard string it is", () => {
    const line = JSON.stringify({
      type: "challenge",
      challenge: {
        id: "abcd1234",
        variant: { key: "chess960" },
        speed: "blitz",
        rated: false,
        timeControl: { type: "clock", limit: 180 },
      },
    });
    const parsed = parseLichessAccountEvent(line);
    expect(parsed?.type === "challenge" && parsed.variant).toBe("chess960");
  });

  it("parses a challengeCanceled event", () => {
    const line = JSON.stringify({
      type: "challengeCanceled",
      challenge: { id: "abcd1234" },
    });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "challengeCanceled",
      challengeId: "abcd1234",
    });
  });

  it("parses a challengeDeclined event, reading the reason from either field name", () => {
    // Lichess docs show `reason`; some accounts of the shape have used
    // `declineReason` -- both should be surfaced. challengerId / destUser
    // fields default to null when the payload doesn't carry them.
    expect(
      parseLichessAccountEvent(
        JSON.stringify({
          type: "challengeDeclined",
          challenge: { id: "abcd1234", reason: "variant" },
        }),
      ),
    ).toEqual({
      type: "challengeDeclined",
      challengeId: "abcd1234",
      reason: "variant",
      challengerId: null,
      destUserId: null,
      destUserName: null,
    });
    expect(
      parseLichessAccountEvent(
        JSON.stringify({
          type: "challengeDeclined",
          challenge: { id: "abcd1234", declineReason: "later" },
        }),
      ),
    ).toEqual({
      type: "challengeDeclined",
      challengeId: "abcd1234",
      reason: "later",
      challengerId: null,
      destUserId: null,
      destUserName: null,
    });
  });

  it("extracts challenger and destUser from a full challengeDeclined event", () => {
    // Shape for an *outgoing* decline (we challenged, they said no):
    // challenger is us, destUser is them. The LichessBotControls UI
    // uses this to display "maia1 declined: ..." and to filter maia1
    // out of the online-bots list for the session.
    const parsed = parseLichessAccountEvent(
      JSON.stringify({
        type: "challengeDeclined",
        challenge: {
          id: "abcd1234",
          reason: "noBot",
          challenger: { id: "jk-bot", name: "jk-bot" },
          destUser: { id: "maia1", name: "maia1" },
        },
      }),
    );
    expect(parsed).toEqual({
      type: "challengeDeclined",
      challengeId: "abcd1234",
      reason: "noBot",
      challengerId: "jk-bot",
      destUserId: "maia1",
      destUserName: "maia1",
    });
  });

  it("parses a gameFinish event", () => {
    const line = JSON.stringify({
      type: "gameFinish",
      game: { gameId: "abcd1234" },
    });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "gameFinish",
      gameId: "abcd1234",
    });
  });

  it("parses a gameStart event where the bot plays white", () => {
    const line = JSON.stringify({
      type: "gameStart",
      game: { gameId: "abcd1234", color: "white" },
    });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "gameStart",
      gameId: "abcd1234",
      botColor: "w",
    });
  });

  it("parses a gameStart event where the bot plays black", () => {
    const line = JSON.stringify({
      type: "gameStart",
      game: { gameId: "abcd1234", color: "black" },
    });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "gameStart",
      gameId: "abcd1234",
      botColor: "b",
    });
  });

  it("falls back to the game's id field when gameId is absent", () => {
    const line = JSON.stringify({
      type: "gameStart",
      game: { id: "abcd1234", color: "white" },
    });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "gameStart",
      gameId: "abcd1234",
      botColor: "w",
    });
  });

  it("returns null for a gameStart event with a missing or malformed color, rather than defaulting", () => {
    expect(
      parseLichessAccountEvent(
        JSON.stringify({ type: "gameStart", game: { gameId: "abcd1234" } }),
      ),
    ).toBeNull();
    expect(
      parseLichessAccountEvent(
        JSON.stringify({ type: "gameStart", game: { gameId: "abcd1234", color: "purple" } }),
      ),
    ).toBeNull();
  });

  it("returns null for a challenge event with no id", () => {
    expect(
      parseLichessAccountEvent(JSON.stringify({ type: "challenge", challenge: {} })),
    ).toBeNull();
  });

  it("returns null for an unrecognized event type", () => {
    expect(parseLichessAccountEvent(JSON.stringify({ type: "someFutureEvent" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLichessAccountEvent("not json")).toBeNull();
  });
});

describe("decideChallenge", () => {
  const CTX_DEFAULT: ChallengeDecisionContext = {
    myAccountId: "mybot",
    acceptRated: false,
    activeGameId: null,
  };

  function baseChallenge(overrides: Partial<LichessChallengeEvent> = {}): LichessChallengeEvent {
    return {
      type: "challenge",
      challengeId: "abcd1234",
      challenger: { id: "alice", name: "Alice", title: null },
      destUser: { id: "mybot" },
      variant: "standard",
      speed: "blitz",
      rated: false,
      initialFen: null,
      timeControl: { type: "clock", limitSeconds: 300, incrementSeconds: 3, daysPerTurn: null },
      ...overrides,
    };
  }

  it("accepts a plain standard casual blitz challenge from someone else", () => {
    expect(decideChallenge(baseChallenge(), CTX_DEFAULT)).toEqual({ kind: "accept" });
  });

  it("drops a self-challenge instead of trying to decline it (Lichess 400s a self-decline)", () => {
    const decision = decideChallenge(
      baseChallenge({ challenger: { id: "mybot", name: "MyBot", title: "BOT" } }),
      CTX_DEFAULT,
    );
    expect(decision).toEqual({ kind: "drop", because: "self-challenge" });
  });

  it("declines a challenge whose destUser is not us with reason 'generic'", () => {
    const decision = decideChallenge(
      baseChallenge({ destUser: { id: "someone-else" } }),
      CTX_DEFAULT,
    );
    expect(decision).toEqual({ kind: "decline", reason: "generic" });
  });

  it("accepts an open challenge (no destUser) that is otherwise fine", () => {
    expect(decideChallenge(baseChallenge({ destUser: null }), CTX_DEFAULT)).toEqual({
      kind: "accept",
    });
  });

  it("accepts a chess960 challenge now that the engine's UCI_Chess960 output path is wired", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "chess960" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("rulesFromLichessVariant maps Lichess variant keys to internal Rules", () => {
    expect(rulesFromLichessVariant("standard")).toBe("chess");
    expect(rulesFromLichessVariant("chess960")).toBe("chess960");
    expect(rulesFromLichessVariant("kingOfTheHill")).toBe("koth");
    expect(rulesFromLichessVariant("threeCheck")).toBe("3check");
    expect(rulesFromLichessVariant("horde")).toBe("horde");
    expect(rulesFromLichessVariant("racingKings")).toBe("racingkings");
    expect(rulesFromLichessVariant("atomic")).toBe("atomic");
    expect(rulesFromLichessVariant("antichess")).toBe("antichess");
    expect(rulesFromLichessVariant(null)).toBe("chess");
    expect(rulesFromLichessVariant("crazyhouse")).toBe("chess");  // unknown collapses
  });

  it("accepts a King of the Hill challenge now that UCI_Variant is wired", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "kingOfTheHill" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("accepts a Three-check challenge now that UCI_Variant handles threeCheck", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "threeCheck" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("accepts a Horde challenge now that engine-side Horde support is wired", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "horde" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("accepts a Racing Kings challenge now that engine-side RK support is wired", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "racingKings" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("accepts an Atomic challenge now that engine-side Atomic support is wired", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "atomic" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("accepts an Antichess challenge now that engine-side Antichess support is wired", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "antichess" }), CTX_DEFAULT),
    ).toEqual({ kind: "accept" });
  });

  it("still declines variants that have no engine support yet (crazyhouse)", () => {
    expect(
      decideChallenge(baseChallenge({ variant: "crazyhouse" }), CTX_DEFAULT),
    ).toEqual({ kind: "decline", reason: "variant" });
  });

  it("accepts a custom-starting-position (From Position) challenge now that startFen is plumbed", () => {
    // Pre-PR-1 we declined these with reason 'generic'; the engine
    // supports arbitrary `position fen` and gameStore plumbs startFen
    // through, so a non-null initialFen is no longer a refusal signal.
    expect(
      decideChallenge(
        baseChallenge({ initialFen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4" }),
        CTX_DEFAULT,
      ),
    ).toEqual({ kind: "accept" });
  });

  it("accepts a correspondence challenge: engine falls back to movetime, human just plays when ready", () => {
    expect(
      decideChallenge(
        baseChallenge({
          speed: "correspondence",
          timeControl: {
            type: "correspondence",
            limitSeconds: null,
            incrementSeconds: null,
            daysPerTurn: 2,
          },
        }),
        CTX_DEFAULT,
      ),
    ).toEqual({ kind: "accept" });
  });

  it("declines a rated challenge with reason 'rated' when the operator hasn't opted in", () => {
    expect(
      decideChallenge(baseChallenge({ rated: true }), CTX_DEFAULT),
    ).toEqual({ kind: "decline", reason: "rated" });
  });

  it("accepts a rated challenge once the operator has opted in", () => {
    expect(
      decideChallenge(baseChallenge({ rated: true }), { ...CTX_DEFAULT, acceptRated: true }),
    ).toEqual({ kind: "accept" });
  });

  it("declines a challenge with reason 'later' when a game is already in progress", () => {
    expect(
      decideChallenge(baseChallenge(), { ...CTX_DEFAULT, activeGameId: "otherGame" }),
    ).toEqual({ kind: "decline", reason: "later" });
  });

  it("safety branch order: a self-challenge drops even if it's also for a wrong destUser or rated", () => {
    // Self-branch runs first so the operator sees the accurate reason
    // in the debug log, not a downstream policy branch that hides it.
    const decision = decideChallenge(
      baseChallenge({
        challenger: { id: "mybot", name: "MyBot", title: "BOT" },
        destUser: { id: "someone-else" },
        rated: true,
      }),
      CTX_DEFAULT,
    );
    expect(decision.kind).toBe("drop");
  });
});

describe("parseBotOnlineList", () => {
  it("parses each NDJSON line into a bot summary", () => {
    const raw = [
      JSON.stringify({
        username: "maia1",
        title: "BOT",
        perfs: { bullet: { rating: 1669 }, blitz: { rating: 1378 } },
      }),
      JSON.stringify({ username: "maia5", title: "BOT", perfs: { rapid: { rating: 1726 } } }),
    ].join("\n");

    expect(parseBotOnlineList(raw)).toEqual([
      { username: "maia1", title: "BOT", ratings: { bullet: 1669, blitz: 1378 } },
      { username: "maia5", title: "BOT", ratings: { rapid: 1726 } },
    ]);
  });

  it("defaults title to null and ratings to empty when absent", () => {
    const raw = JSON.stringify({ username: "somebot" });
    expect(parseBotOnlineList(raw)).toEqual([
      { username: "somebot", title: null, ratings: {} },
    ]);
  });

  it("skips blank lines and malformed entries without dropping the rest", () => {
    const raw = [
      JSON.stringify({ username: "good1" }),
      "",
      "not json",
      JSON.stringify({ noUsername: true }),
      JSON.stringify({ username: "good2" }),
    ].join("\n");

    expect(parseBotOnlineList(raw).map((b) => b.username)).toEqual(["good1", "good2"]);
  });

  it("returns an empty list for an empty body", () => {
    expect(parseBotOnlineList("")).toEqual([]);
  });
});
