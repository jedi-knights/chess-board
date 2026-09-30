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

/** Challenge-decline reasons Lichess accepts on
 * `POST /api/challenge/{id}/decline`. Exactly this set -- Lichess rejects
 * anything else with a 400. Kept as a string-literal union so a typo
 * fails at compile time, not at request time. */
export type LichessDeclineReason =
  | "generic"
  | "later"
  | "tooFast"
  | "tooSlow"
  | "timeControl"
  | "rated"
  | "casual"
  | "standard"
  | "variant"
  | "noBot"
  | "onlyBot";

export interface LichessChallengeTimeControl {
  /** `"clock" | "correspondence" | "unlimited"`. Everything the decision
   * function cares about hinges on this + `limit` / `daysPerTurn`. */
  type: string;
  /** Base time in seconds (clock time controls). */
  limitSeconds: number | null;
  /** Increment per move in seconds (clock time controls). */
  incrementSeconds: number | null;
  /** Days per turn (correspondence). */
  daysPerTurn: number | null;
}

export interface LichessChallengeEvent {
  type: "challenge";
  challengeId: string;
  challenger: { id: string; name: string; title: string | null } | null;
  destUser: { id: string } | null;
  /** `"standard" | "chess960" | "kingOfTheHill" | ...`. The decision
   * function refuses anything other than `"standard"` for now. */
  variant: string;
  /** `"bullet" | "blitz" | "rapid" | "classical" | "correspondence" |
   * "ultraBullet"`. */
  speed: string;
  rated: boolean;
  /** Present when the challenge starts from a custom FEN (Chess960
   * position, endgame study, etc.). Rejected by the decision function
   * for now -- threading a start-FEN through gameStore/uci.ts is its
   * own follow-up. */
  initialFen: string | null;
  timeControl: LichessChallengeTimeControl;
}

export interface LichessChallengeCanceledEvent {
  type: "challengeCanceled";
  challengeId: string;
}

export interface LichessChallengeDeclinedEvent {
  type: "challengeDeclined";
  challengeId: string;
  /** Whatever reason string Lichess reports back -- may or may not match
   * one of `LichessDeclineReason`'s tags. Logged, not acted on. */
  reason: string | null;
}

export interface LichessGameStartEvent {
  type: "gameStart";
  gameId: string;
  /** The color *this account* (the bot) plays in the started game. */
  botColor: "w" | "b";
}

export interface LichessGameFinishEvent {
  type: "gameFinish";
  gameId: string;
}

export type LichessAccountEvent =
  | LichessChallengeEvent
  | LichessChallengeCanceledEvent
  | LichessChallengeDeclinedEvent
  | LichessGameStartEvent
  | LichessGameFinishEvent;

function readId(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUserRef(obj: Record<string, unknown>, key: string): { id: string } | null {
  const raw = obj[key];
  if (typeof raw !== "object" || raw === null) return null;
  const id = readString(raw as Record<string, unknown>, "id");
  return id ? { id } : null;
}

function parseTimeControl(raw: unknown): LichessChallengeTimeControl {
  if (typeof raw !== "object" || raw === null) {
    return { type: "unknown", limitSeconds: null, incrementSeconds: null, daysPerTurn: null };
  }
  const obj = raw as Record<string, unknown>;
  return {
    type: readString(obj, "type") ?? "unknown",
    limitSeconds: readNumber(obj, "limit"),
    incrementSeconds: readNumber(obj, "increment"),
    daysPerTurn: readNumber(obj, "daysPerTurn"),
  };
}

function parseChallenge(challenge: Record<string, unknown>): LichessChallengeEvent | null {
  const challengeId = readId(challenge, "id");
  if (!challengeId) return null;

  const challengerRaw = challenge.challenger;
  let challenger: LichessChallengeEvent["challenger"] = null;
  if (typeof challengerRaw === "object" && challengerRaw !== null) {
    const c = challengerRaw as Record<string, unknown>;
    const id = readString(c, "id");
    if (id) {
      challenger = {
        id,
        name: readString(c, "name") ?? id,
        title: readString(c, "title"),
      };
    }
  }

  const variantRaw = challenge.variant;
  let variant = "standard";
  if (typeof variantRaw === "object" && variantRaw !== null) {
    variant = readString(variantRaw as Record<string, unknown>, "key") ?? "standard";
  } else if (typeof variantRaw === "string") {
    variant = variantRaw;
  }

  return {
    type: "challenge",
    challengeId,
    challenger,
    destUser: readUserRef(challenge, "destUser"),
    variant,
    speed: readString(challenge, "speed") ?? "unknown",
    rated: challenge.rated === true,
    initialFen: readString(challenge, "initialFen"),
    timeControl: parseTimeControl(challenge.timeControl),
  };
}

/**
 * Normalizes a single NDJSON line from the account-wide `/api/stream/event`
 * endpoint. Returns `null` for line types this app doesn't act on or
 * anything malformed.
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
    return parseChallenge(obj.challenge as Record<string, unknown>);
  }

  if (obj.type === "challengeCanceled" && typeof obj.challenge === "object" && obj.challenge !== null) {
    const id = readId(obj.challenge as Record<string, unknown>, "id");
    return id ? { type: "challengeCanceled", challengeId: id } : null;
  }

  if (obj.type === "challengeDeclined" && typeof obj.challenge === "object" && obj.challenge !== null) {
    const c = obj.challenge as Record<string, unknown>;
    const id = readId(c, "id");
    if (!id) return null;
    // `declineReason` sometimes, `reason` sometimes -- defensively read both.
    const reason = readString(c, "declineReason") ?? readString(c, "reason");
    return { type: "challengeDeclined", challengeId: id, reason };
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

  if (obj.type === "gameFinish" && typeof obj.game === "object" && obj.game !== null) {
    const game = obj.game as Record<string, unknown>;
    const gameId = readId(game, "gameId", "id", "fullId");
    return gameId ? { type: "gameFinish", gameId } : null;
  }

  return null;
}

export interface ChallengeDecisionContext {
  /** The account id this store's slot is verified as, so a self-challenge
   * (challenger.id === myAccountId) can be detected and dropped locally
   * rather than looping back through Lichess. `null` when the account
   * isn't verified yet -- in that case the fair-play guard already
   * refuses `startListening`, so a challenge shouldn't reach this
   * function, but the decision function stays defensive. */
  myAccountId: string | null;
  /** The bot's persisted "accept rated challenges" preference. Default
   * `false` -- a bot testing an engine should not affect other players'
   * ratings unless the operator has explicitly opted in. */
  acceptRated: boolean;
  /** The bot's currently-active game id, if any. A second concurrent
   * game would clobber the single game-stream slot in Rust
   * (`LichessConnection`), so it's a hard "later" decline. */
  activeGameId: string | null;
}

