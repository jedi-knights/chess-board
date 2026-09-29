/**
 * Parses Lichess Board API NDJSON game-stream lines. The single seam for
 * Lichess's JSON shapes -- nothing else in the codebase should read a raw
 * Lichess event field directly. Mirrors uci.ts's role for the UCI protocol.
 */

export interface LichessMoveUpdate {
  /** Every move played so far, from the start of the game, in UCI notation. */
  moves: string[];
  /** Lichess's own game-status string, e.g. "started", "mate", "resign". */
  status: string;
}

/**
 * Lichess statuses that mean the game has ended. "created" and "started"
 * are the only in-progress values Lichess sends for the Board API.
 */
const TERMINAL_STATUSES = new Set([
  "aborted",
  "mate",
  "resign",
  "stalemate",
  "timeout",
  "draw",
  "outoftime",
  "cheat",
  "noStart",
  "unknownFinish",
  "variantEnd",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function normalizeState(state: Record<string, unknown>): LichessMoveUpdate | null {
  const movesField = state.moves;
  const status = state.status;
  if (typeof movesField !== "string" || typeof status !== "string") return null;
  const trimmed = movesField.trim();
  return { moves: trimmed.length > 0 ? trimmed.split(/\s+/) : [], status };
}

/**
 * Normalizes a single NDJSON line from `/api/board/game/stream/{id}` into
 * a move update, or `null` for line types this app doesn't act on yet
 * (`chatLine`, `opponentGone`) or anything malformed.
 *
 * Both `gameFull` (the first line) and `gameState` (every line after)
 * carry the same moves/status shape -- `gameFull` just nests it one level
 * deeper, under `state`.
 */
export function parseLichessLine(raw: string): LichessMoveUpdate | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;

  if (obj.type === "gameFull" && typeof obj.state === "object" && obj.state !== null) {
    return normalizeState(obj.state as Record<string, unknown>);
  }
  if (obj.type === "gameState") {
    return normalizeState(obj);
  }
  return null;
}

export interface LichessChallengeEvent {
  type: "challenge";
  challengeId: string;
}

export interface LichessGameStartEvent {
  type: "gameStart";
  gameId: string;
  /** The color *this account* (the bot) plays in the started game. */
  botColor: "w" | "b";
}

export type LichessAccountEvent = LichessChallengeEvent | LichessGameStartEvent;

function readId(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Normalizes a single NDJSON line from the account-wide `/api/stream/event`
 * endpoint (used by the Bot API to learn about incoming challenges and
 * game starts). `null` for line types this app doesn't act on (declined
 * challenges, etc.) or anything malformed.
 *
 * Reads both `id` and `gameId` for the game-start id field defensively --
 * Lichess's own field naming here has drifted across API versions.
 */
export function parseLichessAccountEvent(raw: string): LichessAccountEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;

  if (obj.type === "challenge" && typeof obj.challenge === "object" && obj.challenge !== null) {
    const challengeId = readId(obj.challenge as Record<string, unknown>, "id");
    return challengeId ? { type: "challenge", challengeId } : null;
  }

  if (obj.type === "gameStart" && typeof obj.game === "object" && obj.game !== null) {
    const game = obj.game as Record<string, unknown>;
    const gameId = readId(game, "gameId", "id", "fullId");
    if (!gameId) return null;
    // Deliberately strict, not a "w"-default: this decides which side the
    // engine plays -- silently defaulting on a missing/malformed color
    // would make the engine play the wrong side without ever raising an
    // error, surfacing only as confusing "illegal move" rejections later.
    if (game.color !== "white" && game.color !== "black") return null;
    const botColor = game.color === "black" ? "b" : "w";
    return { type: "gameStart", gameId, botColor };
  }

  return null;
}
