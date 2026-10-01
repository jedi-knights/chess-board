import { Chess } from "chessops/chess";
import { KingOfTheHill } from "chessops/variant";
import { parseFen, makeFen } from "chessops/fen";
import { parsePgn as parseChessopsPgn, parseComment } from "chessops/pgn";
import { parseSan, makeSanAndPlay } from "chessops/san";
import { makeSquare, parseSquare, parseUci, makeUci } from "chessops/util";
import type { Color, Move, NormalMove, Piece, Role, Square } from "chessops/types";
import { SquareSet } from "chessops/squareSet";

/**
 * Centralized chess-rules seam. Nothing else in the codebase imports
 * `chessops` directly -- route every FEN/SAN/UCI question through here
 * so there is exactly one place to touch when adding a variant.
 *
 * This module was ported from `chess.js` to `chessops` so that Lichess
 * variants (Chess960, Antichess, Atomic, Three-check, KotH, Horde,
 * Racing Kings, Crazyhouse) can be threaded through later. For now the
 * public surface is standard-chess-only and behaviorally identical to
 * the pre-port version -- variant threading lands in each variant PR.
 */

export interface Ply {
  san: string;
  /** UCI notation for this move, e.g. "e2e4" or "e7e8q" for a promotion. */
  uci: string;
  fenBefore: string;
  fenAfter: string;
  color: "w" | "b";
  /**
   * Seconds spent choosing this move, when derivable from the source PGN's
   * `%emt` (elapsed move time) or `%clk` (remaining clock) annotations --
   * both are conventions used by lichess/chess.com/ICC exports, not part
   * of the core PGN spec. `undefined` when the PGN carries no clock data
   * (e.g. a hand-typed game) or the game was loaded from a bare UCI move
   * list, which has no timing concept at all.
   */
  thinkTimeSeconds?: number;
  /** Remaining clock time after this move, when a `%clk` annotation is present. */
  clockSeconds?: number;
}

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const ROLE_TO_LETTER: Record<Role, "p" | "n" | "b" | "r" | "q" | "k"> = {
  pawn: "p",
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
  king: "k",
};

const PROMOTION_LETTER_TO_ROLE: Record<string, Role> = {
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
};

const colorChar = (color: Color): "w" | "b" => (color === "white" ? "w" : "b");

/** Variant / rule set that affects terminal detection. Mirrors
 * gameStore's `Rules` union; kept here as a string so this module stays
 * independent of state-layer imports. Standard chess and Chess960
 * share movegen + terminals ("chess" is the shared default); KotH
 * adds the center-square win condition via chessops' KingOfTheHill
 * class. Future variants (threeCheck, antichess, etc.) extend this. */
export type Variant = "chess" | "chess960" | "koth";

/** Position loader shared by every function below -- `parseFen` returns
 * a `Result`, so a malformed FEN surfaces as `null` here rather than an
 * exception. The caller decides what "FEN was bad" means (return null,
 * fall through to no-op, etc.).
 *
 * For KotH, chessops' `KingOfTheHill` class extends `Chess` and
 * overrides `isVariantEnd()` to return true when a king is on
 * D4/D5/E4/E5. All callers whose return value depends on terminal
 * detection must pass `variant` so the right class is selected. Callers
 * that only read moves / piece positions can use the default
 * (`variant === "chess"`) since movegen rules are identical. */
function loadPosition(fen: string, variant: Variant = "chess"): Chess | null {
  const setupRes = parseFen(fen);
  if (!setupRes.isOk) return null;
  const setup = setupRes.unwrap();
  const posRes = variant === "koth"
    ? KingOfTheHill.fromSetup(setup)
    : Chess.fromSetup(setup);
  return posRes.isOk ? posRes.unwrap() : null;
}

function moveToUci(move: Move): string {
  return makeUci(move);
}

function moveColorChar(pos: Chess): "w" | "b" {
  // The position before `pos.play(move)` holds the mover's color.
  return colorChar(pos.turn);
}

/**
 * Parses a PGN string into a flat ply list, each carrying the FEN
 * immediately before and after the move so the board can jump to any
 * ply without replaying from the start every time.
 */
