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

use std::sync::{Arc, Mutex, MutexGuard};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

const GAME_ID_LEN: usize = 8;
const KEYRING_SERVICE: &str = "com.jediknights.chessboard";
const KEYRING_USER: &str = "lichess-personal-token";

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

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("failed to access OS keychain: {e}"))
}

/// Reads the stored personal access token. `Err` (not an empty string) when
/// none is set, so every caller that needs the token to make a request is
/// forced to handle "not connected" rather than silently sending an
/// unauthenticated request that Lichess would then reject.
fn token() -> Result<String, String> {
    match keyring_entry()?.get_password() {
        Ok(token) => Ok(token),
        Err(keyring::Error::NoEntry) => Err("no Lichess token is set -- add one first".to_string()),
        Err(e) => Err(format!("failed to read token from OS keychain: {e}")),
    }
}

#[tauri::command]
pub fn lichess_token_set(token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("token is empty".to_string());
    }
    keyring_entry()?
        .set_password(trimmed)
        .map_err(|e| format!("failed to store token in OS keychain: {e}"))
}

#[tauri::command]
pub fn lichess_token_has() -> Result<bool, String> {
    match keyring_entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("failed to query OS keychain: {e}")),
    }
}

#[tauri::command]
pub fn lichess_token_clear() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to clear token from OS keychain: {e}")),
    }
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

/// Reads an NDJSON response body, one line per Tauri event. Used for both
/// a specific game's move stream and the account-wide event stream --
/// they're the same wire shape (newline-delimited JSON), just different
/// event names and different content. Runs until the stream closes or the
/// task is aborted by `stop_stream_locked`.
async fn pump_ndjson_stream(
    app: AppHandle,
    response: reqwest::Response,
    line_event: &'static str,
    exit_event: &'static str,
) {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    loop {
        match stream.next().await {
            Some(Ok(chunk)) => {
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(newline) = buffer.find('\n') {
                    let line = buffer[..newline].trim().to_string();
                    buffer.drain(..=newline);
                    if !line.is_empty() {
                        let _ = app.emit(line_event, line);
                    }
                }
            }
            Some(Err(e)) => {
                let _ = app.emit(exit_event, format!("stream error: {e}"));
                return;
            }
            None => {
                let _ = app.emit(exit_event, "stream closed".to_string());
                return;
            }
        }
    }
}

fn new_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("chess-board (https://github.com/jedi-knights/chess-board)")
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

/// Shared body of `lichess_stream_game`/`lichess_bot_stream_game` -- `kind`
/// is `"board"` or `"bot"`, the only difference in the request Lichess sees.
/// Board- and bot-mode game streams share the same connection slot: this
/// app plays either as a human (Board API) or runs a bot loop (Bot API) at
/// any given moment, never both, so there's only ever one active game
/// stream to track regardless of which mode started it.
async fn stream_game_impl(
    app: AppHandle,
    shared: SharedLichessState,
    game_id_or_url: String,
    kind: &str,
    line_event: &'static str,
    exit_event: &'static str,
) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    let token = token()?;
    // Never leak a previous stream task if the user connects to a new game
    // without explicitly disconnecting first.
    stop_stream_locked(&shared)?;

    let client = new_client()?;
    let url = format!("https://lichess.org/api/{kind}/game/stream/{game_id}");
    let response = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("lichess returned {status} for game {game_id}"));
    }

    let task = tokio::spawn(pump_ndjson_stream(app, response, line_event, exit_event));
    lock(&shared)?.stream_task = Some(task);
    Ok(())
}

#[tauri::command]
pub async fn lichess_stream_game(
    app: AppHandle,
    state: State<'_, LichessConnection>,
    game_id_or_url: String,
) -> Result<(), String> {
    stream_game_impl(
        app,
        state.0.clone(),
        game_id_or_url,
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
    game_id_or_url: String,
) -> Result<(), String> {
    stream_game_impl(
        app,
        state.0.clone(),
        game_id_or_url,
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

/// Shared body of `lichess_make_move`/`lichess_bot_make_move` -- `kind` is
/// `"board"` or `"bot"`, the only difference in the request Lichess sees.
async fn make_move_impl(
    game_id_or_url: String,
    uci_move: String,
    kind: &str,
) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    validate_uci_move(&uci_move)?;
    let token = token()?;

    let client = new_client()?;
    let url = format!("https://lichess.org/api/{kind}/game/{game_id}/move/{uci_move}");
    let response = client
        .post(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("lichess rejected move {uci_move}: {status} {body}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn lichess_make_move(game_id_or_url: String, uci_move: String) -> Result<(), String> {
    make_move_impl(game_id_or_url, uci_move, "board").await
}

#[tauri::command]
pub async fn lichess_bot_make_move(game_id_or_url: String, uci_move: String) -> Result<(), String> {
    make_move_impl(game_id_or_url, uci_move, "bot").await
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
) -> Result<(), String> {
    let token = token()?;
    let shared = state.0.clone();
    stop_stream_locked(&shared)?;

    let client = new_client()?;
    let response = client
        .get("https://lichess.org/api/stream/event")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "lichess returned {status} for the account event stream"
        ));
    }

    let task = tokio::spawn(pump_ndjson_stream(
        app,
        response,
        "lichess-event-stream",
        "lichess-event-exit",
    ));
    lock(&shared)?.stream_task = Some(task);
    Ok(())
}

#[tauri::command]
pub fn lichess_stop_events(state: State<'_, LichessEventConnection>) -> Result<(), String> {
    stop_stream_locked(&state.0)
}

#[tauri::command]
pub async fn lichess_challenge_accept(challenge_id: String) -> Result<(), String> {
    // Challenge ids share the exact same 8-char alphanumeric shape as game
    // ids -- reusing the validator here is deliberate, not a coincidence.
    let id = parse_game_id(&challenge_id)?;
    let token = token()?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/challenge/{id}/accept");
    let response = client
        .post(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

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
#[tauri::command]
pub async fn lichess_bot_upgrade() -> Result<(), String> {
    let token = token()?;
    let client = new_client()?;
    let response = client
        .post("https://lichess.org/api/bot/account/upgrade")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected the bot upgrade request: {status} {body}"
        ));
    }
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
    username: String,
    clock_limit_seconds: u32,
    clock_increment_seconds: u32,
    color: String,
) -> Result<(), String> {
    validate_username(&username)?;
    if !matches!(color.as_str(), "random" | "white" | "black") {
        return Err(format!("\"{color}\" is not a valid color"));
    }
    let token = token()?;
    let client = new_client()?;
    let url = format!("https://lichess.org/api/challenge/{username}");
    let response = client
        .post(&url)
        .bearer_auth(&token)
        .form(&[
            ("rated", "false"),
            ("clock.limit", &clock_limit_seconds.to_string()),
            ("clock.increment", &clock_increment_seconds.to_string()),
            ("color", &color),
            ("variant", "standard"),
        ])
        .send()
        .await
        .map_err(|e| format!("failed to reach lichess: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected the challenge to {username}: {status} {body}"
        ));
    }
    Ok(())
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
}
