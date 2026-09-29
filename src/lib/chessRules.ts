import { Chess, type Move as ChessJsMove } from "chess.js";

export interface Ply {
  san: string;
  /** UCI notation for this move, e.g. "e2e4" or "e7e8q" for a promotion. */
  uci: string;
  fenBefore: string;
  fenAfter: string;
  color: "w" | "b";
  /**
   * Seconds spent choosing this move, when derivable from the source PGN's
   * `%emt` (elapsed move time) or `%clk` (remaining clock) annotations —
   * both are conventions used by lichess/chess.com/ICC exports, not part
   * of the core PGN spec. `undefined` when the PGN carries no clock data
   * (e.g. a hand-typed game) or the game was loaded from a bare UCI move
   * list, which has no timing concept at all.
   */
  thinkTimeSeconds?: number;
  /** Remaining clock time after this move, when a `%clk` annotation is present. */
  clockSeconds?: number;
}

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const CLK_PATTERN = /\[%clk\s+(\d+):(\d+):(\d+)\]/;
const EMT_PATTERN = /\[%emt\s+(\d+):(\d+):(\d+)\]/;

function matchToSeconds(match: RegExpMatchArray | null): number | undefined {
  if (!match) return undefined;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
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
 * Parses a PGN string into a flat ply list, each carrying the FEN
 * immediately before and after the move so the board can jump to any
 * ply without replaying from the start every time.
 */
export function parsePgn(pgn: string): Ply[] {
  const trimmed = pgn.trim();
  if (!trimmed) {
    throw new Error("PGN is empty");
  }

  const chess = new Chess();
  chess.loadPgn(trimmed);
  const history = chess.history({ verbose: true }) as ChessJsMove[];
  if (history.length === 0) {
    throw new Error("PGN contained no moves");
  }

  const commentByFen = new Map(
    chess.getComments().map(({ fen, comment }) => [fen, comment]),
  );
  const { base, increment } = parseTimeControl(chess.getHeaders().TimeControl);
  const lastClockByColor: Partial<Record<"w" | "b", number>> = {};

  const replay = new Chess();
  const plies: Ply[] = history.map((move) => {
    const fenBefore = replay.fen();
    replay.move(move.san);
    const fenAfter = replay.fen();

    const comment = commentByFen.get(fenAfter);
    const clockSeconds = comment ? matchToSeconds(comment.match(CLK_PATTERN)) : undefined;
    const elapsedMoveSeconds = comment
      ? matchToSeconds(comment.match(EMT_PATTERN))
      : undefined;

    let thinkTimeSeconds: number | undefined = elapsedMoveSeconds;
    if (thinkTimeSeconds === undefined && clockSeconds !== undefined) {
      const previous = lastClockByColor[move.color] ?? base;
      if (previous !== undefined) {
        thinkTimeSeconds = Math.max(0, previous + (increment ?? 0) - clockSeconds);
      }
    }
    if (clockSeconds !== undefined) lastClockByColor[move.color] = clockSeconds;

    return {
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      fenBefore,
      fenAfter,
      color: move.color,
      thinkTimeSeconds,
      clockSeconds,
    };
  });

  return plies;
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

  const chess = new Chess();
  const plies: Ply[] = [];
  for (const uci of tokens) {
    const fenBefore = chess.fen();
    let move: ChessJsMove;
    try {
      move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
      });
    } catch {
      throw new Error(`Illegal move "${uci}" at ply ${plies.length + 1}`);
    }
    plies.push({
      san: move.san,
      uci,
      fenBefore,
      fenAfter: chess.fen(),
      color: move.color,
    });
  }

  return plies;
}

/** FEN at a given ply index; ply 0 is the starting position. */
export function fenAtPly(plies: Ply[], ply: number): string {
  if (ply <= 0) return START_FEN;
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

/** Every occupied square in a FEN's piece placement, for rendering. */
export function fenToPieces(fen: string): PieceOnSquare[] {
  const chess = new Chess(fen);
  const pieces: PieceOnSquare[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) {
        pieces.push({ square: cell.square, type: cell.type, color: cell.color });
      }
    }
  }
  return pieces;
}

// chess.js types `square` as its internal (unexported) `Square` literal union,
// so a plain `string` can't satisfy the overload directly — narrow cast on the
// function itself, not the whole module, to keep the return type checked.
type MovesFromSquare = (opts: { square: string; verbose: true }) => ChessJsMove[];

/** Legal destination squares for the piece on `square`, empty if there is none or it can't move. */
export function legalDestinations(fen: string, square: string): string[] {
  const chess = new Chess(fen);
  const moves = (chess.moves as unknown as MovesFromSquare)({ square, verbose: true });
  return moves.map((move) => move.to);
}

/**
 * Attempts a single UCI-style move (from/to/promotion) against a given FEN.
 * Returns the resulting Ply, or `null` if the move is illegal — never throws,
 * since both a human's click and an engine's `bestmove` are untrusted input
 * from this function's point of view.
 */
export function tryMove(
  fen: string,
  from: string,
  to: string,
  promotion?: string,
): Ply | null {
  const chess = new Chess(fen);
  let move: ChessJsMove;
  try {
    move = chess.move({ from, to, promotion });
  } catch {
    return null;
  }
  return {
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    fenBefore: fen,
    fenAfter: chess.fen(),
    color: move.color,
  };
}

export type GameStatus =
  | { over: false }
  | { over: true; reason: "checkmate" | "stalemate" | "draw" };

/** Whether the game at `fen` has ended, and why. */
export function gameStatus(fen: string): GameStatus {
  const chess = new Chess(fen);
  if (!chess.isGameOver()) return { over: false };
  if (chess.isCheckmate()) return { over: true, reason: "checkmate" };
  if (chess.isStalemate()) return { over: true, reason: "stalemate" };
  return { over: true, reason: "draw" };
}
