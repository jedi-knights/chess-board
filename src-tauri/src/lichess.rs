//! Talks to the Lichess HTTP API. Deliberately dumb, same boundary as
//! `engine.rs`: this module never parses PGN, UCI, or Lichess's NDJSON game
//! state -- it only validates ids/moves, makes the HTTP request, and hands
//! raw text back (PGN export) or emits raw NDJSON lines as Tauri events
//! (game stream). All protocol parsing lives in the frontend
//! (`src/lib/chessRules.ts`, `src/lib/lichess.ts`).
//!
//! The personal access token lives in the OS keychain (via the `keyring`
//! crate), never in a Tauri-managed in-memory struct or a frontend store --
//! it's a bearer credential, not app state, and every command that needs it
//! reads it fresh from the keychain rather than having it passed in from JS.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

/// Idle-timeout on the game/event NDJSON streams. Lichess emits `\n`
/// keep-alive lines on quiet streams, so 20 s of *total* silence means
/// the underlying connection has died -- classic TCP-half-open failure
/// modes don't surface any I/O error, they just stop delivering bytes.
const STREAM_KEEPALIVE_TIMEOUT: Duration = Duration::from_secs(20);

/// Per-request connect-timeout on the reqwest client. The one-shot
/// requests (verify, challenge, resign, ...) also get a total timeout
/// via `new_client()`; streaming requests use `new_stream_client()`
/// which has *only* the connect timeout so a legitimately-idle stream
/// isn't killed prematurely (the 20 s idle detection in
/// `pump_ndjson_stream` handles that side).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Per-request total timeout on the one-shot (non-streaming) client.
/// Lichess's synchronous endpoints (`/api/challenge/{u}`, moves, etc.)
/// respond within a few hundred ms in practice; 30 s is generous
/// headroom for slow networks without being long enough to leave a
/// hung request queued behind our outbound mutex.
const ONESHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait after a 429 before retrying. Lichess's stated
/// policy is "back off for 60 seconds"; hard-coding the pause here
/// avoids interpreting the Retry-After header (which they don't
/// always send) and gives every burst-limited caller the same recovery.
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(60);

/// Exponential-backoff schedule for reconnecting a dropped stream.
/// 1 s -> 2 s -> 4 s -> 8 s -> 16 s -> 30 s (cap). Reset on any
/// successful bytes so a stream that succeeds then dies gets a fresh
/// fast retry the next time. Pure struct, tested in isolation.
#[derive(Debug, Default)]
struct RetrySchedule {
    attempt: u32,
}

impl RetrySchedule {
    const CAP_SECS: u64 = 30;
    fn new() -> Self {
        RetrySchedule::default()
    }
    fn next(&mut self) -> Duration {
        // 1 << attempt for attempt in {0,1,2,3,4} = {1,2,4,8,16}, then
        // cap at 30 s. saturating_add so attempt can't overflow
        // regardless of how long the reconnect loop runs.
        let secs = 1u64.checked_shl(self.attempt).unwrap_or(Self::CAP_SECS).min(Self::CAP_SECS);
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_secs(secs)
    }
    fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// Serializes every authenticated POST to Lichess so a bursty user
/// action (e.g. rapid-fire draw offers) can't race itself into a 429
/// unnecessarily. Static because the mutex has the same lifetime as
/// the app and threading a State through every POST-making command
/// would double their signatures.
fn outbound_mutex() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Splits completed newline-terminated lines out of a byte buffer. Each
/// returned string is a full, UTF-8-decoded, non-empty NDJSON line.
/// Partial bytes at the end of the buffer -- including the fragment of
/// a multi-byte UTF-8 codepoint split across a chunk boundary -- are
/// left in place for the next `pop_lines` call.
///
/// Pre-PR-6 the pump decoded each chunk with `from_utf8_lossy` and
/// then split; that corrupts multi-byte characters split across chunks
/// (a common shape when streaming user-supplied challenge messages or
/// usernames with accents).
fn pop_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
        let mut line: Vec<u8> = buffer.drain(..=pos).collect();
        // Drop the trailing '\n'.
        line.pop();
        // Drop a trailing '\r' if present (some HTTP servers send CRLF).
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        // Decode UTF-8 across the *full* line, not per-chunk. A
        // malformed line silently drops -- same policy as pre-PR-6.
        if let Ok(s) = String::from_utf8(line) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

const GAME_ID_LEN: usize = 8;
const KEYRING_SERVICE: &str = "com.jediknights.chessboard";
/// Pre-PR-1 there was one credential shared across every Lichess flow; the
/// upgrade to per-mode slots keeps this constant only to *migrate* off it
/// on first launch (see `migrate_legacy_token`). New code never reads this.
const KEYRING_USER_LEGACY: &str = "lichess-personal-token";
const KEYRING_USER_HUMAN: &str = "lichess-human-token";
const KEYRING_USER_BOT: &str = "lichess-bot-token";

/// Which credential a Lichess request runs under. Two tokens are the *only*
/// safe way to enforce Lichess's fair-play rule that a BOT account never
/// makes a human's moves and vice versa -- a single token that either mode
/// could use makes that guarantee unenforceable in code.
///
/// The tag is chosen by *Rust*, not by JS, for every command whose slot is
/// determined by the endpoint it hits (every `/api/board/*` call is Human,
/// every `/api/bot/*` call is Bot). Only commands that legitimately serve
/// both modes (the account event stream, challenge accept/decline, the
/// pending-challenge handler) accept a slot parameter -- and even then
/// Rust validates it against a fixed enum before use, so a malformed JS
/// value is rejected before it can reach the keychain.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum TokenSlot {
    Human,
    Bot,
}

fn keyring_user(slot: TokenSlot) -> &'static str {
    match slot {
        TokenSlot::Human => KEYRING_USER_HUMAN,
        TokenSlot::Bot => KEYRING_USER_BOT,
    }
}

/// Whatever `GET /api/account` reports about the currently-authorized token,
/// narrowed to the fields the fair-play guard needs. See
/// `LichessAccountInfo` in `src/lib/lichess.ts` -- the frontend
/// counterpart. `camelCase` on the wire so the TS side reads it naturally
/// as `info.isBot` without a separate rename layer.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub username: String,
    /// Lichess reports the account's title (`"BOT"`, `"GM"`, `"IM"`, ...) or
    /// omits the field entirely; only `title == "BOT"` matters for the
    /// fair-play guard, so this collapses to a single boolean.
    pub is_bot: bool,
}

/// Extracts and validates a Lichess game id from either a bare id or a full
/// game URL (e.g. `https://lichess.org/abcd1234`, optionally with a
/// `/white`, `/black`, or query-string suffix from a shared link).
///
/// Lichess game ids are exactly 8 base62 (alphanumeric) characters -- this
/// is a real trust boundary (the id ends up in a request URL), so reject
/// anything that doesn't match rather than passing user input through.
pub fn parse_game_id(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("game id or URL is empty".to_string());
    }

    let without_query = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    let mut segments: Vec<&str> = without_query.split('/').filter(|s| !s.is_empty()).collect();

    // A shared game link may carry a trailing color suffix, e.g.
    // ".../abcd1234/white" or ".../abcd1234/black" -- that segment isn't
    // part of the id, so drop it before taking the last segment.
    if matches!(segments.last(), Some(&"white") | Some(&"black")) {
        segments.pop();
    }
    let candidate = segments.last().copied().unwrap_or(without_query);

    let valid =
        candidate.len() == GAME_ID_LEN && candidate.chars().all(|c| c.is_ascii_alphanumeric());
    if !valid {
        return Err(format!(
            "\"{trimmed}\" doesn't look like a Lichess game id or URL (expected {GAME_ID_LEN} alphanumeric characters)"
        ));
    }
    Ok(candidate.to_string())
}

fn keyring_entry_for(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user)
        .map_err(|e| format!("failed to access OS keychain: {e}"))
}

fn keyring_entry(slot: TokenSlot) -> Result<keyring::Entry, String> {
    keyring_entry_for(keyring_user(slot))
}

/// Reads the stored personal access token for the given slot. `Err` (not
/// an empty string) when none is set, so every caller that needs the token
/// to make a request is forced to handle "not connected" rather than
/// silently sending an unauthenticated request that Lichess would then
/// reject.
fn token(slot: TokenSlot) -> Result<String, String> {
    match keyring_entry(slot)?.get_password() {
        Ok(token) => Ok(token),
        Err(keyring::Error::NoEntry) => {
            let label = match slot {
                TokenSlot::Human => "human",
                TokenSlot::Bot => "bot",
            };
            Err(format!("no Lichess {label} token is set -- add one first"))
        }
        Err(e) => Err(format!("failed to read token from OS keychain: {e}")),
    }
}

