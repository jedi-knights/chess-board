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

export type UciOptionType = "check" | "spin" | "combo" | "button" | "string";

export interface UciOption {
  type: "option";
  name: string;
  optionType: UciOptionType;
  default?: string;
  min?: number;
  max?: number;
  vars?: string[];
}

export type UciMessage = UciInfo | UciBestMove | UciId | UciSimple | UciUnknown | UciOption;

function parseIntToken(tokens: string[], key: string): number | undefined {
  const i = tokens.indexOf(key);
  if (i === -1 || i + 1 >= tokens.length) return undefined;
  const n = Number(tokens[i + 1]);
  return Number.isNaN(n) ? undefined : n;
}

const OPTION_KEYWORDS = new Set(["min", "max", "var", "default"]);

function nextOptionKeyword(tokens: string[], from: number): number {
  for (let i = from; i < tokens.length; i++) {
    if (OPTION_KEYWORDS.has(tokens[i])) return i;
  }
  return tokens.length;
}

/**
 * Parses a UCI `option name <name> type <type> [default ...] [min ...]
 * [max ...] [var ...]*` line. `name` and `default` may themselves contain
 * spaces, so both are read up to the next recognized keyword rather than
 * split on a fixed token count. Returns `undefined` for a malformed line
 * (missing `name`/`type`) rather than throwing.
 */
function parseOptionLine(tokens: string[]): UciOption | undefined {
  const nameIdx = tokens.indexOf("name");
  const typeIdx = tokens.indexOf("type", nameIdx + 1);
  if (nameIdx === -1 || typeIdx === -1) return undefined;

  const name = tokens.slice(nameIdx + 1, typeIdx).join(" ");
  const optionType = tokens[typeIdx + 1] as UciOptionType;
  const rest = tokens.slice(typeIdx + 2);

  let defaultValue: string | undefined;
  let min: number | undefined;
  let max: number | undefined;
  const vars: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "default") {
      const end = nextOptionKeyword(rest, i + 1);
      defaultValue = rest.slice(i + 1, end).join(" ");
      i = end - 1;
    } else if (rest[i] === "min") {
      min = Number(rest[i + 1]);
      i += 1;
    } else if (rest[i] === "max") {
      max = Number(rest[i + 1]);
      i += 1;
    } else if (rest[i] === "var") {
      vars.push(rest[i + 1]);
      i += 1;
    }
  }

  return {
    type: "option",
    name,
    optionType,
    default: defaultValue,
    min,
    max,
    vars: vars.length > 0 ? vars : undefined,
  };
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

  if (tokens[0] === "option") {
    return parseOptionLine(tokens) ?? { type: "unknown", raw: trimmed };
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

/**
 * `("UseNNUE", "true")` -> `"setoption name UseNNUE value true"`.
 * `("Clear Hash")` (no value) -> `"setoption name Clear Hash"` -- UCI
 * `button`-type options are triggered with no `value` clause at all.
 */
export function buildSetOptionCommand(name: string, value?: string): string {
  return value !== undefined
    ? `setoption name ${name} value ${value}`
    : `setoption name ${name}`;
}

const MAX_SEARCH_INFO_HISTORY = 64;

/**
 * Appends one `info` line to a bounded per-search history, capped so a
 * misbehaving engine emitting unbounded `info` chatter can't grow this
 * without limit -- a real search only produces one line per completed
 * depth, so 64 is generous headroom, not a realistic ceiling.
 */
export function appendSearchInfo(history: UciInfo[], info: UciInfo): UciInfo[] {
  const next = [...history, info];
  return next.length > MAX_SEARCH_INFO_HISTORY
    ? next.slice(next.length - MAX_SEARCH_INFO_HISTORY)
    : next;
}

/**
 * Adds or replaces an option by name. An engine's `option` lines arrive
 * once per name during the post-`uci` handshake burst in practice, but
 * this stays correct if one is ever re-sent (e.g. after `ucinewgame`)
 * rather than accumulating a duplicate entry.
 */
export function upsertOption(options: UciOption[], incoming: UciOption): UciOption[] {
  const index = options.findIndex((o) => o.name === incoming.name);
  if (index === -1) return [...options, incoming];
  const next = [...options];
  next[index] = incoming;
  return next;
}
