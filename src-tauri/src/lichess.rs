//! Fetches PGN text for a public Lichess game. Deliberately dumb, same
//! boundary as `engine.rs`: this module never parses PGN or knows anything
//! about chess -- it only validates a game id, makes the HTTP request, and
//! hands the raw PGN text back. All PGN parsing already lives in the
//! frontend (`src/lib/chessRules.ts`'s `parsePgn`) via `GameLoader.tsx`.

const GAME_ID_LEN: usize = 8;

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
}
