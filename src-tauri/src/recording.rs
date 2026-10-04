//! Writes game recordings (PGN) to a fixed subfolder of the Tauri app data
//! dir. Fire-and-forget from the frontend's terminal-status branch so a
//! finished Lichess bot game becomes a standalone PGN on disk, ready for
//! offline training ingestion.
//!
//! Design shape mirrors `debug_log.rs`'s minimal-surface recipe: one
//! Tauri command, no persistent in-memory state, no OS-specific path
//! juggling in callers -- the frontend hands us a filename and contents,
//! we resolve the data dir, write, done. Path-traversal guard rejects any
//! filename that could escape the recordings subfolder, so an untrusted
//! frontend can't walk outside the directory.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const RECORDINGS_SUBDIR: &str = "recordings";

fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?
        .join(RECORDINGS_SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create recordings dir: {e}"))?;
    Ok(dir)
}

/// Validates that `name` is a plain file name: non-empty, no path
/// separators, no parent-directory tokens. Reject rather than normalize
/// so a bug in the caller surfaces instead of silently writing to the
/// wrong place.
fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("filename is empty".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!(
            "filename must not contain path separators, got {name:?}"
        ));
    }
    if name == "." || name == ".." || name.split('.').any(|segment| segment == "..") {
        return Err(format!("filename must not reference parent dir, got {name:?}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn recording_write_pgn(
    app: AppHandle,
    filename: String,
    contents: String,
) -> Result<(), String> {
    validate_filename(&filename)?;
    let path = recordings_dir(&app)?.join(&filename);
    fs::write(&path, contents).map_err(|e| {
        format!("failed to write recording {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::validate_filename;

    #[test]
    fn rejects_empty() {
        assert!(validate_filename("").is_err());
    }

    #[test]
    fn rejects_slash_variants() {
        assert!(validate_filename("sub/file.pgn").is_err());
        assert!(validate_filename("sub\\file.pgn").is_err());
        assert!(validate_filename("/absolute.pgn").is_err());
    }

    #[test]
    fn rejects_parent_dir_tokens() {
        assert!(validate_filename("..").is_err());
        assert!(validate_filename("../etc/passwd").is_err());
        assert!(validate_filename("foo/../bar").is_err());
    }

    #[test]
    fn accepts_a_plain_filename() {
        assert!(validate_filename("2026-10-04_abc123_white_vs_black.pgn").is_ok());
    }

    #[test]
    fn accepts_names_with_dots_that_arent_parent_refs() {
        // Multiple dots are fine (e.g. "my.game.1.pgn"); parent-dir ".."
        // is specifically rejected but regular dots pass through.
        assert!(validate_filename("my.game.1.pgn").is_ok());
    }
}
