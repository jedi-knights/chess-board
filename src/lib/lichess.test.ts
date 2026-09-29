import { describe, expect, it } from "vitest";
import { isTerminalStatus, parseLichessLine } from "./lichess";

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