#[tauri::command]
pub fn lichess_token_set(
    slot: TokenSlot,
    token: String,
    account_cache: State<'_, SharedAccountCache>,
) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("token is empty".to_string());
    }
    keyring_entry(slot)?
        .set_password(trimmed)
        .map_err(|e| format!("failed to store token in OS keychain: {e}"))?;
    // A new token means the cached account info for this slot is stale --
    // could be a rotation to a completely different account. Drop it so
    // the next request re-verifies before it decides "is this the right
    // slot for this account?".
    invalidate_account_cache(&account_cache, slot);
    Ok(())
}

#[tauri::command]
pub fn lichess_token_has(slot: TokenSlot) -> Result<bool, String> {
    match keyring_entry(slot)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("failed to query OS keychain: {e}")),
    }
}

#[tauri::command]
pub fn lichess_token_clear(
    slot: TokenSlot,
    account_cache: State<'_, SharedAccountCache>,
) -> Result<(), String> {
    let result = match keyring_entry(slot)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to clear token from OS keychain: {e}")),
    };
    // Invalidate regardless of the delete outcome -- if we couldn't remove
    // the credential but we tried to, whoever asked believed the token is
    // gone and shouldn't be gated by stale cache state.
    invalidate_account_cache(&account_cache, slot);
    result
}

/// Migrates the legacy single-token entry (`lichess-personal-token`, pre-
/// PR-1) into the human slot on first launch after upgrade, then deletes
/// it. Idempotent: once migrated, the legacy entry no longer exists, so
/// subsequent launches skip this entirely.
///
/// The legacy token could have belonged to either a human or a BOT
/// account; the safer default is "assume it was a human token" (the
/// most common case) -- the user can rotate it, or the account-verify
/// guard will surface a mismatch on first use if it was actually a BOT
/// token and the user tries to use it in human mode.
pub fn migrate_legacy_token() -> Result<bool, String> {
    let legacy = keyring_entry_for(KEYRING_USER_LEGACY)?;
    let existing = match legacy.get_password() {
        Ok(token) => token,
        Err(keyring::Error::NoEntry) => return Ok(false),
        Err(e) => return Err(format!("failed to read legacy token: {e}")),
    };
    // Do not overwrite an already-set human slot. If someone has set the
    // new slot explicitly, the legacy one is dead weight -- delete it.
    let human = keyring_entry_for(KEYRING_USER_HUMAN)?;
    let human_already_set = matches!(human.get_password(), Ok(_));
    if !human_already_set {
        human
            .set_password(&existing)
            .map_err(|e| format!("failed to write migrated human token: {e}"))?;
    }
    // Only delete the legacy entry after the human slot is confirmed
    // present -- either we just wrote it, or it was already there.
    let _ = legacy.delete_credential();
    Ok(true)
}

/// Per-slot cache of what `GET /api/account` returned last time we asked.
/// Populated on first use of each slot, invalidated on `lichess_token_set` /
/// `lichess_token_clear`. `Arc<Mutex<...>>` because multiple async command
/// tasks can concurrently want to check or populate it.
#[derive(Default)]
pub struct AccountCache {
    entries: Mutex<HashMap<TokenSlot, AccountInfo>>,
}

pub type SharedAccountCache = Arc<AccountCache>;

pub fn new_shared_account_cache() -> SharedAccountCache {
    Arc::new(AccountCache::default())
}

fn cache_lock(cache: &SharedAccountCache) -> Result<MutexGuard<'_, HashMap<TokenSlot, AccountInfo>>, String> {
    cache.entries.lock().map_err(|_| "account cache lock poisoned".to_string())
}

fn invalidate_account_cache(cache: &SharedAccountCache, slot: TokenSlot) {
    if let Ok(mut entries) = cache.entries.lock() {
        entries.remove(&slot);
    }
}

fn cache_get(cache: &SharedAccountCache, slot: TokenSlot) -> Option<AccountInfo> {
    cache_lock(cache).ok().and_then(|entries| entries.get(&slot).cloned())
}

fn cache_put(cache: &SharedAccountCache, slot: TokenSlot, info: AccountInfo) {
    if let Ok(mut entries) = cache.entries.lock() {
        entries.insert(slot, info);
    }
}

/// Live-fetches `/api/account` for the token in `slot` and returns the
/// account info the fair-play guard needs. Does *not* enforce that the
/// account type matches the slot -- that's `token_for_slot_verified`'s
/// job; separating them means the verify endpoint itself always succeeds
/// on a valid token regardless of which slot it's in (the caller then
/// gets to decide whether the account is a legal fit for that slot).
async fn fetch_account_info(client: &reqwest::Client, token: &str) -> Result<AccountInfo, String> {
    let response = client
        .get("https://lichess.org/api/account")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("lichess rejected the token (401 Unauthorized) -- rotate or re-enter it".to_string());
    }
    if !status.is_success() {
        return Err(format!("lichess returned {status} for /api/account"));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("failed to read lichess response: {e}"))?;
    parse_account_info(&body)
}

/// Frontend-parallel of the TS `parseAccountInfo` -- kept in Rust so
/// `token_for_slot_verified` doesn't need to serialize the JSON back to
/// the frontend to make its decision. Deliberately narrow: only the fields
/// the fair-play guard reads, and a strict-null for `title` reading (only
/// `"BOT"` counts as a bot; anything else, including missing, is not).
fn parse_account_info(body: &str) -> Result<AccountInfo, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("lichess sent unparseable /api/account body: {e}"))?;
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "lichess /api/account response is missing `id`".to_string())?
        .to_string();
    let username = value
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "lichess /api/account response is missing `username`".to_string())?
        .to_string();
    let is_bot = value.get("title").and_then(|v| v.as_str()) == Some("BOT");
    Ok(AccountInfo { id, username, is_bot })
}

/// Ensures the token in `slot` is set, corresponds to a real Lichess
/// account, and that account's type matches the slot's expected role.
/// Returns `(token_string, account_info)` so the caller doesn't need to
/// re-read the keychain for the actual request. Populates the account
/// cache on the way through, so subsequent calls are keychain-read +
/// mutex-hashmap-lookup, not another HTTP round-trip.
async fn token_for_slot_verified(
    slot: TokenSlot,
    account_cache: &SharedAccountCache,
) -> Result<(String, AccountInfo), String> {
    let token = token(slot)?;
    let info = match cache_get(account_cache, slot) {
        Some(info) => info,
        None => {
            let client = new_client()?;
            let fresh = fetch_account_info(&client, &token).await?;
            cache_put(account_cache, slot, fresh.clone());
            fresh
        }
    };
    enforce_slot_matches(slot, &info)?;
    Ok((token, info))
}

/// Fair-play guard, enforced at every request boundary: a BOT-slot request
/// must run under a BOT account and a Human-slot request must not. This
/// exists in code, not just in the UI, because the UI could be bypassed by
/// a malicious frontend build; the OS keychain and this guard are the two
/// non-bypassable enforcement points.
fn enforce_slot_matches(slot: TokenSlot, info: &AccountInfo) -> Result<(), String> {
    match (slot, info.is_bot) {
        (TokenSlot::Human, false) | (TokenSlot::Bot, true) => Ok(()),
        (TokenSlot::Human, true) => Err(format!(
            "the human slot's token belongs to a BOT account (\"{}\") -- \
             put it in the bot slot instead",
            info.username
        )),
        (TokenSlot::Bot, false) => Err(format!(
            "the bot slot's token belongs to a non-BOT account (\"{}\") -- \
             either use the human slot or upgrade this account to BOT",
            info.username
        )),
    }
}

/// Frontend-facing verify command. Populates the cache as a side effect.
/// Deliberately does *not* run `enforce_slot_matches`: the UI needs to be
/// able to *display* "this token is a BOT account, so put it in the bot
/// slot" without every verify call erroring out first.
#[tauri::command]
pub async fn lichess_verify_account(
    slot: TokenSlot,
    account_cache: State<'_, SharedAccountCache>,
) -> Result<AccountInfo, String> {
    let token = token(slot)?;
    let client = new_client()?;
    let info = fetch_account_info(&client, &token).await?;
    cache_put(&account_cache, slot, info.clone());
    Ok(info)
}

