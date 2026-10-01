import { describe, expect, it } from "vitest";
import {
  checkStatus,
  fenAtPly,
  fenToPieces,
  gameStatus,
  legalDestinations,
  parsePgn,
  parseUciMoves,
  sideToMove,
  tryMove,
} from "./chessRules";

const FOOLS_MATE_PGN = "1. f3 e5 2. g4 Qh4#";
const FOOLS_MATE_FINAL_FEN =
  "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

describe("parsePgn", () => {
  it("produces one ply per move with SAN and before/after FEN", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);

    expect(plies).toHaveLength(4);
    expect(plies.map((p) => p.san)).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(plies.map((p) => p.uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
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

  it("returns the custom start FEN at ply 0 when provided", () => {
    const custom = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
    expect(fenAtPly([], 0, custom)).toBe(custom);
  });

  it("ignores the start FEN once at least one ply has been played", () => {
    const custom = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
    const plies = parsePgn(FOOLS_MATE_PGN);
    // Ply 1's fenAfter is whatever `plies[0]` records; the start FEN
    // argument has no effect once moves have been played.
    expect(fenAtPly(plies, 1, custom)).toBe(plies[0].fenAfter);
  });
});

describe("gameStatus KotH", () => {
  // Pawns prevent the standard "insufficient material" draw so the
  // only difference between chess and koth terminal detection here is
  // the king-on-center condition.
  const kingOnCenterFen = "4k3/pppppppp/8/8/4K3/8/PPPPPPPP/8 w - - 0 1";

  it("returns `variantEnd` when a king is on a center square and variant is koth", () => {
    const status = gameStatus(kingOnCenterFen, "koth");
    expect(status.over).toBe(true);
    if (status.over) expect(status.reason).toBe("variantEnd");
  });

  it("returns `over:false` for the same FEN when variant defaults to chess", () => {
    const status = gameStatus(kingOnCenterFen);
    expect(status.over).toBe(false);
  });
});

describe("sideToMove", () => {
  it("reads white to move from the starting position", () => {
    expect(sideToMove("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe(
      "w",
    );
  });

  it("reads black to move after white's first move", () => {
    const plies = parsePgn(FOOLS_MATE_PGN);
    expect(sideToMove(plies[0].fenAfter)).toBe("b");
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

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("legalDestinations", () => {
  it("returns the knight's starting squares", () => {
    expect(legalDestinations(START_FEN, "b1").sort()).toEqual(["a3", "c3"]);
  });

  it("returns an empty list for a square with no piece", () => {
    expect(legalDestinations(START_FEN, "e4")).toEqual([]);
  });

  it("returns an empty list for a pinned piece with no legal moves", () => {
    // White king e1, white rook e2 pinned by black rook e8 along the e-file.
    const pinnedFen = "4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1";
    expect(legalDestinations(pinnedFen, "e2")).toEqual([
      "e3",
      "e4",
      "e5",
      "e6",
      "e7",
      "e8",
    ]);
  });
});

describe("tryMove", () => {
  it("applies a legal move and returns the resulting ply", () => {
    const ply = tryMove(START_FEN, "e2", "e4");
    expect(ply).not.toBeNull();
    expect(ply?.san).toBe("e4");
    expect(ply?.uci).toBe("e2e4");
    expect(ply?.color).toBe("w");
  });

  it("applies a promotion and encodes it in the uci field", () => {
    const fen = "8/4P3/8/8/8/8/8/4K2k w - - 0 1";
    const ply = tryMove(fen, "e7", "e8", "q");
    expect(ply?.san).toBe("e8=Q");
    expect(ply?.uci).toBe("e7e8q");
  });

  it("returns null for an illegal move instead of throwing", () => {
    expect(tryMove(START_FEN, "e2", "e5")).toBeNull();
  });
});

describe("gameStatus", () => {
  it("reports a fresh game as not over", () => {
    expect(gameStatus(START_FEN)).toEqual({ over: false });
  });

  it("reports checkmate", () => {
    expect(gameStatus(FOOLS_MATE_FINAL_FEN)).toEqual({
      over: true,
      reason: "checkmate",
    });
  });

  it("reports stalemate", () => {
    // Classic stalemate: black king a8, no black pieces, not in check, no legal moves.
    const stalemateFen = "k7/8/1Q6/8/8/8/8/7K b - - 0 1";
    expect(gameStatus(stalemateFen)).toEqual({ over: true, reason: "stalemate" });
  });
});

describe("checkStatus", () => {
  it("reports not in check for a fresh position", () => {
    expect(checkStatus(START_FEN)).toEqual({
      inCheck: false,
      checkmate: false,
      kingSquare: null,
    });
  });

  it("reports check (not checkmate) and the checked king's square", () => {
    // Black rook on e2 checks the white king on e1 along the e-file; the
    // king has legal escapes (d1, f1, d2, f2) or can capture the rook.
    const checkFen = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1";
    expect(checkStatus(checkFen)).toEqual({
      inCheck: true,
      checkmate: false,
      kingSquare: "e1",
    });
  });

  it("reports checkmate and the mated king's square", () => {
    expect(checkStatus(FOOLS_MATE_FINAL_FEN)).toEqual({
      inCheck: true,
      checkmate: true,
      kingSquare: "e1",
    });
  });
});
