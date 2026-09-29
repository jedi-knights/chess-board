import { describe, expect, it } from "vitest";
import {
  isTerminalStatus,
  parseBotOnlineList,
  parseLichessAccountEvent,
  parseLichessLine,
} from "./lichess";

describe("parseLichessLine", () => {
  it("parses a gameFull line via its nested state", () => {
    const line = JSON.stringify({
      type: "gameFull",
      id: "abcd1234",
      state: { type: "gameState", moves: "e2e4 e7e5", status: "started" },
    });
    expect(parseLichessLine(line)).toEqual({ moves: ["e2e4", "e7e5"], status: "started" });
  });

  it("parses a gameState line", () => {
    const line = JSON.stringify({ type: "gameState", moves: "e2e4 e7e5 g1f3", status: "started" });
    expect(parseLichessLine(line)).toEqual({
      moves: ["e2e4", "e7e5", "g1f3"],
      status: "started",
    });
  });

  it("parses an empty move list as the start of a game", () => {
    const line = JSON.stringify({ type: "gameState", moves: "", status: "started" });
    expect(parseLichessLine(line)).toEqual({ moves: [], status: "started" });
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
  it("parses a challenge event", () => {
    const line = JSON.stringify({ type: "challenge", challenge: { id: "abcd1234" } });
    expect(parseLichessAccountEvent(line)).toEqual({
      type: "challenge",
      challengeId: "abcd1234",
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
    expect(parseLichessAccountEvent(JSON.stringify({ type: "challengeDeclined" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLichessAccountEvent("not json")).toBeNull();
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
