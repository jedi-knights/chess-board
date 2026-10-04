import type { Ply } from "./chessRules";
import { START_FEN } from "./chessRules";

/**
 * Build a PGN string from a finished game. Mirrors the shape every
 * chess-training ingestion tool expects (python-chess, lc0, Stockfish's
 * self-play pipeline): seven-tag roster + optional tags + a movetext
 * block of SAN moves with move numbers and the terminating result token.
 *
 * The function is pure -- callers assemble the headers and plies from
 * whatever source (Lichess bot store, PGN parser, hand-constructed). The
 * only chess knowledge here is move-number formatting; everything else
 * is string shaping. This is why `Ply.san` is required: we never
 * re-derive SAN from UCI here, because the plies array already carries
 * authoritative SAN from `chessops`.
 */

/** PGN seven-tag roster plus the optional tags we routinely populate. */
export interface PgnHeaders {
  Event: string;
  Site: string;
  Date: string;
  Round: string;
  White: string;
  Black: string;
  Result: string;
  WhiteTitle?: string;
  BlackTitle?: string;
  Variant?: string;
  TimeControl?: string;
}

/** Escapes a header value per PGN spec: embedded `"` and `\` get
 * backslash-prefixed. All other characters pass through -- PGN tag
 * values are 7-bit ASCII in spec but every real-world parser accepts
 * UTF-8, so no stripping. */
function escapeTagValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Determines the starting full-move number and side-to-move from a
 * FEN. Returns 1-based move number and "w"/"b" starting side. Falls
 * back to (1, "w") for an unparseable FEN -- this is the standard-
 * startpos default and the right behavior for the common case. */
function startingMoveNumber(fen: string): { number: number; side: "w" | "b" } {
  const parts = fen.split(" ");
  // Standard FEN shape: "pieces side castling en-passant halfmove fullmove"
  const side = parts[1] === "b" ? "b" : "w";
  const n = Number(parts[5]);
  const number = Number.isFinite(n) && n > 0 ? n : 1;
  return { number, side };
}

/** Formats a game's movetext as "<N>. <wSan> <bSan> <N+1>. <wSan> ..."
 * ending with the Result token. For a game that starts with Black to
 * move (custom FEN), emits "<N>... <bSan> <N+1>. <wSan> ..." per PGN
 * convention. */
function formatMovetext(
  plies: readonly Ply[],
  result: string,
  startFen: string,
): string {
  const { number: startNumber, side: startSide } = startingMoveNumber(startFen);
  const tokens: string[] = [];
  let moveNumber = startNumber;
  let awaitingWhiteOfPair = startSide === "w";

  for (let i = 0; i < plies.length; i++) {
    const ply = plies[i];
    if (awaitingWhiteOfPair) {
      tokens.push(`${moveNumber}.`);
      tokens.push(ply.san);
      awaitingWhiteOfPair = false;
    } else {
      if (i === 0) {
        // Black-first game (custom FEN): emit "<N>... <bSan>" so the
        // mover and move-number stay unambiguous.
        tokens.push(`${moveNumber}...`);
      }
      tokens.push(ply.san);
      moveNumber += 1;
      awaitingWhiteOfPair = true;
    }
  }
  tokens.push(result);
  return tokens.join(" ");
}

export function buildPgn(
  plies: readonly Ply[],
  headers: PgnHeaders,
  startFen?: string,
): string {
  const lines: string[] = [];
  const emit = (name: string, value: string) => {
    lines.push(`[${name} "${escapeTagValue(value)}"]`);
  };
  // Seven-tag roster, in the order required by PGN spec.
  emit("Event", headers.Event);
  emit("Site", headers.Site);
  emit("Date", headers.Date);
  emit("Round", headers.Round);
  emit("White", headers.White);
  emit("Black", headers.Black);
  emit("Result", headers.Result);
  // Optional tags we populate when available.
  if (headers.WhiteTitle) emit("WhiteTitle", headers.WhiteTitle);
  if (headers.BlackTitle) emit("BlackTitle", headers.BlackTitle);
  if (headers.Variant) emit("Variant", headers.Variant);
  if (headers.TimeControl) emit("TimeControl", headers.TimeControl);
  // Non-standard start: emit SetUp + FEN so a replayer can reconstruct
  // the exact position. Omitted for the normal standard-startpos case.
  const effectiveStart = startFen ?? START_FEN;
  if (effectiveStart !== START_FEN) {
    emit("SetUp", "1");
    emit("FEN", effectiveStart);
  }
  // PGN requires a blank line between the tag section and the movetext.
  lines.push("");
  lines.push(formatMovetext(plies, headers.Result, effectiveStart));
  // Trailing newline so unix tools (`wc -l`, `cat` concatenation) treat
  // the file as a well-formed text file.
  return lines.join("\n") + "\n";
}
