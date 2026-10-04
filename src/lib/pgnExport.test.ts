import { describe, expect, it } from "vitest";
import type { Ply } from "./chessRules";
import { buildPgn } from "./pgnExport";

/** Shorthand to build a Ply with just the fields buildPgn reads. */
function ply(san: string, color: "w" | "b", uci = "0000"): Ply {
  return {
    san,
    uci,
    fenBefore: "",
    fenAfter: "",
    color,
  };
}

const STD_HEADERS = {
  Event: "Casual game",
  Site: "https://lichess.org/abcd1234",
  Date: "2026.10.04",
  Round: "-",
  White: "jk-bot",
  Black: "StockfishBot",
  Result: "1-0",
};

describe("buildPgn", () => {
  it("emits the seven-tag roster in spec order followed by a blank line and the movetext", () => {
    const pgn = buildPgn([ply("e4", "w"), ply("e5", "b"), ply("Nf3", "w")], STD_HEADERS);
    const lines = pgn.split("\n");
    expect(lines[0]).toBe('[Event "Casual game"]');
    expect(lines[1]).toBe('[Site "https://lichess.org/abcd1234"]');
    expect(lines[2]).toBe('[Date "2026.10.04"]');
    expect(lines[3]).toBe('[Round "-"]');
    expect(lines[4]).toBe('[White "jk-bot"]');
    expect(lines[5]).toBe('[Black "StockfishBot"]');
    expect(lines[6]).toBe('[Result "1-0"]');
    expect(lines[7]).toBe("");
    expect(lines[8]).toBe("1. e4 e5 2. Nf3 1-0");
    // Trailing newline for well-formed text file semantics.
    expect(pgn.endsWith("\n")).toBe(true);
  });

  it("appends the optional tags we populate after the required ones", () => {
    const pgn = buildPgn([ply("e4", "w")], {
      ...STD_HEADERS,
      WhiteTitle: "BOT",
      BlackTitle: "BOT",
      Variant: "Standard",
      TimeControl: "300+3",
    });
    expect(pgn).toContain('[WhiteTitle "BOT"]');
    expect(pgn).toContain('[BlackTitle "BOT"]');
    expect(pgn).toContain('[Variant "Standard"]');
    expect(pgn).toContain('[TimeControl "300+3"]');
    // Tag section still precedes the movetext (blank line separator).
    const lines = pgn.split("\n");
    const blankIdx = lines.findIndex((l) => l === "");
    expect(lines[blankIdx + 1]).toBe("1. e4 1-0");
  });

  it("escapes embedded quotes and backslashes in header values per PGN spec", () => {
    const pgn = buildPgn([ply("e4", "w")], {
      ...STD_HEADERS,
      White: 'Al "The Beast" \\knight',
    });
    expect(pgn).toContain('[White "Al \\"The Beast\\" \\\\knight"]');
  });

  it("terminates the movetext with the Result token even for an empty move list", () => {
    const pgn = buildPgn([], { ...STD_HEADERS, Result: "1/2-1/2" });
    const lines = pgn.split("\n");
    const blankIdx = lines.findIndex((l) => l === "");
    expect(lines[blankIdx + 1]).toBe("1/2-1/2");
  });

  it("emits SetUp + FEN tags when a non-standard start FEN is provided", () => {
    const customFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const pgn = buildPgn([ply("e5", "b")], STD_HEADERS, customFen);
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain(`[FEN "${customFen}"]`);
  });

  it("omits SetUp + FEN when the start FEN is standard", () => {
    const pgn = buildPgn([ply("e4", "w")], STD_HEADERS);
    expect(pgn).not.toContain("[SetUp ");
    expect(pgn).not.toContain("[FEN ");
  });

  it("renders a Black-first game with the <N>... prefix per PGN convention", () => {
    // Full-move number 7, Black to move (hypothetical mid-game FEN).
    const blackToMoveMid = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 7";
    const pgn = buildPgn(
      [ply("c5", "b"), ply("Nf3", "w"), ply("Nc6", "b")],
      STD_HEADERS,
      blackToMoveMid,
    );
    const lines = pgn.split("\n");
    const blankIdx = lines.findIndex((l) => l === "");
    expect(lines[blankIdx + 1]).toBe("7... c5 8. Nf3 Nc6 1-0");
  });

  it("renders a standard-start White-first game with normal numbering", () => {
    const pgn = buildPgn(
      [ply("e4", "w"), ply("e5", "b"), ply("Nf3", "w"), ply("Nc6", "b"), ply("Bb5", "w")],
      STD_HEADERS,
    );
    const lines = pgn.split("\n");
    const blankIdx = lines.findIndex((l) => l === "");
    expect(lines[blankIdx + 1]).toBe("1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0");
  });
});
