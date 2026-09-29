import { describe, expect, it } from "vitest";
import { fenAtPly, fenToPieces, parsePgn, parseUciMoves } from "./chessRules";

const FOOLS_MATE_PGN = "1. f3 e5 2. g4 Qh4#";
const FOOLS_MATE_FINAL_FEN =
  "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

describe("parsePgn", () => {
  it("produces one ply per move with SAN and before/after FEN", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);

    expect(plies).toHaveLength(4);
    expect(plies.map((p) => p.san)).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(plies[0].fenBefore).toContain(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w",
    );
  });

  it("round-trips to the PGN's own terminal position", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);
    expect(plies[plies.length - 1].fenAfter).toBe(FOOLS_MATE_FINAL_FEN);
  });

  it("rejects an empty PGN", () => {
    expect(() => parsePgn("   ")).toThrow();
  });

  it("rejects a PGN with no moves", () => {
    expect(() => parsePgn('[Event "empty"]')).toThrow();
  });
});

describe("parseUciMoves", () => {
  it("matches parsePgn's result for the same game expressed as UCI moves", () => {
    const fromUci = parseUciMoves("f2f3 e7e5 g2g4 d8h4");
    const fromPgn = parsePgn(FOOLS_MATE_PGN);

    expect(fromUci.map((p) => p.fenAfter)).toEqual(
      fromPgn.map((p) => p.fenAfter),
    );
  });

  it("rejects an illegal move", () => {
    expect(() => parseUciMoves("e2e5")).toThrow(/illegal move/i);
  });
});

describe("fenAtPly", () => {
  it("returns the standard start position at ply 0", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);
    expect(fenAtPly(plies, 0)).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
  });

  it("returns each ply's resulting position", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);
    expect(fenAtPly(plies, 1)).toBe(plies[0].fenAfter);
    expect(fenAtPly(plies, plies.length)).toBe(FOOLS_MATE_FINAL_FEN);
  });

  it("clamps a ply index beyond the game length to the final position", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);
    expect(fenAtPly(plies, 999)).toBe(FOOLS_MATE_FINAL_FEN);
  });
});

describe("parsePgn clock/think-time parsing", () => {
  const PGN_WITH_CLOCKS =
    '[Event "Test"]\n[TimeControl "180+2"]\n\n' +
    "1. e4 {[%clk 0:03:00]} 1... e5 {[%clk 0:02:58]} " +
    "2. Nf3 {[%clk 0:02:55]} 2... Nc6 {[%clk 0:02:54]} *";

  it("derives think time from consecutive %clk readings using base + increment", () => {
    const plies = parsePgn(PGN_WITH_CLOCKS);
    expect(plies[0].clockSeconds).toBe(180);
    expect(plies[0].thinkTimeSeconds).toBe(2); // 180 (base) + 2 (inc) - 180
    expect(plies[1].thinkTimeSeconds).toBe(4); // 180 (base) + 2 (inc) - 178
    expect(plies[2].thinkTimeSeconds).toBe(7); // 180 (white's prior clk) + 2 - 175
  });

  it("prefers %emt (direct elapsed time) over %clk diffing", () => {
    const plies = parsePgn("1. e4 {[%emt 0:00:05]} e5 *");
    expect(plies[0].thinkTimeSeconds).toBe(5);
  });

  it("leaves thinkTimeSeconds undefined when the PGN has no clock annotations", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);
    expect(plies.every((p) => p.thinkTimeSeconds === undefined)).toBe(true);
  });

  it("leaves timing fields undefined for a bare UCI move list (no timing concept)", () => {
    const plies = parseUciMoves("f2f3 e7e5 g2g4 d8h4");
    expect(plies.every((p) => p.thinkTimeSeconds === undefined && p.clockSeconds === undefined)).toBe(
      true,
    );
  });
});

describe("fenToPieces", () => {
  it("returns all 32 pieces on the starting position", () => {
    const pieces = fenToPieces(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    expect(pieces).toHaveLength(32);
    expect(pieces).toContainEqual({ square: "e1", type: "k", color: "w" });
    expect(pieces).toContainEqual({ square: "d8", type: "q", color: "b" });
  });

  it("reflects a mid-game FEN's exact occupancy", () => {
    const pieces = fenToPieces(FOOLS_MATE_FINAL_FEN);
    expect(pieces).toContainEqual({ square: "h4", type: "q", color: "b" });
    expect(pieces.some((p) => p.square === "e5" && p.type === "p")).toBe(true);
  });
});
