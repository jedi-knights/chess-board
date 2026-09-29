//! Raw process I/O for a UCI engine binary. Deliberately dumb: this module
//! never parses a UCI line or knows anything about chess. All protocol and
//! chess-rule logic lives in the frontend (`src/lib/uci.ts`, `chessRules.ts`)
//! — see CLAUDE.md's "Rust/TS boundary" note. This module only spawns the
//! process, pipes bytes, and reports when it ends.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct EngineState {
    child: Option<Child>,
    reader_handle: Option<JoinHandle<()>>,
}

pub type SharedEngineState = Arc<Mutex<EngineState>>;

pub fn new_shared_state() -> SharedEngineState {
    Arc::new(Mutex::new(EngineState::default()))
}

fn lock(state: &SharedEngineState) -> Result<MutexGuard<'_, EngineState>, String> {
    state.lock().map_err(|_| "engine state lock poisoned".to_string())
}

/// Stops whatever engine is currently running, if any. Safe to call when no
/// engine is running (a no-op). Blocks until the reader thread has fully
/// exited, so callers never leak a thread or an unreaped child process.
fn stop_locked(state: &SharedEngineState) -> Result<(), String> {
    let (mut child, reader_handle) = {
        let mut guard = lock(state)?;
        (guard.child.take(), guard.reader_handle.take())
    };

    if let Some(child) = child.as_mut() {
        // Ask nicely first -- ignore the write error, since the pipe may
        // already be gone if the process crashed; kill() below is the
        // real backstop that guarantees we don't leak a process.
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "quit");
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(handle) = reader_handle {
        let _ = handle.join();
    }

    Ok(())
}

fn start_locked(app: AppHandle, state: SharedEngineState, path: String) -> Result<(), String> {
    let engine_path = Path::new(&path);
    if !engine_path.is_file() {
        return Err(format!("engine path is not a file: {path}"));
    }

    // Never leak a previous process if the user picks a new engine mid-run.
    stop_locked(&state)?;

    let mut child = Command::new(engine_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn engine at {path}: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned engine process has no stdout".to_string())?;

    let reader_state = state.clone();
    let reader_app = app.clone();
    let reader_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = reader_app.emit("engine-stdout", text);
                }
                Err(_) => break,
            }
        }
        // stdout closed: the process exited (or we killed it). try_wait is
        // non-blocking -- if the child hasn't fully reaped yet this reports
        // no code rather than blocking the reader thread indefinitely.
        let exit_code = lock(&reader_state)
            .ok()
            .and_then(|mut guard| guard.child.as_mut()?.try_wait().ok().flatten())
            .and_then(|status| status.code());
        let _ = reader_app.emit("engine-exit", exit_code);
    });

    let mut guard = lock(&state)?;
    guard.child = Some(child);
    guard.reader_handle = Some(reader_handle);
    Ok(())
}

fn write_line_locked(state: &SharedEngineState, line: &str) -> Result<(), String> {
    let mut guard = lock(state)?;
    let child = guard.child.as_mut().ok_or_else(|| "no engine is running".to_string())?;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "engine stdin is not available".to_string())?;
    writeln!(stdin, "{line}").map_err(|e| format!("failed to write to engine stdin: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush engine stdin: {e}"))
}

#[tauri::command]
pub fn engine_start(
    app: AppHandle,
    state: State<'_, SharedEngineState>,
    path: String,
) -> Result<(), String> {
    start_locked(app, state.inner().clone(), path)
}

#[tauri::command]
pub fn engine_write_line(state: State<'_, SharedEngineState>, line: String) -> Result<(), String> {
    write_line_locked(state.inner(), &line)
}

#[tauri::command]
pub fn engine_stop(state: State<'_, SharedEngineState>) -> Result<(), String> {
    stop_locked(state.inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    // start_locked takes an AppHandle, which needs a running Tauri app to
    // construct -- exercising the path-validation branch is covered by the
    // manual dev-mode verification in the PR (pick a bogus path, see the
    // error surface), not a unit test here.

    #[test]
    fn write_line_fails_with_no_engine_running() {
        let state = new_shared_state();
        let result = write_line_locked(&state, "uci");
        assert_eq!(result, Err("no engine is running".to_string()));
    }

    #[test]
    fn stop_is_a_safe_no_op_with_no_engine_running() {
        let state = new_shared_state();
        assert!(stop_locked(&state).is_ok());
    }
}