export function parsePgn(pgn: string): Ply[] {
  const trimmed = pgn.trim();
  if (!trimmed) {
    throw new Error("PGN is empty");
  }

  const games = parseChessopsPgn(trimmed);
  if (games.length === 0 || games[0].moves.children.length === 0) {
    throw new Error("PGN contained no moves");
  }

  const game = games[0];
  // "From Position" PGNs carry a FEN header; standard games don't.
  const fenHeader = game.headers.get("FEN");
  const startFen = fenHeader ?? START_FEN;
  const pos = loadPosition(startFen);
  if (!pos) {
    throw new Error("PGN carried an invalid FEN header");
  }

  const { base, increment } = parseTimeControl(game.headers.get("TimeControl"));
  const lastClockByColor: Partial<Record<"w" | "b", number>> = {};

  const plies: Ply[] = [];
  let node = game.moves;
  while (node.children.length > 0) {
    const next = node.children[0];
    const move = parseSan(pos, next.data.san);
    if (!move) {
      throw new Error(`PGN contained an illegal move "${next.data.san}"`);
    }
    const fenBefore = makeFen(pos.toSetup());
    const color = moveColorChar(pos);
    const san = makeSanAndPlay(pos, move);
    const fenAfter = makeFen(pos.toSetup());

    const comments = (next.data.comments ?? []).map(parseComment);
    const clockSeconds = comments.find((c) => c.clock !== undefined)?.clock;
    const emtSeconds = comments.find((c) => c.emt !== undefined)?.emt;

    let thinkTimeSeconds: number | undefined = emtSeconds;
    if (thinkTimeSeconds === undefined && clockSeconds !== undefined) {
      const previous = lastClockByColor[color] ?? base;
      if (previous !== undefined) {
        thinkTimeSeconds = Math.max(0, previous + (increment ?? 0) - clockSeconds);
      }
    }
    if (clockSeconds !== undefined) lastClockByColor[color] = clockSeconds;

    plies.push({
      san,
      uci: moveToUci(move),
      fenBefore,
      fenAfter,
      color,
      thinkTimeSeconds,
      clockSeconds,
    });

    node = next;
  }

  return plies;
}

/** Parses a `TimeControl` header like `"180+2"` into base + increment seconds. */
function parseTimeControl(timeControl: string | undefined): {
  base?: number;
  increment?: number;
} {
  const match = timeControl?.match(/^(\d+)(?:\+(\d+))?/);
  if (!match) return {};
  return {
    base: Number(match[1]),
    increment: match[2] !== undefined ? Number(match[2]) : undefined,
  };
}

/**
 * Parses a raw UCI move list (e.g. "e2e4 e7e5 g1f3") into a ply list,
 * for pasting move lines straight from an engine's `position ... moves`
 * command instead of a formatted PGN.
 */
export function parseUciMoves(moveList: string): Ply[] {
  const tokens = moveList.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Move list is empty");
  }

  const pos = loadPosition(START_FEN);
  if (!pos) throw new Error("internal: standard start position failed to load");
  const plies: Ply[] = [];
  for (const uci of tokens) {
    const move = parseUci(uci);
    if (!move || !pos.isLegal(move)) {
      throw new Error(`Illegal move "${uci}" at ply ${plies.length + 1}`);
    }
    const fenBefore = makeFen(pos.toSetup());
    const color = moveColorChar(pos);
    const san = makeSanAndPlay(pos, move);
    plies.push({
      san,
      uci,
      fenBefore,
      fenAfter: makeFen(pos.toSetup()),
      color,
    });
  }
  return plies;
}

/** FEN at a given ply index; ply 0 is the starting position. `startFen`
 * defaults to the standard initial position -- pass a custom FEN when the
 * game started from a Lichess "From Position" challenge or any other
 * non-standard setup, so ply 0 reports that position rather than startpos. */
export function fenAtPly(plies: Ply[], ply: number, startFen?: string): string {
  if (ply <= 0) return startFen ?? START_FEN;
  const clamped = Math.min(ply, plies.length);
  return plies[clamped - 1].fenAfter;
}

/** The active color to move, read directly from the FEN's own field. */
export function sideToMove(fen: string): "w" | "b" {
  const token = fen.split(" ")[1];
  return token === "b" ? "b" : "w";
}

export interface PieceOnSquare {
  square: string;
  type: "p" | "n" | "b" | "r" | "q" | "k";
  color: "w" | "b";
}

