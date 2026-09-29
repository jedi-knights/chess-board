export interface UciInfo {
  type: "info";
  depth?: number;
  scoreCp?: number;
  scoreMate?: number;
  nodes?: number;
  nps?: number;
  time?: number;
  pv?: string[];
}

export interface UciBestMove {
  type: "bestmove";
  move: string;
  ponder?: string;
}

export interface UciId {
  type: "id";
  key: string;
  value: string;
}

export interface UciSimple {
  type: "uciok" | "readyok";
}

export interface UciUnknown {
  type: "unknown";
  raw: string;
}

export type UciMessage = UciInfo | UciBestMove | UciId | UciSimple | UciUnknown;

function parseIntToken(tokens: string[], key: string): number | undefined {
  const i = tokens.indexOf(key);
  if (i === -1 || i + 1 >= tokens.length) return undefined;
  const n = Number(tokens[i + 1]);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Parses one line of a UCI engine's stdout. Never throws — engines emit
 * plenty of vendor-specific `info string ...` chatter that has no fixed
 * shape, so anything not recognized becomes `{type: "unknown", raw}`
 * rather than an error.
 */
export function parseUciLine(line: string): UciMessage {
  const trimmed = line.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  if (tokens[0] === "bestmove") {
    const ponderIndex = tokens.indexOf("ponder");
    return {
      type: "bestmove",
      move: tokens[1],
      ponder: ponderIndex !== -1 ? tokens[ponderIndex + 1] : undefined,
    };
  }

  if (trimmed === "uciok") return { type: "uciok" };
  if (trimmed === "readyok") return { type: "readyok" };

  if (tokens[0] === "id" && tokens.length >= 3) {
    return { type: "id", key: tokens[1], value: tokens.slice(2).join(" ") };
  }

  if (tokens[0] === "info") {
    const pvIndex = tokens.indexOf("pv");
    return {
      type: "info",
      depth: parseIntToken(tokens, "depth"),
      scoreCp: parseIntToken(tokens, "cp"),
      scoreMate: parseIntToken(tokens, "mate"),
      nodes: parseIntToken(tokens, "nodes"),
      nps: parseIntToken(tokens, "nps"),
      time: parseIntToken(tokens, "time"),
      pv: pvIndex !== -1 ? tokens.slice(pvIndex + 1) : undefined,
    };
  }

  return { type: "unknown", raw: trimmed };
}

/** `["e2e4", "e7e5"]` -> `"position startpos moves e2e4 e7e5"` (no moves yet -> `"position startpos"`). */
export function buildPositionCommand(moves: string[]): string {
  return moves.length === 0
    ? "position startpos"
    : `position startpos moves ${moves.join(" ")}`;
}

/** `1000` -> `"go movetime 1000"`. */
export function buildGoCommand(movetimeMs: number): string {
  return `go movetime ${movetimeMs}`;
}
