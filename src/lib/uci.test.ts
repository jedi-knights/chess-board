import { describe, expect, it } from "vitest";
import {
  appendSearchInfo,
  buildGoCommand,
  buildPositionCommand,
  buildSetOptionCommand,
  parseUciLine,
  upsertOption,
  type UciInfo,
  type UciOption,
} from "./uci";

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

  it("parses chess-engine's actual check-type option line", () => {
    expect(parseUciLine("option name UseNNUE type check default false")).toEqual({
      type: "option",
      name: "UseNNUE",
      optionType: "check",
      default: "false",
      min: undefined,
      max: undefined,
      vars: undefined,
    });
  });

  it("parses chess-engine's actual string-type option line", () => {
    expect(parseUciLine("option name EvalFile type string default <empty>")).toEqual({
      type: "option",
      name: "EvalFile",
      optionType: "string",
      default: "<empty>",
      min: undefined,
      max: undefined,
      vars: undefined,
    });
  });

  it("parses a spin-type option with min/max", () => {
    expect(parseUciLine("option name Threads type spin default 1 min 1 max 512")).toEqual({
      type: "option",
      name: "Threads",
      optionType: "spin",
      default: "1",
      min: 1,
      max: 512,
      vars: undefined,
    });
  });

  it("parses a combo-type option with repeated var entries", () => {
    expect(
      parseUciLine("option name Style type combo default Normal var Solid var Normal var Risky"),
    ).toEqual({
      type: "option",
      name: "Style",
      optionType: "combo",
      default: "Normal",
      min: undefined,
      max: undefined,
      vars: ["Solid", "Normal", "Risky"],
    });
  });

  it("parses a button-type option with no default", () => {
    expect(parseUciLine("option name Clear Hash type button")).toEqual({
      type: "option",
      name: "Clear Hash",
      optionType: "button",
      default: undefined,
      min: undefined,
      max: undefined,
      vars: undefined,
    });
  });

  it("falls back to unknown for a malformed option line instead of throwing", () => {
    expect(parseUciLine("option type check")).toEqual({
      type: "unknown",
      raw: "option type check",
    });
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

  it("builds the fen form with no moves when a custom start FEN is supplied", () => {
    const fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
    expect(buildPositionCommand([], fen)).toBe(`position fen ${fen}`);
  });

  it("builds the fen form with moves", () => {
    const fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
    expect(buildPositionCommand(["b1c3"], fen)).toBe(`position fen ${fen} moves b1c3`);
  });
});

describe("buildGoCommand", () => {
  it("builds a movetime-only command", () => {
    expect(buildGoCommand({ movetimeMs: 1000 })).toBe("go movetime 1000");
  });

  it("builds a clock-only command with wtime/btime/winc/binc in a stable order", () => {
    // Order in the output matters for readable debug logs and comparable
    // tests -- fixed at wtime -> btime -> winc -> binc -> movetime.
    expect(
      buildGoCommand({ wtimeMs: 60000, btimeMs: 58000, wincMs: 2000, bincMs: 2000 }),
    ).toBe("go wtime 60000 btime 58000 winc 2000 binc 2000");
  });

  it("builds a clock command with movetime included as a cap", () => {
    // Bot mode's go: engine allocates on clock but never exceeds movetime.
    expect(
      buildGoCommand({
        wtimeMs: 60000,
        btimeMs: 58000,
        wincMs: 2000,
        bincMs: 2000,
        movetimeMs: 5000,
      }),
    ).toBe("go wtime 60000 btime 58000 winc 2000 binc 2000 movetime 5000");
  });

  it("omits fields that are undefined rather than emitting `undefined`", () => {
    expect(buildGoCommand({ wtimeMs: 60000, btimeMs: 58000 })).toBe(
      "go wtime 60000 btime 58000",
    );
  });

  it("rejects an empty options object rather than emitting bare `go`", () => {
    // A bare `go` makes the engine think until told otherwise -- never
    // what any caller here wants; failing loudly is safer.
    expect(() => buildGoCommand({})).toThrow(/at least one/);
  });
});

describe("buildSetOptionCommand", () => {
  it("builds a setoption command with a value", () => {
    expect(buildSetOptionCommand("UseNNUE", "true")).toBe(
      "setoption name UseNNUE value true",
    );
  });

  it("builds a valueless setoption command for a button-type option", () => {
    expect(buildSetOptionCommand("Clear Hash")).toBe("setoption name Clear Hash");
  });
});

describe("appendSearchInfo", () => {
  const info = (depth: number): UciInfo => ({ type: "info", depth });

  it("appends to an empty history", () => {
    expect(appendSearchInfo([], info(1))).toEqual([info(1)]);
  });

  it("appends onto existing history in order", () => {
    expect(appendSearchInfo([info(1)], info(2))).toEqual([info(1), info(2)]);
  });

  it("caps history length so a misbehaving engine can't grow it unbounded", () => {
    let history: UciInfo[] = [];
    for (let depth = 1; depth <= 100; depth++) {
      history = appendSearchInfo(history, info(depth));
    }
    expect(history).toHaveLength(64);
    // Oldest entries are dropped first -- the most recent depths survive.
    expect(history[0].depth).toBe(37);
    expect(history[63].depth).toBe(100);
  });
});

describe("upsertOption", () => {
  const option = (name: string, def: string): UciOption => ({
    type: "option",
    name,
    optionType: "check",
    default: def,
    min: undefined,
    max: undefined,
    vars: undefined,
  });

  it("adds a new option by name", () => {
    expect(upsertOption([], option("UseNNUE", "false"))).toEqual([
      option("UseNNUE", "false"),
    ]);
  });

  it("replaces an existing option with the same name instead of duplicating it", () => {
    const initial = [option("UseNNUE", "false"), option("EvalFile", "<empty>")];
    const updated = upsertOption(initial, option("UseNNUE", "true"));
    expect(updated).toEqual([option("UseNNUE", "true"), option("EvalFile", "<empty>")]);
  });
});
