/**
 * Parses Lichess Board API NDJSON game-stream lines. The single seam for
 * Lichess's JSON shapes -- nothing else in the codebase should read a raw
 * Lichess event field directly. Mirrors uci.ts's role for the UCI protocol.
 */

/**
 * Lichess emits an `opponentGone` NDJSON line on the game stream when
 * the opponent leaves the board (closes the tab, loses connection).
 * `gone: true` means they're currently absent; `claimWinInSeconds`
 * counts down until the local player can win by claim. Once the
 * opponent returns, another `opponentGone: false` line arrives.
 */
export interface LichessOpponentGone {
  gone: boolean;
  /** Seconds until this player can `/claim-victory`. `null` while the
   * opponent is present (or hasn't been gone long enough yet), or on
   * game types that don't support claim-victory (correspondence). */
  claimWinInSeconds: number | null;
}

/** Parses an `opponentGone` line. Returns `null` for anything else --
 * `parseLichessLine` handles gameFull/gameState in parallel; both
 * parsers run on every incoming stream line so no data is dropped. */
export function parseLichessOpponentGone(raw: string): LichessOpponentGone | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.type !== "opponentGone") return null;
  const gone = obj.gone === true;
  const claimRaw = obj.claimWinInSeconds;
  const claimWinInSeconds =
    typeof claimRaw === "number" && Number.isFinite(claimRaw) ? claimRaw : null;
  return { gone, claimWinInSeconds };
}

