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
    // infrequent request. Revisit if a later phase adds a streamed/polled
    // Lichess connection that actually benefits from pooling.
    let client = reqwest::Client::builder()
        .user_agent("chess-board (https://github.com/jedi-knights/chess-board)")
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
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

/// Reads the game stream response body as NDJSON, one line per Tauri event.
/// Runs until the stream closes or the task is aborted by `stop_stream_locked`.
async fn pump_game_stream(app: AppHandle, response: reqwest::Response) {
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
                        let _ = app.emit("lichess-game-stream", line);
                    }
                }
            }
            Some(Err(e)) => {
                let _ = app.emit("lichess-game-exit", format!("stream error: {e}"));
                return;
            }
            None => {
                let _ = app.emit("lichess-game-exit", "stream closed".to_string());
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn lichess_stream_game(
    app: AppHandle,
    state: State<'_, LichessConnection>,
    game_id_or_url: String,
) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    let token = token()?;
    let shared = state.0.clone();
    // Never leak a previous stream task if the user connects to a new game
    // without explicitly disconnecting first.
    stop_stream_locked(&shared)?;

    let client = reqwest::Client::builder()
        .user_agent("chess-board (https://github.com/jedi-knights/chess-board)")
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let url = format!("https://lichess.org/api/board/game/stream/{game_id}");
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

    let task = tokio::spawn(pump_game_stream(app, response));
    lock(&shared)?.stream_task = Some(task);
    Ok(())
}

#[tauri::command]
pub fn lichess_stop_game(state: State<'_, LichessConnection>) -> Result<(), String> {
    stop_stream_locked(&state.0)
}

#[tauri::command]
pub async fn lichess_make_move(game_id_or_url: String, uci_move: String) -> Result<(), String> {
    let game_id = parse_game_id(&game_id_or_url)?;
    validate_uci_move(&uci_move)?;
    let token = token()?;

    let client = reqwest::Client::builder()
        .user_agent("chess-board (https://github.com/jedi-knights/chess-board)")
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let url = format!("https://lichess.org/api/board/game/{game_id}/move/{uci_move}");
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
}