/// Runs the OAuth 2.0 + PKCE login flow for the given slot: opens a
/// browser tab to Lichess's authorize screen, catches the callback on
/// a loopback listener, exchanges the code for an access token, and
/// stores it in the same OS-keychain slot the PAT flow uses. Returns
/// the verified account info so the UI can immediately show "signed
/// in as X" without a separate follow-up call.
///
/// Slot-specific scopes: human gets `board:play`, bot gets `bot:play`
/// + `challenge:write` -- exactly what each mode's endpoints require,
/// no more. Do not widen without a specific need; a narrower token is
/// less dangerous if it later leaks.
///
/// The command holds an open TCP listener for up to
/// `CALLBACK_TIMEOUT` (5 minutes) while the user approves in the
/// browser. If they close the tab or take too long, the timeout
/// surfaces as an error and the port is released.
#[tauri::command]
pub async fn lichess_oauth_login(
    app: AppHandle,
    slot: TokenSlot,
    account_cache: State<'_, SharedAccountCache>,
) -> Result<AccountInfo, String> {
    use crate::lichess_oauth::{
        accept_callback, build_authorize_url, challenge_from_verifier, exchange_code_for_token,
        generate_state, generate_verifier, CALLBACK_TIMEOUT,
    };
    use tauri_plugin_opener::OpenerExt;

    let scopes: &[&str] = match slot {
        TokenSlot::Human => &["board:play"],
        TokenSlot::Bot => &["bot:play", "challenge:write"],
    };

    // PKCE material: generated on every login so a leaked previous
    // verifier can't replay against a fresh code, and vice versa.
    let verifier = generate_verifier();
    let challenge = challenge_from_verifier(&verifier);
    let expected_state = generate_state();

    // Bind before opening the browser -- if the bind fails, the user
    // never sees a stuck browser tab.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("failed to bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to read loopback port: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let authorize_url =
        build_authorize_url(&challenge, &expected_state, &redirect_uri, scopes)?;
    let _ = crate::debug_log::append(
        &app,
        &format!("[lichess-oauth] authorize on :{port} for {:?}", slot),
    );

    app.opener()
        .open_url(&authorize_url, None::<String>)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    // Bounded wait: the user might get distracted or fail Lichess's
    // login flow before approving. 5 minutes matches
    // `CALLBACK_TIMEOUT`.
    let params = tokio::time::timeout(
        CALLBACK_TIMEOUT,
        accept_callback(&listener, &expected_state),
    )
    .await
    .map_err(|_| {
        format!(
            "OAuth flow timed out after {}s -- click Sign in with Lichess again",
            CALLBACK_TIMEOUT.as_secs()
        )
    })??;

    // Trade the code for a token. Uses the shared one-shot client
    // (has a 30 s total timeout) so a hung token endpoint doesn't
    // deadlock the app.
    let client = new_client()?;
    let token = exchange_code_for_token(&client, &params.code, &verifier, &redirect_uri).await?;

    // Store just like the PAT flow does, and invalidate the account
    // cache so the follow-up verify reads through fresh. The
    // `enforce_slot_matches` guard runs at the next authenticated call
    // -- verify_account itself deliberately skips it so the UI can
    // display "this is a BOT account" for a token that's in the human
    // slot rather than silently erroring.
    keyring_entry(slot)?
        .set_password(&token)
        .map_err(|e| format!("failed to store OAuth token in OS keychain: {e}"))?;
    invalidate_account_cache(&account_cache, slot);

    let info = fetch_account_info(&client, &token).await?;
    cache_put(&account_cache, slot, info.clone());
    let _ = crate::debug_log::append(
        &app,
        &format!(
            "[lichess-oauth] signed in as {} (isBot={}) in slot {:?}",
            info.username, info.is_bot, slot
        ),
    );
    Ok(info)
}

/// Validates a single UCI move (e.g. `e2e4`, `e7e8q`) before it's spliced
/// into a request URL -- the same trust-boundary reasoning as
/// `parse_game_id`, just for the move half of the move-submission endpoint.
fn validate_uci_move(mv: &str) -> Result<(), String> {
    let bytes = mv.as_bytes();
    let is_square =
        |file: u8, rank: u8| (b'a'..=b'h').contains(&file) && (b'1'..=b'8').contains(&rank);
    let valid = match bytes.len() {
        4 => is_square(bytes[0], bytes[1]) && is_square(bytes[2], bytes[3]),
        5 => {
            is_square(bytes[0], bytes[1])
                && is_square(bytes[2], bytes[3])
                && matches!(bytes[4], b'q' | b'r' | b'b' | b'n')
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("\"{mv}\" is not a valid UCI move"))
    }
}

/// Which color the caller of a seek / challenge wants to play as. Lichess
/// accepts these three exact strings; anything else is a 400. Serde tag
/// validated at deserialize time, same shape as `TokenSlot` /
/// `LichessDeclineReason` -- a hostile frontend string can't reach the
/// request URL.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChallengeColor {
    Random,
    White,
    Black,
}

impl ChallengeColor {
    fn as_wire(self) -> &'static str {
        match self {
            ChallengeColor::Random => "random",
            ChallengeColor::White => "white",
            ChallengeColor::Black => "black",
        }
    }
}

/// Lichess Board API real-time seek limits (see the API reference at
/// <https://lichess.org/api#tag/Board/operation/apiBoardSeek>): base time
/// 0-180 minutes, increment 0-60 seconds. Enforced here so a bad UI
/// value can't produce a 400 the user has to interpret.
const MAX_TIME_MINUTES: u32 = 180;
const MAX_INCREMENT_SECONDS: u32 = 60;

fn validate_time_minutes(minutes: u32) -> Result<(), String> {
    if minutes > MAX_TIME_MINUTES {
        Err(format!(
            "time must be at most {MAX_TIME_MINUTES} minutes (got {minutes})"
        ))
    } else {
        Ok(())
    }
}

fn validate_increment_seconds(increment: u32) -> Result<(), String> {
    if increment > MAX_INCREMENT_SECONDS {
        Err(format!(
            "increment must be at most {MAX_INCREMENT_SECONDS} seconds (got {increment})"
        ))
    } else {
        Ok(())
    }
}

/// Lichess AI levels are 1-8 (Stockfish strength). Anything else is a
/// 400; kept as a `u8` range check rather than an enum since the level
/// varies over a small integer range that isn't meaningfully typed.
fn validate_ai_level(level: u8) -> Result<(), String> {
    if !(1..=8).contains(&level) {
        Err(format!("AI level must be 1-8 (got {level})"))
    } else {
        Ok(())
    }
}

/// Validates a Lichess username before it's spliced into a request URL --
/// same trust-boundary reasoning as `parse_game_id`/`validate_uci_move`.
/// Lichess usernames are 2-30 characters, start with a letter, and contain
/// only letters/digits/`_`/`-`.
fn validate_username(name: &str) -> Result<(), String> {
    let len_ok = (2..=30).contains(&name.chars().count());
    let starts_with_letter = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    let chars_ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if len_ok && starts_with_letter && chars_ok {
        Ok(())
    } else {
        Err(format!(
            "\"{name}\" doesn't look like a valid Lichess username"
        ))
    }
}

/// Fetches the PGN for a public game. No auth -- `/game/export/{id}` is a
/// public endpoint for any game that isn't private. Fails closed: a
/// non-success status or empty body is an `Err`, never a silently blank PGN.
async fn export_pgn(client: &reqwest::Client, game_id: &str) -> Result<String, String> {
    let url = format!("https://lichess.org/game/export/{game_id}");
    let response = client
        .get(&url)
        .header("Accept", "application/x-chess-pgn")
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("lichess returned {status} for game {game_id}"));
    }

    let pgn = response
        .text()
        .await
        .map_err(|e| format!("failed to read lichess response: {e}"))?;
    if pgn.trim().is_empty() {
        return Err(format!("lichess returned an empty PGN for game {game_id}"));
    }
    Ok(pgn)
}

#[tauri::command]
pub async fn lichess_export_pgn(game_id_or_url: String) -> Result<String, String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    // A fresh client per call is deliberate: this command fires on a manual
    // button click, not a hot path, so per-call connection setup cost is
    // irrelevant -- not worth a managed, pooled `.manage()` client for one
    // infrequent request.
    let client = new_client()?;
    export_pgn(&client, &game_id).await
}

/// One live Lichess game connection at a time -- a human plays one game at
/// a time in this app, so unlike `engine.rs`'s two independent slots there's
/// only ever one stream task to track.
#[derive(Default)]
pub struct LichessGameState {
    stream_task: Option<JoinHandle<()>>,
}

pub type SharedLichessState = Arc<Mutex<LichessGameState>>;

pub fn new_shared_lichess_state() -> SharedLichessState {
    Arc::new(Mutex::new(LichessGameState::default()))
}

pub struct LichessConnection(pub SharedLichessState);

fn lock(state: &SharedLichessState) -> Result<MutexGuard<'_, LichessGameState>, String> {
    state
        .lock()
        .map_err(|_| "lichess state lock poisoned".to_string())
}