export interface LichessMoveUpdate {
  /** Every move played so far, from the start of the game, in UCI notation. */
  moves: string[];
  /** Lichess's own game-status string, e.g. "started", "mate", "resign". */
  status: string;
  /** White's remaining time in ms at the moment of this update, if present.
   * Absent on non-clocked games (correspondence, unlimited). */
  wtimeMs: number | null;
  btimeMs: number | null;
  /** Increment in ms per move -- fixed for the game, but Lichess reports it
   * on every state update anyway. Absent when there is no increment. */
  wincMs: number | null;
  bincMs: number | null;
  /** Lichess player id of the white side, only present on the initial
   * `gameFull` line -- subsequent `gameState` lines don't carry it. Used
   * (compared against the verified account id) to derive which color the
   * *human* plays, replacing the pre-PR-4 manual "Play as" picker. */
  whiteId: string | null;
  blackId: string | null;
  /** Display name of each side (case-preserved). Also only on
   * `gameFull`. Shown in `LiveGameClocks` next to the clock so the
   * user can tell their own engine (jk-bot) from the opponent
   * (omcrosby) at a glance. */
  whiteName: string | null;
  blackName: string | null;
  /** Account title of each side (`"BOT"`, `"GM"`, ...) or null. The
   * clock display shows `(BOT)` next to a bot opponent's name so it's
   * obvious at a glance which side is an engine. */
  whiteTitle: string | null;
  blackTitle: string | null;
  /** Starting FEN for the game -- present on the `gameFull` top level
   * for "From Position" and Chess960 games, `"startpos"` or absent for
   * a standard-startpos game. Only extracted from `gameFull`; subsequent
   * `gameState` lines don't carry it (the start FEN is fixed for the
   * game). Normalized to `null` when the field is missing, `"startpos"`,
   * or malformed. */
  initialFen: string | null;
  /** Lichess variant key (`"standard"`, `"chess960"`, ...). Only present
   * on the `gameFull` top level; `null` on `gameState` lines and on
   * anything malformed. The chess-board side only acts on this when it
   * differs from "standard" -- Chess960 toggles the engine's
   * UCI_Chess960 option on game start. */
  variant: string | null;
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

function readOptionalNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeState(state: Record<string, unknown>): LichessMoveUpdate | null {
  const movesField = state.moves;
  const status = state.status;
  if (typeof movesField !== "string" || typeof status !== "string") return null;
  const trimmed = movesField.trim();
  return {
    moves: trimmed.length > 0 ? trimmed.split(/\s+/) : [],
    status,
    wtimeMs: readOptionalNumber(state, "wtime"),
    btimeMs: readOptionalNumber(state, "btime"),
    wincMs: readOptionalNumber(state, "winc"),
    bincMs: readOptionalNumber(state, "binc"),
    whiteId: null,
    blackId: null,
    whiteName: null,
    blackName: null,
    whiteTitle: null,
    blackTitle: null,
    initialFen: null,
    variant: null,
  };
}

interface PlayerInfo {
  id: string | null;
  name: string | null;
  title: string | null;
}

function readPlayerInfo(obj: Record<string, unknown>, key: string): PlayerInfo {
  const value = obj[key];
  if (typeof value !== "object" || value === null) {
    return { id: null, name: null, title: null };
  }
  const player = value as Record<string, unknown>;
  const read = (field: string): string | null => {
    const v = player[field];
    return typeof v === "string" ? v : null;
  };
  return { id: read("id"), name: read("name"), title: read("title") };
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
    const state = normalizeState(obj.state as Record<string, unknown>);
    if (!state) return null;
    // gameFull's top level carries `white: {id, name, title, ...}` and
    // `black: {...}`; gameState lines don't. Extracting them here means
    // callers can derive the human's color AND display the opponent's
    // name from a single seam.
    const white = readPlayerInfo(obj, "white");
    const black = readPlayerInfo(obj, "black");
    // Lichess sends `initialFen: "startpos"` for standard-startpos games
    // and an actual FEN string for "From Position" / Chess960. Normalize
    // the sentinel to `null` so callers can key on `initialFen !== null`.
    const initialFenRaw = typeof obj.initialFen === "string" ? obj.initialFen : null;
    const initialFen = initialFenRaw === "startpos" || initialFenRaw === null
      ? null
      : initialFenRaw;
    // Lichess's gameFull `variant` is an object `{ key, name }` on the
    // Board API; the challenge event's `variant` is the same shape (see
    // parseChallenge). Read `.key` defensively since older Bot API
    // payloads have been seen with a bare string.
    const variantRaw = obj.variant;
    let variant: string | null = null;
    if (typeof variantRaw === "object" && variantRaw !== null) {
      const v = (variantRaw as Record<string, unknown>).key;
      if (typeof v === "string") variant = v;
    } else if (typeof variantRaw === "string") {
      variant = variantRaw;
    }
    return {
      ...state,
      whiteId: white.id,
      blackId: black.id,
      whiteName: white.name,
      blackName: black.name,
      whiteTitle: white.title,
      blackTitle: black.title,
      initialFen,
      variant,
    };
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
   * one of `LichessDeclineReason`'s tags. Surfaced in the UI so the
   * user knows *why* their outgoing challenge produced no game. */
  reason: string | null;
  /** The account id of who sent the challenge; compare against the
   * verified account id to tell "we declined their incoming" (our id)
   * from "they declined our outgoing" (not our id). */
  challengerId: string | null;
  /** Display name of the recipient of the challenge -- for outgoing
   * declines this is the bot that said no, used to show
   * "<name> declined: <reason>" and to filter them out of the Browse
   * Online Bots list for the rest of the session. */
  destUserName: string | null;
  destUserId: string | null;
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
    const challenger = readUserRef(c, "challenger");
    const destUser =
      typeof c.destUser === "object" && c.destUser !== null
        ? (c.destUser as Record<string, unknown>)
        : null;
    return {
      type: "challengeDeclined",
      challengeId: id,
      reason,
      challengerId: challenger?.id ?? null,
      destUserId: destUser ? readString(destUser, "id") : null,
      destUserName: destUser ? readString(destUser, "name") : null,
    };
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

/** Maps a Lichess variant key to the chess-board-internal `Rules`
 * value. Centralized here so every consumer (both Lichess stores plus
 * any future code path) stays in sync. Unknown variants collapse to
 * `"chess"` -- `decideChallenge` already refuses them, so this is a
 * defense-in-depth default. */
export function rulesFromLichessVariant(variant: string | null): "chess" | "chess960" | "koth" | "3check" | "horde" | "racingkings" {
  if (variant === "chess960") return "chess960";
  if (variant === "kingOfTheHill") return "koth";
  if (variant === "threeCheck") return "3check";
  if (variant === "horde") return "horde";
  if (variant === "racingKings") return "racingkings";
  return "chess";
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
  // Chess960 and King of the Hill are accepted. Chess960 ships
  // `setoption name UCI_Chess960 value true` on engine start; KotH ships
  // `setoption name UCI_Variant value kingofthehill`. Other Lichess
  // variants still fail here until each lands as its own engine PR.
  if (
    challenge.variant !== "standard"
    && challenge.variant !== "chess960"
    && challenge.variant !== "kingOfTheHill"
    && challenge.variant !== "threeCheck"
    && challenge.variant !== "horde"
    && challenge.variant !== "racingKings"
  ) {
    return { kind: "decline", reason: "variant" };
  }
  // Custom starting positions ("From Position") are accepted now that
  // startFen is plumbed through gameStore / uci.ts. Lichess validates
  // the FEN before issuing the challenge, so a non-null `initialFen`
  // here is a legal standard-rules position by the time it reaches us.
  //
  // Correspondence games are also accepted: Lichess omits `wtime`/`btime`
  // on correspondence streams, so `commitServerClocksEarly`'s own guard
  // leaves `serverClocks` null, and `buildBotGoOptions` already falls
  // back to plain `movetimeMs` in that case -- the engine thinks for
  // its configured movetime per move regardless of how many days
  // Lichess gives it. A human playing correspondence just moves whenever.
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