/** Either accept the challenge, decline it with a specific reason Lichess
 * understands, or drop it locally without contacting Lichess at all
 * (self-challenge -- Lichess would reject a self-decline with a 400). */
export type ChallengeDecision =
  | { kind: "accept" }
  | { kind: "decline"; reason: LichessDeclineReason }
  | { kind: "drop"; because: string };

/**
 * Decides whether to accept, decline, or silently drop an incoming
 * challenge. Pure function -- takes state as parameters rather than
 * reading a store -- so every branch is directly testable and no
 * "wait for the mock to observe this" ceremony is needed. The bot store
 * is a thin wrapper that plugs in its own state.
 *
 * The order matters: the safety branches (self, wrong recipient) run
 * before policy branches (variant, rated) so a malformed challenge
 * that also happens to be rated doesn't get a misleading "rated"
 * decline that hides the real problem.
 */
export function decideChallenge(
  challenge: LichessChallengeEvent,
  ctx: ChallengeDecisionContext,
): ChallengeDecision {
  // Self-challenges arise from this same account issuing an outgoing
  // challenge that then races back through the event stream. Lichess
  // rejects a self-decline with a 400, so decline is not a valid
  // action -- drop it locally and move on.
  if (ctx.myAccountId && challenge.challenger?.id === ctx.myAccountId) {
    return { kind: "drop", because: "self-challenge" };
  }
  // Belt-and-braces: if Lichess ever routes a challenge to us that names
  // a different destUser, refuse rather than accept a challenge that
  // wasn't for us. `null` destUser is fine -- open challenges arrive
  // without one.
  if (ctx.myAccountId && challenge.destUser && challenge.destUser.id !== ctx.myAccountId) {
    return { kind: "decline", reason: "generic" };
  }
  // The single game-stream slot in Rust is shared between board and bot
  // mode; a second concurrent game would clobber the first. Supporting
  // concurrent games is a separate design conversation, not a drive-by.
  if (ctx.activeGameId) {
    return { kind: "decline", reason: "later" };
  }
  if (challenge.variant !== "standard") {
    return { kind: "decline", reason: "variant" };
  }
  // Custom starting position -- threading a start FEN through
  // gameStore/uci.ts is its own follow-up. Using "standard" (Lichess's
  // "Don't play standard chess" reason) or "generic" -- either is
  // defensible; `generic` is the honest "we don't support this yet"
  // without misrepresenting policy.
  if (challenge.initialFen !== null) {
    return { kind: "decline", reason: "generic" };
  }
  if (challenge.speed === "correspondence" || challenge.timeControl.type === "correspondence") {
    return { kind: "decline", reason: "timeControl" };
  }
  if (challenge.rated && !ctx.acceptRated) {
    return { kind: "decline", reason: "rated" };
  }
  return { kind: "accept" };
}

/**
 * Whatever `GET /api/account` reports about the currently-authorized token,
 * narrowed to the fields the fair-play guard needs. Frontend parallel of
 * `AccountInfo` in `src-tauri/src/lichess.rs`; the Rust side already
 * enforces `is_bot`-vs-slot before any HTTP request goes out, and this
 * type is what `lichess_verify_account` deserializes to.
 */
export interface LichessAccountInfo {
  id: string;
  username: string;
  /** True iff Lichess reports `title === "BOT"`. Any other title (GM/IM/FM),
   * or a missing title, means this is not a bot account. */
  isBot: boolean;
}

export interface LichessBotSummary {
  username: string;
  title: string | null;
  /** Rating per perf (e.g. "bullet", "blitz", "rapid"), when present. */
  ratings: Record<string, number>;
}

function parseBotSummary(line: string): LichessBotSummary | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.username !== "string") return null;

  const ratings: Record<string, number> = {};
  if (typeof obj.perfs === "object" && obj.perfs !== null) {
    for (const [perf, value] of Object.entries(obj.perfs as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const rating = (value as Record<string, unknown>).rating;
      if (typeof rating === "number") ratings[perf] = rating;
    }
  }

  return {
    username: obj.username,
    title: typeof obj.title === "string" ? obj.title : null,
    ratings,
  };
}

/**
 * Parses the NDJSON body of `GET /api/bot/online` into a list of bot
 * accounts. Skips any line that doesn't parse or has no username, rather
 * than failing the whole list -- one malformed entry shouldn't hide every
 * other bot. The line count itself is bounded server-side by the `nb`
 * request parameter (see lichess.rs's MAX_BOTS_LISTED), not here.
 */
export function parseBotOnlineList(raw: string): LichessBotSummary[] {
  const bots: LichessBotSummary[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bot = parseBotSummary(trimmed);
    if (bot) bots.push(bot);
  }
  return bots;
}