/// Aborts whatever stream is currently running, if any. Safe to call when
/// nothing is running (a no-op) -- same shape as `engine.rs`'s
/// `stop_locked`, just aborting a tokio task instead of killing a process.
fn stop_stream_locked(state: &SharedLichessState) -> Result<(), String> {
    let task = lock(state)?.stream_task.take();
    if let Some(task) = task {
        task.abort();
    }
    Ok(())
}

/// Whether the pump exited on a recoverable condition (reconnect) or an
/// unrecoverable one (give up). The retry loop reads this to decide
/// whether to sleep-and-retry or emit `exit_event` and stop.
enum PumpOutcome {
    /// Stream ended, timed out, or errored -- worth reconnecting.
    Retry(String),
    /// Structural failure the caller shouldn't retry through (e.g. an
    /// impossible-state guard). Unused today but kept as a shape so a
    /// future addition can escape the retry loop deliberately.
    #[allow(dead_code)]
    GiveUp(String),
}

/// Reads an NDJSON response body, emitting one Tauri event per complete
/// line. Returns when the stream ends, errors, or goes silent for
/// `STREAM_KEEPALIVE_TIMEOUT`. The caller decides whether to retry or
/// bubble up as a final exit -- see `stream_with_reconnect`.
///
/// Pre-PR-6 this decoded each chunk with `from_utf8_lossy` before
/// splitting; that corrupted any multi-byte UTF-8 codepoint that
/// happened to straddle a chunk boundary. Now the buffer is bytes and
/// UTF-8 decoding happens per whole line (see `pop_lines`).
async fn pump_ndjson_stream(
    app: AppHandle,
    response: reqwest::Response,
    line_event: &'static str,
    schedule: &mut RetrySchedule,
) -> PumpOutcome {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    // Any complete line at all resets the backoff schedule -- a stream
    // that produced any real data before dying gets a fresh fast retry.
    let mut got_any_line = false;
    loop {
        match tokio::time::timeout(STREAM_KEEPALIVE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                buffer.extend_from_slice(&chunk);
                for line in pop_lines(&mut buffer) {
                    got_any_line = true;
                    let _ = app.emit(line_event, line);
                }
            }
            Ok(Some(Err(e))) => {
                if got_any_line {
                    schedule.reset();
                }
                return PumpOutcome::Retry(format!("stream error: {e}"));
            }
            Ok(None) => {
                if got_any_line {
                    schedule.reset();
                }
                return PumpOutcome::Retry("stream closed".to_string());
            }
            Err(_elapsed) => {
                if got_any_line {
                    schedule.reset();
                }
                return PumpOutcome::Retry(format!(
                    "no data for {}s -- assumed dead",
                    STREAM_KEEPALIVE_TIMEOUT.as_secs()
                ));
            }
        }
    }
}

/// Wraps the GET-a-stream-then-pump loop with exponential-backoff
/// reconnect. Every drop (EOF, timeout, network error) sleeps for the
/// current backoff and retries the request. `exit_event` only fires
/// on an unrecoverable HTTP status (401, 404, ...) or a `GiveUp`
/// outcome; transient failures stay silent and the frontend sees no
/// event -- movesToApply / applyDerivedControllers are idempotent so
/// a reconnect just re-syncs from `gameFull`.
async fn stream_with_reconnect<F>(
    app: AppHandle,
    mut make_request: F,
    line_event: &'static str,
    exit_event: &'static str,
) where
    F: FnMut() -> reqwest::RequestBuilder + Send + 'static,
{
    let mut schedule = RetrySchedule::new();
    loop {
        let request = make_request();
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    let _ = crate::debug_log::append(
                        &app,
                        &format!(
                            "[lichess] stream 429; pausing {}s",
                            RATE_LIMIT_PAUSE.as_secs()
                        ),
                    );
                    tokio::time::sleep(RATE_LIMIT_PAUSE).await;
                    continue;
                }
                if !status.is_success() {
                    // 401/403 mean the token was revoked; 404 means
                    // the game is gone; other 4xx/5xx are similarly
                    // fatal for this stream. Retry wouldn't help --
                    // surface as an exit so the frontend can fail
                    // the connection cleanly.
                    let _ = app.emit(
                        exit_event,
                        format!("lichess returned {status}"),
                    );
                    return;
                }
                match pump_ndjson_stream(app.clone(), response, line_event, &mut schedule).await {
                    PumpOutcome::Retry(reason) => {
                        // Sleep-and-retry silently. Log to debug.log
                        // so a stuck reconnect loop is diagnosable
                        // after the fact, but don't emit an exit --
                        // the frontend's movesToApply/
                        // applyDerivedControllers are idempotent so a
                        // reconnect just re-syncs from the fresh
                        // gameFull.
                        let _ = crate::debug_log::append(
                            &app,
                            &format!("[lichess] stream ended: {reason}; reconnecting"),
                        );
                    }
                    PumpOutcome::GiveUp(reason) => {
                        let _ = app.emit(exit_event, reason);
                        return;
                    }
                }
            }
            Err(e) => {
                // Network error before headers even arrived -- same
                // recovery as a mid-stream drop.
                let _ = crate::debug_log::append(
                    &app,
                    &format!("[lichess] stream connect failed: {e}; retrying"),
                );
            }
        }
        tokio::time::sleep(schedule.next()).await;
    }
}

fn new_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("chess-board (https://github.com/jedi-knights/chess-board)")
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(ONESHOT_TIMEOUT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

/// Client for streaming requests -- has the same connect timeout as the
/// one-shot client but no *total* timeout, because streams stay open
/// indefinitely. The 20 s idle-timeout inside `pump_ndjson_stream`
/// handles half-open connections instead.
fn new_stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("chess-board (https://github.com/jedi-knights/chess-board)")
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

/// Sends a one-shot authenticated POST through the outbound serialization
/// mutex, with a single 60 s retry on 429. Returns the successful
/// response, or a formatted error on network failure or a non-success
/// status. Every POST-making command should route through this rather
/// than calling `.send()` directly, so a burst can't race itself into
/// a 429 unnecessarily.
async fn post_with_retry(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let _guard = outbound_mutex().lock().await;
    let clone = request
        .try_clone()
        .ok_or_else(|| "internal: request not cloneable for retry".to_string())?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;
    if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Ok(response);
    }
    // 429 -- honor Lichess's stated 60 s pause and try one more time.
    // Holding the outbound mutex through the sleep blocks *other*
    // POSTs from also getting 429'd during the pause window.
    tokio::time::sleep(RATE_LIMIT_PAUSE).await;
    clone
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess after 429 pause: {e}"))
}

/// Shared body of `lichess_stream_game`/`lichess_bot_stream_game` -- `kind`
/// is `"board"` or `"bot"`, the only difference in the request Lichess sees.
/// Board- and bot-mode game streams share the same connection slot: this
/// app plays either as a human (Board API) or runs a bot loop (Bot API) at
/// any given moment, never both, so there's only ever one active game
/// stream to track regardless of which mode started it.
/// The `slot` argument is *not* taken from JS: the caller passes it as a
/// hardcoded constant matching the endpoint's `kind` (Human for `board`,
/// Bot for `bot`). Slot selection at the HTTP boundary is a code-level
/// invariant, not a JS parameter, so a compromised frontend can't ask the
/// human token to stream through the bot API or vice versa.
async fn stream_game_impl(
    app: AppHandle,
    shared: SharedLichessState,
    account_cache: SharedAccountCache,
    game_id_or_url: String,
    slot: TokenSlot,
    kind: &str,
    line_event: &'static str,
    exit_event: &'static str,
) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    let (token, _) = token_for_slot_verified(slot, &account_cache).await?;
    // Never leak a previous stream task if the user connects to a new game
    // without explicitly disconnecting first.
    stop_stream_locked(&shared)?;

    let client = new_stream_client()?;
    let url = format!("https://lichess.org/api/{kind}/game/stream/{game_id}");

    // Spawn the reconnect loop directly. The initial GET is inside
    // `stream_with_reconnect`, so this command returns immediately once
    // the task is queued. A first-attempt failure (network unreachable,
    // stale DNS) becomes a retry, not a returned error -- matches how
    // the reconnect model works for subsequent drops.
    let make_request = move || {
        client
            .get(&url)
            .bearer_auth(&token)
    };
    let task = tokio::spawn(async move {
        stream_with_reconnect(app, make_request, line_event, exit_event).await;
    });
    lock(&shared)?.stream_task = Some(task);
    Ok(())
}

#[tauri::command]
pub async fn lichess_stream_game(
    app: AppHandle,
    state: State<'_, LichessConnection>,
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    stream_game_impl(
        app,
        state.0.clone(),
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Human,
        "board",
        "lichess-game-stream",
        "lichess-game-exit",
    )
    .await
}

