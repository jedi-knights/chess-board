import { describe, expect, it } from "vitest";
import { buildGoCommand, buildPositionCommand, parseUciLine } from "./uci";

describe("parseUciLine", () => {
  it("parses bestmove without ponder", () => {
    expect(parseUciLine("bestmove e2e4")).toEqual({
      type: "bestmove",
      move: "e2e4",
      ponder: undefined,
    });
  });

  it("parses bestmove with ponder", () => {
    expect(parseUciLine("bestmove e2e4 ponder e7e5")).toEqual({
      type: "bestmove",
      move: "e2e4",
      ponder: "e7e5",
    });
  });

  it("parses uciok and readyok", () => {
    expect(parseUciLine("uciok")).toEqual({ type: "uciok" });
    expect(parseUciLine("readyok")).toEqual({ type: "readyok" });
  });

  it("parses an id line", () => {
    expect(parseUciLine("id name jedi-engine 0.0.1")).toEqual({
      type: "id",
      key: "name",
      value: "jedi-engine 0.0.1",
    });
  });

  it("parses a full info line with a PV, matching chess-engine's actual output shape", () => {
    const line =
      "info depth 10 score cp 34 nodes 301533 nps 11168000 time 27 pv e2e4 e7e5 g1f3";
    expect(parseUciLine(line)).toEqual({
      type: "info",
      depth: 10,
      scoreCp: 34,
      scoreMate: undefined,
      nodes: 301533,
      nps: 11168000,
      time: 27,
      pv: ["e2e4", "e7e5", "g1f3"],
    });
  });

  it("parses a mate-score info line", () => {
    const line = "info depth 5 score mate 3 nodes 1200 pv d1h5";
    const parsed = parseUciLine(line);
    expect(parsed).toMatchObject({ type: "info", scoreMate: 3, scoreCp: undefined });
  });

  it("falls back to unknown for unrecognized/vendor chatter instead of throwing", () => {
    expect(parseUciLine("info string EvalFile loaded: nets/default.jnn1")).toEqual({
      type: "info",
      depth: undefined,
      scoreCp: undefined,
      scoreMate: undefined,
      nodes: undefined,
      nps: undefined,
      time: undefined,
      pv: undefined,
    });
    expect(parseUciLine("totally-unrecognized-line 123")).toEqual({
      type: "unknown",
      raw: "totally-unrecognized-line 123",
    });
  });
});

describe("buildPositionCommand", () => {
  it("builds the startpos form with no moves", () => {
    expect(buildPositionCommand([])).toBe("position startpos");
  });

  it("builds the moves form", () => {
    expect(buildPositionCommand(["e2e4", "e7e5"])).toBe(
      "position startpos moves e2e4 e7e5",
    );
  });
});

describe("buildGoCommand", () => {
  it("builds a movetime command", () => {
    expect(buildGoCommand(1000)).toBe("go movetime 1000");
  });
});