function pieceAt(pos: Chess, sq: Square): PieceOnSquare | null {
  const piece: Piece | undefined = pos.board.get(sq);
  if (!piece) return null;
  return {
    square: makeSquare(sq),
    type: ROLE_TO_LETTER[piece.role],
    color: colorChar(piece.color),
  };
}

/** Every occupied square in a FEN's piece placement, for rendering. */
export function fenToPieces(fen: string): PieceOnSquare[] {
  const pos = loadPosition(fen);
  if (!pos) return [];
  const pieces: PieceOnSquare[] = [];
  for (const sq of pos.board.occupied) {
    const p = pieceAt(pos, sq);
    if (p) pieces.push(p);
  }
  return pieces;
}

/** Legal destination squares for the piece on `square`, empty if there is none or it can't move. */
export function legalDestinations(fen: string, square: string): string[] {
  const pos = loadPosition(fen);
  if (!pos) return [];
  const sq = parseSquare(square);
  if (sq === undefined) return [];
  const dests: SquareSet | undefined = pos.dests(sq);
  if (!dests) return [];
  return Array.from(dests, makeSquare);
}

/**
 * Attempts a single UCI-style move (from/to/promotion) against a given FEN.
 * Returns the resulting Ply, or `null` if the move is illegal -- never throws,
 * since both a human's click and an engine's `bestmove` are untrusted input
 * from this function's point of view.
 */
export function tryMove(
  fen: string,
  from: string,
  to: string,
  promotion?: string,
): Ply | null {
  const pos = loadPosition(fen);
  if (!pos) return null;
  const fromSq = parseSquare(from);
  const toSq = parseSquare(to);
  if (fromSq === undefined || toSq === undefined) return null;
  const promotionRole = promotion ? PROMOTION_LETTER_TO_ROLE[promotion] : undefined;
  const move: NormalMove = { from: fromSq, to: toSq, promotion: promotionRole };
  if (!pos.isLegal(move)) return null;
  const fenBefore = fen;
  const color = moveColorChar(pos);
  const san = makeSanAndPlay(pos, move);
  return {
    san,
    uci: moveToUci(move),
    fenBefore,
    fenAfter: makeFen(pos.toSetup()),
    color,
  };
}

export type GameStatus =
  | { over: false }
  | {
      over: true;
      /** `"variantEnd"` covers rule-specific wins where neither
       * checkmate nor stalemate applies -- KotH's "king on center"
       * is the first one; three-check and horde will reuse it. */
      reason: "checkmate" | "stalemate" | "draw" | "variantEnd";
    };

/** Whether the game at `fen` has ended, and why. For KotH, pass
 * `variant === "koth"` so chessops' `KingOfTheHill` class is used
 * for terminal detection (a king on D4/D5/E4/E5 ends the game). */
export function gameStatus(fen: string, variant: Variant = "chess"): GameStatus {
  const pos = loadPosition(fen, variant);
  if (!pos) return { over: false };
  if (!pos.isEnd()) return { over: false };
  if (pos.isCheckmate()) return { over: true, reason: "checkmate" };
  if (pos.isStalemate()) return { over: true, reason: "stalemate" };
  // Variant-specific terminal (KotH center square); isEnd() returned
  // true but neither of the two standard terminals matched.
  if (variant !== "chess" && pos.isVariantEnd()) {
    return { over: true, reason: "variantEnd" };
  }
  return { over: true, reason: "draw" };
}

export interface CheckStatus {
  inCheck: boolean;
  checkmate: boolean;
  /** The square of the king currently in check, or `null` when not in check. */
  kingSquare: string | null;
}

/** Whether the side to move at `fen` is in check (and if so, checkmated), and where their king is. */
export function checkStatus(fen: string): CheckStatus {
  const pos = loadPosition(fen);
  if (!pos) return { inCheck: false, checkmate: false, kingSquare: null };
  const inCheck = pos.isCheck();
  if (!inCheck) return { inCheck: false, checkmate: false, kingSquare: null };
  const kingSq = pos.board.kingOf(pos.turn);
  return {
    inCheck: true,
    checkmate: pos.isCheckmate(),
    kingSquare: kingSq !== undefined ? makeSquare(kingSq) : null,
  };
}