#[tauri::command]
pub async fn lichess_bot_stream_game(
    app: AppHandle,
    state: State<'_, LichessConnection>,
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    stream_game_impl(
        app,
        state.0.clone(),
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Bot,
        "bot",
        "lichess-bot-game-stream",
        "lichess-bot-game-exit",
    )
    .await
}

#[tauri::command]
pub fn lichess_stop_game(state: State<'_, LichessConnection>) -> Result<(), String> {
    stop_stream_locked(&state.0)
}

/// Shared body of `lichess_make_move`/`lichess_bot_make_move` -- same
/// slot-hardcoded-at-caller reasoning as `stream_game_impl`.
async fn make_move_impl(
    account_cache: SharedAccountCache,
    game_id_or_url: String,
    uci_move: String,
    slot: TokenSlot,
    kind: &str,
) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    validate_uci_move(&uci_move)?;
    let (token, _) = token_for_slot_verified(slot, &account_cache).await?;

    let client = new_client()?;
    let url = format!("https://lichess.org/api/{kind}/game/{game_id}/move/{uci_move}");
    let response = post_with_retry(client.post(&url).bearer_auth(&token)).await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("lichess rejected move {uci_move}: {status} {body}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn lichess_make_move(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
    uci_move: String,
) -> Result<(), String> {
    make_move_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        uci_move,
        TokenSlot::Human,
        "board",
    )
    .await
}

#[tauri::command]
pub async fn lichess_bot_make_move(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
    uci_move: String,
) -> Result<(), String> {
    make_move_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        uci_move,
        TokenSlot::Bot,
        "bot",
    )
    .await
}

/// The account-wide event stream (incoming challenges, game starts) is a
/// separate, independent connection from any specific game's move stream --
/// it needs to keep running while listening for the *next* challenge even
/// while a game is in progress, so it gets its own connection slot/type
/// rather than sharing `LichessConnection`.
pub struct LichessEventConnection(pub SharedLichessState);

#[tauri::command]
pub async fn lichess_stream_events(
    app: AppHandle,
    state: State<'_, LichessEventConnection>,
    account_cache: State<'_, SharedAccountCache>,
    slot: TokenSlot,
) -> Result<(), String> {
    // Both modes' account event streams -- human seek + challenge inbox,
    // bot challenge inbox -- run over `/api/stream/event`, so the slot is
    // a real caller-supplied parameter here (still validated against the
    // `TokenSlot` enum by serde). See `TokenSlot`'s doc comment.
    let (token, _) = token_for_slot_verified(slot, &account_cache).await?;
    let shared = state.0.clone();
    stop_stream_locked(&shared)?;

    let client = new_stream_client()?;
    let make_request = move || {
        client
            .get("https://lichess.org/api/stream/event")
            .bearer_auth(&token)
    };
    let task = tokio::spawn(async move {
        stream_with_reconnect(
            app,
            make_request,
            "lichess-event-stream",
            "lichess-event-exit",
        )
        .await;
    });
    lock(&shared)?.stream_task = Some(task);
    Ok(())
}

#[tauri::command]
pub fn lichess_stop_events(state: State<'_, LichessEventConnection>) -> Result<(), String> {
    stop_stream_locked(&state.0)
}

/// Decline reasons Lichess accepts on `POST /api/challenge/{id}/decline`.
/// Exactly this set -- anything else is a 400. Kept as a serde enum so a
/// stray string from the frontend is rejected at deserialize time, same
/// pattern as `TokenSlot`.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum LichessDeclineReason {
    #[serde(rename = "generic")]
    Generic,
    #[serde(rename = "later")]
    Later,
    #[serde(rename = "tooFast")]
    TooFast,
    #[serde(rename = "tooSlow")]
    TooSlow,
    #[serde(rename = "timeControl")]
    TimeControl,
    #[serde(rename = "rated")]
    Rated,
    #[serde(rename = "casual")]
    Casual,
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "variant")]
    Variant,
    #[serde(rename = "noBot")]
    NoBot,
    #[serde(rename = "onlyBot")]
    OnlyBot,
}

impl LichessDeclineReason {
    fn as_wire(self) -> &'static str {
        match self {
            LichessDeclineReason::Generic => "generic",
            LichessDeclineReason::Later => "later",
            LichessDeclineReason::TooFast => "tooFast",
            LichessDeclineReason::TooSlow => "tooSlow",
            LichessDeclineReason::TimeControl => "timeControl",
            LichessDeclineReason::Rated => "rated",
            LichessDeclineReason::Casual => "casual",
            LichessDeclineReason::Standard => "standard",
            LichessDeclineReason::Variant => "variant",
            LichessDeclineReason::NoBot => "noBot",
            LichessDeclineReason::OnlyBot => "onlyBot",
        }
    }
}

#[tauri::command]
pub async fn lichess_challenge_decline(
    account_cache: State<'_, SharedAccountCache>,
    slot: TokenSlot,
    challenge_id: String,
    reason: LichessDeclineReason,
) -> Result<(), String> {
    let id = parse_game_id(&challenge_id)?;
    let (token, _) = token_for_slot_verified(slot, &account_cache).await?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/challenge/{id}/decline");
    let response = post_with_retry(
        client
            .post(&url)
            .bearer_auth(&token)
            .form(&[("reason", reason.as_wire())]),
    )
    .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected declining challenge {id}: {status} {body}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn lichess_challenge_accept(
    account_cache: State<'_, SharedAccountCache>,
    slot: TokenSlot,
    challenge_id: String,
) -> Result<(), String> {
    // Challenge ids share the exact same 8-char alphanumeric shape as game
    // ids -- reusing the validator here is deliberate, not a coincidence.
    let id = parse_game_id(&challenge_id)?;
    let (token, _) = token_for_slot_verified(slot, &account_cache).await?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/challenge/{id}/accept");
    let response = post_with_retry(client.post(&url).bearer_auth(&token)).await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected accepting challenge {id}: {status} {body}"
        ));
    }
    Ok(())
}

/// Irreversible on Lichess's side: a bot account can never play rated
/// games as a human again, nor be converted back. The frontend gates this
/// behind an explicit, separately-confirmed action -- never bundle it into
/// "start listening for challenges".
///
/// This is the *one* command that reads the Bot slot without the standard
/// `enforce_slot_matches` guard: an account that has just been created and
/// is *about* to be upgraded is by definition not yet a BOT, so requiring
/// `is_bot == true` before upgrade is impossible. Bypass here is safe
/// because the endpoint's whole purpose is to *make* the account a bot;
/// we still read the bot slot's own token (never the human's) so a
/// misclick can't accidentally upgrade a real human's account.
#[tauri::command]
pub async fn lichess_bot_upgrade(
    account_cache: State<'_, SharedAccountCache>,
) -> Result<(), String> {
    let token = token(TokenSlot::Bot)?;
    let client = new_client()?;
    let response = post_with_retry(
        client
            .post("https://lichess.org/api/bot/account/upgrade")
            .bearer_auth(&token),
    )
    .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected the bot upgrade request: {status} {body}"
        ));
    }
    // After a successful upgrade, the cached account (if any) is stale --
    // the same account is now a BOT, which the next verify call must
    // reflect. Drop it so the guard doesn't keep refusing bot-slot calls
    // based on the pre-upgrade `is_bot: false` snapshot.
    invalidate_account_cache(&account_cache, TokenSlot::Bot);
    Ok(())
}

/// Caps how many online bots a single `lichess_bot_online` call can ask
/// for -- bounded regardless of what the caller passes, per the
/// "every loop/request over external-shaped input needs a named cap" rule.
/// Lichess enforces its own ceiling server-side too; this is this app's
/// own independent bound, not a guess at theirs.
const MAX_BOTS_LISTED: u32 = 200;

/// Lists currently-online Bot accounts. Public endpoint, no auth needed --
/// same as `export_pgn`, this hands the raw NDJSON body straight back
/// rather than parsing it; `src/lib/lichess.ts`'s `parseBotOnlineList` is
/// the one seam that understands the shape of each line.
#[tauri::command]
pub async fn lichess_bot_online(nb: Option<u32>) -> Result<String, String> {
    let limit = nb.unwrap_or(50).min(MAX_BOTS_LISTED);
    let client = new_client()?;
    let url = format!("https://lichess.org/api/bot/online?nb={limit}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("lichess returned {status} listing online bots"));
    }
    response
        .text()
        .await
        .map_err(|e| format!("failed to read lichess response: {e}"))
}

