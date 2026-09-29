//! A small, deliberately simple debug log for post-mortem debugging (by a
//! human or by Claude reading the file directly) -- not a general logging
//! framework. One file, cleared at session start and at the start of every
//! new game so it never grows unbounded across a long-running session.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("failed to resolve log directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create log directory: {e}"))?;
    Ok(dir.join("debug.log"))
}

/// Appends one timestamped line. Errors are the caller's to decide on --
/// most call sites treat a logging failure as non-fatal (log it and move
/// on), since losing a diagnostic line must never break the actual feature
/// it's describing.
pub fn append(app: &AppHandle, message: &str) -> Result<(), String> {
    let path = log_path(app)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("failed to open debug log: {e}"))?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    writeln!(file, "[{timestamp}] {message}").map_err(|e| format!("failed to write debug log: {e}"))
}

/// Truncates the log to empty. Called once at app startup (a new session)
/// and once per new game (see `engineStore.startEngine`) -- never left to
/// grow across an entire long-running dev session.
pub fn clear(app: &AppHandle) -> Result<(), String> {
    fs::write(log_path(app)?, "").map_err(|e| format!("failed to clear debug log: {e}"))
}

#[tauri::command]
pub fn debug_log_append(app: AppHandle, message: String) -> Result<(), String> {
    append(&app, &message)
}

#[tauri::command]
pub fn debug_log_clear(app: AppHandle) -> Result<(), String> {
    clear(&app)
}