/// Challenges a bot account to a real-time game. Always unrated -- this is
/// for testing an engine, not chasing a rating, and keeping it non-
/// configurable here avoids a second surface (a rated toggle) for a
/// consequence (permanently affecting someone's rating) this tool has no
/// business opting a user into by default.
#[tauri::command]
pub async fn lichess_challenge_bot(
    account_cache: State<'_, SharedAccountCache>,
    username: String,
    clock_limit_seconds: u32,
    clock_increment_seconds: u32,
    color: String,
) -> Result<(), String> {
    validate_username(&username)?;
    if !matches!(color.as_str(), "random" | "white" | "black") {
        return Err(format!("\"{color}\" is not a valid color"));
    }
    // The *bot* slot challenges another bot -- this is the "engine on my
    // BOT account challenges another bot" flow from the pre-PR-4 UI, not
    // a human challenging a bot (PR 4 adds `lichess_challenge_user` for
    // the human-mode counterpart).
    let (token, _) = token_for_slot_verified(TokenSlot::Bot, &account_cache).await?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/challenge/{username}");
    let response = post_with_retry(
        client
            .post(&url)
            .bearer_auth(&token)
            .form(&[
                ("rated", "false"),
                ("clock.limit", &clock_limit_seconds.to_string()),
                ("clock.increment", &clock_increment_seconds.to_string()),
                ("color", &color),
                ("variant", "standard"),
            ]),
    )
    .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected the challenge to {username}: {status} {body}"
        ));
    }
    Ok(())
}

/// Human-mode counterpart to `lichess_challenge_bot`: the human's *own*
/// account challenges another user (bot or human). Rated is a param
/// here rather than hardcoded false, since a human account legitimately
/// plays rated games -- the "rated affects ratings" concern that made
/// `lichess_challenge_bot` unrated-only doesn't apply here (a human is
/// already the one whose rating moves).
#[tauri::command]
pub async fn lichess_challenge_user(
    account_cache: State<'_, SharedAccountCache>,
    username: String,
    minutes: u32,
    increment: u32,
    rated: bool,
    color: ChallengeColor,
) -> Result<(), String> {
    validate_username(&username)?;
    validate_time_minutes(minutes)?;
    validate_increment_seconds(increment)?;
    let (token, _) = token_for_slot_verified(TokenSlot::Human, &account_cache).await?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/challenge/{username}");
    let clock_limit = (minutes * 60).to_string();
    let clock_increment = increment.to_string();
    let response = post_with_retry(
        client
            .post(&url)
            .bearer_auth(&token)
            .form(&[
                ("variant", "standard"),
                ("rated", if rated { "true" } else { "false" }),
                ("color", color.as_wire()),
                ("clock.limit", clock_limit.as_str()),
                ("clock.increment", clock_increment.as_str()),
            ]),
    )
    .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected the challenge to {username}: {status} {body}"
        ));
    }
    Ok(())
}

/// Challenges Lichess's stock Stockfish AI at the given level (1-8).
/// AI challenges are always casual (a Lichess policy, not this app's),
/// so no `rated` parameter. The AI accepts immediately, and the account
/// event stream fires `gameStart` for the frontend to auto-connect.
#[tauri::command]
pub async fn lichess_challenge_ai(
    account_cache: State<'_, SharedAccountCache>,
    level: u8,
    minutes: u32,
    increment: u32,
    color: ChallengeColor,
) -> Result<(), String> {
    validate_ai_level(level)?;
    validate_time_minutes(minutes)?;
    validate_increment_seconds(increment)?;
    let (token, _) = token_for_slot_verified(TokenSlot::Human, &account_cache).await?;
    let client = new_client()?;
    let level_str = level.to_string();
    let clock_limit = (minutes * 60).to_string();
    let clock_increment = increment.to_string();
    let response = post_with_retry(
        client
            .post("https://lichess.org/api/challenge/ai")
            .bearer_auth(&token)
            .form(&[
                ("variant", "standard"),
                ("color", color.as_wire()),
                ("level", level_str.as_str()),
                ("clock.limit", clock_limit.as_str()),
                ("clock.increment", clock_increment.as_str()),
            ]),
    )
    .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("lichess rejected the AI challenge: {status} {body}"));
    }
    Ok(())
}

/// Board API seek. Unlike a challenge, this keeps the HTTP request open
/// on the server side until a match is found (or the client cancels).
/// The `LichessSeekConnection` slot exists so `lichess_stop_seek` can
/// abort it independently of any subsequent game stream -- otherwise a
/// user hitting "Cancel seek" would tear down whatever stream happened
/// to occupy the shared `LichessConnection` slot.
///
/// When a match is made, Lichess emits `gameStart` on the account event
/// stream (which the frontend event bus routes to
/// `lichessStore.handleAccountEvent`). This task then naturally ends as
/// the server closes the seek connection.
pub struct LichessSeekConnection(pub SharedLichessState);

#[tauri::command]
pub async fn lichess_seek(
    state: State<'_, LichessSeekConnection>,
    account_cache: State<'_, SharedAccountCache>,
    minutes: u32,
    increment: u32,
    rated: bool,
    color: ChallengeColor,
) -> Result<(), String> {
    validate_time_minutes(minutes)?;
    validate_increment_seconds(increment)?;
    let (token, _) = token_for_slot_verified(TokenSlot::Human, &account_cache).await?;
    let shared = state.0.clone();
    stop_stream_locked(&shared)?;

    let client = new_client()?;
    let time_str = minutes.to_string();
    let increment_str = increment.to_string();
    let task = tokio::spawn(async move {
        let response = client
            .post("https://lichess.org/api/board/seek")
            .bearer_auth(&token)
            .form(&[
                ("variant", "standard"),
                ("rated", if rated { "true" } else { "false" }),
                ("color", color.as_wire()),
                ("time", time_str.as_str()),
                ("increment", increment_str.as_str()),
            ])
            .send()
            .await;
        // The response body is empty on match; the connection stays open
        // until then. Read the body to hold the request in flight; when
        // the task is aborted (Cancel seek) or the server closes (matched),
        // this returns and the task ends. Errors here are informational --
        // the account event stream is the source of truth for gameStart.
        if let Ok(response) = response {
            let _ = response.bytes().await;
        }
    });
    lock(&shared)?.stream_task = Some(task);
    Ok(())
}

#[tauri::command]
pub fn lichess_stop_seek(state: State<'_, LichessSeekConnection>) -> Result<(), String> {
    stop_stream_locked(&state.0)
}

/// Shared body of the in-game action commands (resign / abort / draw /
/// claim-victory). `kind` picks the API surface (`"board"` for the
/// human-slot commands, `"bot"` for the bot-slot commands) and `action`
/// is the path segment appended after `/{game_id}/` (e.g. `"resign"`,
/// `"draw/yes"`). The `slot` is a hardcoded constant at every call site --
/// never a JS-supplied parameter -- so a compromised frontend can't ask
/// the wrong token to POST to the wrong API surface.
async fn game_action_impl(
    account_cache: SharedAccountCache,
    game_id_or_url: String,
    slot: TokenSlot,
    kind: &str,
    action: &str,
) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    let (token, _) = token_for_slot_verified(slot, &account_cache).await?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/{kind}/game/{game_id}/{action}");
    let response = post_with_retry(client.post(&url).bearer_auth(&token)).await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected {action} on game {game_id}: {status} {body}"
        ));
    }
    Ok(())
}

// ---------- Board API in-game actions (Human slot) ----------

#[tauri::command]
pub async fn lichess_resign(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Human,
        "board",
        "resign",
    )
    .await
}

#[tauri::command]
pub async fn lichess_abort(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Human,
        "board",
        "abort",
    )
    .await
}

/// Offer or agree to a draw (`accept: true` -> `/draw/yes`); or decline
/// the opponent's pending offer (`accept: false` -> `/draw/no`).
/// Lichess treats `/draw/yes` as *both* "offer" and "accept" depending
/// on whether an opponent's offer is already pending, so this app
/// deliberately does not maintain two separate offer/accept endpoints.
#[tauri::command]
pub async fn lichess_draw(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
    accept: bool,
) -> Result<(), String> {
    let action = if accept { "draw/yes" } else { "draw/no" };
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Human,
        "board",
        action,
    )
    .await
}

#[tauri::command]
pub async fn lichess_claim_victory(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Human,
        "board",
        "claim-victory",
    )
    .await
}

// ---------- Bot API in-game actions (Bot slot) ----------

#[tauri::command]
pub async fn lichess_bot_resign(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Bot,
        "bot",
        "resign",
    )
    .await
}

#[tauri::command]
pub async fn lichess_bot_abort(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Bot,
        "bot",
        "abort",
    )
    .await
}

#[tauri::command]
pub async fn lichess_bot_draw(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
    accept: bool,
) -> Result<(), String> {
    let action = if accept { "draw/yes" } else { "draw/no" };
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Bot,
        "bot",
        action,
    )
    .await
}

#[tauri::command]
pub async fn lichess_bot_claim_victory(
    account_cache: State<'_, SharedAccountCache>,
    game_id_or_url: String,
) -> Result<(), String> {
    game_action_impl(
        account_cache.inner().clone(),
        game_id_or_url,
        TokenSlot::Bot,
        "bot",
        "claim-victory",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_bare_game_id() {
        assert_eq!(parse_game_id("abcd1234"), Ok("abcd1234".to_string()));
    }

    #[test]
    fn accepts_a_bare_game_id_with_surrounding_whitespace() {
        assert_eq!(parse_game_id("  abcd1234  "), Ok("abcd1234".to_string()));
    }

    #[test]
    fn accepts_a_full_game_url() {
        assert_eq!(
            parse_game_id("https://lichess.org/abcd1234"),
            Ok("abcd1234".to_string())
        );
    }

    #[test]
    fn accepts_a_game_url_with_a_color_suffix() {
        assert_eq!(
            parse_game_id("https://lichess.org/abcd1234/black"),
            Ok("abcd1234".to_string())
        );
    }

    #[test]
    fn accepts_a_game_url_with_a_trailing_slash() {
        assert_eq!(
            parse_game_id("https://lichess.org/abcd1234/"),
            Ok("abcd1234".to_string())
        );
    }

    #[test]
    fn strips_a_query_string() {
        assert_eq!(
            parse_game_id("https://lichess.org/abcd1234?foo=bar"),
            Ok("abcd1234".to_string())
        );
    }

    #[test]
    fn rejects_an_empty_input() {
        assert!(parse_game_id("").is_err());
        assert!(parse_game_id("   ").is_err());
    }

    #[test]
    fn rejects_an_id_that_is_too_short() {
        assert!(parse_game_id("abc123").is_err());
    }

    #[test]
    fn rejects_non_alphanumeric_characters() {
        assert!(parse_game_id("abcd-123").is_err());
    }

    #[test]
    fn accepts_a_plain_move() {
        assert!(validate_uci_move("e2e4").is_ok());
    }

    #[test]
    fn accepts_a_promotion_move() {
        assert!(validate_uci_move("e7e8q").is_ok());
        assert!(validate_uci_move("e7e8r").is_ok());
        assert!(validate_uci_move("e7e8b").is_ok());
        assert!(validate_uci_move("e7e8n").is_ok());
    }

    #[test]
    fn rejects_a_move_with_an_invalid_promotion_piece() {
        assert!(validate_uci_move("e7e8k").is_err());
    }

    #[test]
    fn rejects_squares_out_of_range() {
        assert!(validate_uci_move("i2e4").is_err());
        assert!(validate_uci_move("e9e4").is_err());
    }

    #[test]
    fn rejects_the_wrong_length() {
        assert!(validate_uci_move("e2e").is_err());
        assert!(validate_uci_move("e2e444").is_err());
    }

    #[test]
    fn rejects_an_injection_attempt_disguised_as_a_move() {
        assert!(validate_uci_move("e2e4; rm -rf").is_err());
    }

    #[test]
    fn stopping_a_stream_with_none_running_is_a_safe_no_op() {
        let state = new_shared_lichess_state();
        assert!(stop_stream_locked(&state).is_ok());
    }

    #[test]
    fn accepts_a_typical_username() {
        assert!(validate_username("maia1").is_ok());
        assert!(validate_username("Some_Bot-9").is_ok());
    }

    #[test]
    fn rejects_a_username_that_is_too_short() {
        assert!(validate_username("a").is_err());
    }

    #[test]
    fn rejects_a_username_that_is_too_long() {
        assert!(validate_username(&"a".repeat(31)).is_err());
    }

    #[test]
    fn rejects_a_username_not_starting_with_a_letter() {
        assert!(validate_username("1bot").is_err());
        assert!(validate_username("_bot").is_err());
    }

    #[test]
    fn rejects_an_injection_attempt_disguised_as_a_username() {
        assert!(validate_username("bot/../../etc").is_err());
        assert!(validate_username("bot; rm -rf").is_err());
    }

    #[test]
    fn keyring_user_maps_each_slot_to_its_distinct_entry() {
        assert_eq!(keyring_user(TokenSlot::Human), "lichess-human-token");
        assert_eq!(keyring_user(TokenSlot::Bot), "lichess-bot-token");
        assert_ne!(keyring_user(TokenSlot::Human), keyring_user(TokenSlot::Bot));
    }

    #[test]
    fn token_slot_deserializes_from_the_lowercase_tags_the_frontend_sends() {
        let human: TokenSlot = serde_json::from_str("\"human\"").expect("human should parse");
        let bot: TokenSlot = serde_json::from_str("\"bot\"").expect("bot should parse");
        assert_eq!(human, TokenSlot::Human);
        assert_eq!(bot, TokenSlot::Bot);
    }

    #[test]
    fn token_slot_rejects_anything_else_the_frontend_might_send() {
        // Belt-and-braces: even if a compromised frontend sent an arbitrary
        // string here, serde's enum tag rejects it before it can reach the
        // keychain. Same guarantee `parse_game_id` / `validate_uci_move`
        // give for the URL-embedded parameters.
        assert!(serde_json::from_str::<TokenSlot>("\"admin\"").is_err());
        assert!(serde_json::from_str::<TokenSlot>("\"\"").is_err());
        assert!(serde_json::from_str::<TokenSlot>("null").is_err());
    }

    #[test]
    fn parse_account_info_extracts_id_username_and_bot_title() {
        let body = r#"{"id":"maia1","username":"maia1","title":"BOT","perfs":{}}"#;
        let info = parse_account_info(body).expect("valid account body");
        assert_eq!(info.id, "maia1");
        assert_eq!(info.username, "maia1");
        assert!(info.is_bot);
    }

    #[test]
    fn parse_account_info_treats_a_missing_title_as_not_a_bot() {
        let body = r#"{"id":"alice","username":"Alice"}"#;
        let info = parse_account_info(body).expect("valid account body");
        assert!(!info.is_bot);
    }

    #[test]
    fn parse_account_info_treats_a_non_bot_title_as_not_a_bot() {
        // Fair-play matters: an IM/GM/FM account is *not* a bot for the
        // slot-matching guard's purposes.
        let body = r#"{"id":"gmalice","username":"GMAlice","title":"GM"}"#;
        let info = parse_account_info(body).expect("valid account body");
        assert!(!info.is_bot);
    }

    #[test]
    fn parse_account_info_fails_closed_on_missing_id_or_username() {
        assert!(parse_account_info(r#"{"username":"x"}"#).is_err());
        assert!(parse_account_info(r#"{"id":"x"}"#).is_err());
        assert!(parse_account_info("not json").is_err());
    }

    #[test]
    fn enforce_slot_matches_accepts_a_correct_pairing() {
        let human = AccountInfo { id: "a".into(), username: "a".into(), is_bot: false };
        let bot = AccountInfo { id: "b".into(), username: "b".into(), is_bot: true };
        assert!(enforce_slot_matches(TokenSlot::Human, &human).is_ok());
        assert!(enforce_slot_matches(TokenSlot::Bot, &bot).is_ok());
    }

    #[test]
    fn enforce_slot_matches_rejects_a_bot_account_on_the_human_slot() {
        let bot = AccountInfo { id: "b".into(), username: "b".into(), is_bot: true };
        let err = enforce_slot_matches(TokenSlot::Human, &bot).unwrap_err();
        assert!(err.contains("BOT account"));
        assert!(err.contains("bot slot"));
    }

    #[test]
    fn enforce_slot_matches_rejects_a_non_bot_account_on_the_bot_slot() {
        let human = AccountInfo { id: "a".into(), username: "a".into(), is_bot: false };
        let err = enforce_slot_matches(TokenSlot::Bot, &human).unwrap_err();
        assert!(err.contains("non-BOT account"));
    }

    #[test]
    fn account_cache_stores_and_retrieves_per_slot() {
        let cache = new_shared_account_cache();
        let human = AccountInfo { id: "h".into(), username: "H".into(), is_bot: false };
        let bot = AccountInfo { id: "b".into(), username: "B".into(), is_bot: true };
        cache_put(&cache, TokenSlot::Human, human.clone());
        cache_put(&cache, TokenSlot::Bot, bot.clone());
        assert_eq!(cache_get(&cache, TokenSlot::Human).unwrap().username, "H");
        assert_eq!(cache_get(&cache, TokenSlot::Bot).unwrap().username, "B");
    }

    #[test]
    fn decline_reason_deserializes_from_the_exact_wire_tags_lichess_accepts() {
        // Lichess rejects any other value with a 400 -- serde's enum tags
        // are what guarantee a stray frontend string never reaches the API.
        assert_eq!(
            serde_json::from_str::<LichessDeclineReason>("\"variant\"").unwrap(),
            LichessDeclineReason::Variant,
        );
        assert_eq!(
            serde_json::from_str::<LichessDeclineReason>("\"timeControl\"").unwrap(),
            LichessDeclineReason::TimeControl,
        );
        assert_eq!(
            serde_json::from_str::<LichessDeclineReason>("\"later\"").unwrap(),
            LichessDeclineReason::Later,
        );
        assert_eq!(
            serde_json::from_str::<LichessDeclineReason>("\"rated\"").unwrap(),
            LichessDeclineReason::Rated,
        );
        assert_eq!(
            serde_json::from_str::<LichessDeclineReason>("\"generic\"").unwrap(),
            LichessDeclineReason::Generic,
        );
    }

    #[test]
    fn decline_reason_rejects_anything_else() {
        assert!(serde_json::from_str::<LichessDeclineReason>("\"unknown\"").is_err());
        assert!(serde_json::from_str::<LichessDeclineReason>("\"\"").is_err());
        assert!(serde_json::from_str::<LichessDeclineReason>("null").is_err());
    }

    #[test]
    fn decline_reason_wire_string_roundtrips_through_deserialize() {
        // Guards against future drift: if someone renames a wire tag but
        // leaves as_wire returning the old value, requests would go out
        // with the wrong reason. This ties both sides together.
        for reason in [
            LichessDeclineReason::Generic,
            LichessDeclineReason::Later,
            LichessDeclineReason::TooFast,
            LichessDeclineReason::TooSlow,
            LichessDeclineReason::TimeControl,
            LichessDeclineReason::Rated,
            LichessDeclineReason::Casual,
            LichessDeclineReason::Standard,
            LichessDeclineReason::Variant,
            LichessDeclineReason::NoBot,
            LichessDeclineReason::OnlyBot,
        ] {
            let json = format!("\"{}\"", reason.as_wire());
            let parsed: LichessDeclineReason = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, reason);
        }
    }

    #[test]
    fn challenge_color_deserializes_from_the_wire_tags_lichess_accepts() {
        assert_eq!(
            serde_json::from_str::<ChallengeColor>("\"random\"").unwrap(),
            ChallengeColor::Random,
        );
        assert_eq!(
            serde_json::from_str::<ChallengeColor>("\"white\"").unwrap(),
            ChallengeColor::White,
        );
        assert_eq!(
            serde_json::from_str::<ChallengeColor>("\"black\"").unwrap(),
            ChallengeColor::Black,
        );
    }

    #[test]
    fn challenge_color_rejects_anything_else() {
        assert!(serde_json::from_str::<ChallengeColor>("\"gray\"").is_err());
        assert!(serde_json::from_str::<ChallengeColor>("null").is_err());
    }

    #[test]
    fn challenge_color_wire_string_roundtrips_through_deserialize() {
        for color in [ChallengeColor::Random, ChallengeColor::White, ChallengeColor::Black] {
            let json = format!("\"{}\"", color.as_wire());
            let parsed: ChallengeColor = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, color);
        }
    }

    #[test]
    fn validate_time_minutes_accepts_the_range_lichess_accepts() {
        assert!(validate_time_minutes(0).is_ok());
        assert!(validate_time_minutes(5).is_ok());
        assert!(validate_time_minutes(180).is_ok());
    }

    #[test]
    fn validate_time_minutes_rejects_above_the_upper_bound() {
        // 181 is 1 above Lichess's cap -- must fail here, not at the API.
        assert!(validate_time_minutes(181).is_err());
        assert!(validate_time_minutes(u32::MAX).is_err());
    }

    #[test]
    fn validate_increment_seconds_accepts_the_range_lichess_accepts() {
        assert!(validate_increment_seconds(0).is_ok());
        assert!(validate_increment_seconds(30).is_ok());
        assert!(validate_increment_seconds(60).is_ok());
    }

    #[test]
    fn validate_increment_seconds_rejects_above_the_upper_bound() {
        assert!(validate_increment_seconds(61).is_err());
        assert!(validate_increment_seconds(u32::MAX).is_err());
    }

    #[test]
    fn validate_ai_level_accepts_1_through_8() {
        for level in 1u8..=8 {
            assert!(validate_ai_level(level).is_ok(), "level {level} should pass");
        }
    }

    #[test]
    fn validate_ai_level_rejects_out_of_range() {
        assert!(validate_ai_level(0).is_err());
        assert!(validate_ai_level(9).is_err());
        assert!(validate_ai_level(u8::MAX).is_err());
    }

    #[test]
    fn pop_lines_splits_completed_lines_and_leaves_partial_at_end() {
        let mut buffer = Vec::from(&b"one\ntwo\nthree"[..]);
        let lines = pop_lines(&mut buffer);
        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
        // "three" has no trailing newline -- stays in the buffer for the
        // next chunk. This is the entire point of the byte-buffered
        // shape (pre-PR-6 the previous chunk-decoded-then-split path
        // would either have dropped it or produced garbage).
        assert_eq!(buffer, b"three");
    }

    #[test]
    fn pop_lines_handles_crlf_line_endings() {
        let mut buffer = Vec::from(&b"first\r\nsecond\r\n"[..]);
        assert_eq!(
            pop_lines(&mut buffer),
            vec!["first".to_string(), "second".to_string()]
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn pop_lines_skips_empty_lines_between_content() {
        // Lichess's keep-alive newlines produce empty lines, which the
        // frontend has no use for. Filter them here so `applyIncomingMoves`
        // isn't handed a "" it would silently parse-null.
        let mut buffer = Vec::from(&b"\n\ndata\n\n"[..]);
        assert_eq!(pop_lines(&mut buffer), vec!["data".to_string()]);
    }

    #[test]
    fn pop_lines_preserves_multi_byte_utf8_split_across_chunk_boundaries() {
        // The single-char string "é" is 0xC3 0xA9 in UTF-8. Simulate a
        // chunk boundary landing between the two bytes: after the first
        // chunk, only 0xC3 has arrived (no complete line yet). After
        // the second, the codepoint completes and the line pops out
        // intact -- pre-PR-6, `from_utf8_lossy` would have written
        // U+FFFD REPLACEMENT CHARACTER for the orphaned byte.
        let mut buffer = Vec::from(&b"caf\xC3"[..]);
        assert!(pop_lines(&mut buffer).is_empty());
        buffer.extend_from_slice(b"\xA9\n");
        let lines = pop_lines(&mut buffer);
        assert_eq!(lines, vec!["café".to_string()]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn retry_schedule_grows_exponentially_and_caps_at_30_seconds() {
        let mut s = RetrySchedule::new();
        assert_eq!(s.next(), Duration::from_secs(1));
        assert_eq!(s.next(), Duration::from_secs(2));
        assert_eq!(s.next(), Duration::from_secs(4));
        assert_eq!(s.next(), Duration::from_secs(8));
        assert_eq!(s.next(), Duration::from_secs(16));
        // 32 > 30, so it caps.
        assert_eq!(s.next(), Duration::from_secs(30));
        // Every subsequent call stays at 30.
        assert_eq!(s.next(), Duration::from_secs(30));
        assert_eq!(s.next(), Duration::from_secs(30));
    }

    #[test]
    fn retry_schedule_reset_starts_over_from_1_second() {
        let mut s = RetrySchedule::new();
        for _ in 0..5 {
            let _ = s.next();
        }
        s.reset();
        assert_eq!(s.next(), Duration::from_secs(1));
    }

    #[test]
    fn retry_schedule_does_not_overflow_on_many_attempts() {
        let mut s = RetrySchedule::new();
        for _ in 0..1000 {
            let d = s.next();
            assert!(d.as_secs() <= 30, "delay must stay bounded at cap");
        }
    }

    #[test]
    fn account_cache_invalidation_drops_only_the_named_slot() {
        let cache = new_shared_account_cache();
        cache_put(
            &cache,
            TokenSlot::Human,
            AccountInfo { id: "h".into(), username: "H".into(), is_bot: false },
        );
        cache_put(
            &cache,
            TokenSlot::Bot,
            AccountInfo { id: "b".into(), username: "B".into(), is_bot: true },
        );
        invalidate_account_cache(&cache, TokenSlot::Human);
        assert!(cache_get(&cache, TokenSlot::Human).is_none());
        assert!(cache_get(&cache, TokenSlot::Bot).is_some());
    }
}
