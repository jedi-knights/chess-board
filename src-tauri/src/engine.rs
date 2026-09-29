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

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// How many of the engine's most recent stderr lines to keep around for a
/// crash report. Bounded so a chatty/misbehaving engine can't grow this
/// without limit -- a genuine crash diagnostic is a handful of lines, not
/// thousands.
const STDERR_TAIL_LINES: usize = 20;

#[derive(Default)]
pub struct EngineState {
    child: Option<Child>,
    reader_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    stderr_tail: Vec<String>,
}

pub type SharedEngineState = Arc<Mutex<EngineState>>;

pub fn new_shared_state() -> SharedEngineState {
    Arc::new(Mutex::new(EngineState::default()))
}

/// One independent engine slot per side, so both sides can be engine-
/// controlled at once (same binary or different ones -- each is its own OS
/// process). Wrapped in distinct types because Tauri's `.manage()` state is
/// keyed by type; a bare `SharedEngineState` couldn't be managed twice.
pub struct WhiteEngine(pub SharedEngineState);
pub struct BlackEngine(pub SharedEngineState);

fn state_for_side<'a>(
    side: &str,
    white: &'a State<'_, WhiteEngine>,
    black: &'a State<'_, BlackEngine>,
) -> &'a SharedEngineState {
    if side == "w" { &white.0 } else { &black.0 }
}

#[derive(Serialize, Clone)]
pub struct EngineExitPayload {
    code: Option<i32>,
    /// The engine's most recent stderr output, if it printed anything
    /// before exiting -- often the only clue a crash left behind (an
    /// assertion message, a missing-file error, a segfault handler line).
    stderr: String,
}

fn lock(state: &SharedEngineState) -> Result<MutexGuard<'_, EngineState>, String> {
    state.lock().map_err(|_| "engine state lock poisoned".to_string())
}

fn push_stderr_line(state: &SharedEngineState, line: String) {
    let Ok(mut guard) = lock(state) else { return };
    guard.stderr_tail.push(line);
    if guard.stderr_tail.len() > STDERR_TAIL_LINES {
        let excess = guard.stderr_tail.len() - STDERR_TAIL_LINES;
        guard.stderr_tail.drain(0..excess);
    }
}

/// Stops whatever engine is currently running, if any. Safe to call when no
/// engine is running (a no-op). Blocks until both reader threads have fully
/// exited, so callers never leak a thread or an unreaped child process.
fn stop_locked(state: &SharedEngineState) -> Result<(), String> {
    let (mut child, reader_handle, stderr_handle) = {
        let mut guard = lock(state)?;
        (guard.child.take(), guard.reader_handle.take(), guard.stderr_handle.take())
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
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    Ok(())
}

fn start_locked(app: AppHandle, state: SharedEngineState, side: String, path: String) -> Result<(), String> {
    let engine_path = Path::new(&path);
    if !engine_path.is_file() {
        return Err(format!("engine path is not a file: {path}"));
    }

    // Never leak a previous process if the user picks a new engine mid-run.
    stop_locked(&state)?;

    let _ = crate::debug_log::append(&app, &format!("[{side}] engine_start: path={path}"));

    let mut child = Command::new(engine_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("failed to spawn engine at {path}: {e}");
            let _ = crate::debug_log::append(&app, &format!("[{side}] {msg}"));
            msg
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned engine process has no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "spawned engine process has no stderr".to_string())?;

    {
        let mut guard = lock(&state)?;
        guard.stderr_tail.clear();
    }

    let stderr_state = state.clone();
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => push_stderr_line(&stderr_state, text),
                Err(_) => break,
            }
        }
    });

    let reader_state = state.clone();
    let reader_app = app.clone();
    let stdout_event = format!("engine-stdout-{side}");
    let exit_event = format!("engine-exit-{side}");
    let reader_side = side.clone();
    let reader_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = reader_app.emit(&stdout_event, text);
                }
                Err(_) => break,
            }
        }
        // stdout closed: the process exited (or we killed it). try_wait is
        // non-blocking -- if the child hasn't fully reaped yet this reports
        // no code rather than blocking the reader thread indefinitely.
        let (code, stderr) = match lock(&reader_state) {
            Ok(mut guard) => {
                let code = guard
                    .child
                    .as_mut()
                    .and_then(|c| c.try_wait().ok().flatten())
                    .and_then(|status| status.code());
                (code, guard.stderr_tail.join("\n"))
            }
            Err(_) => (None, String::new()),
        };
        let _ = crate::debug_log::append(
            &reader_app,
            &format!("[{reader_side}] engine exited: code={code:?} stderr={stderr:?}"),
        );
        let _ = reader_app.emit(&exit_event, EngineExitPayload { code, stderr });
    });

    let mut guard = lock(&state)?;
    guard.child = Some(child);
    guard.reader_handle = Some(reader_handle);
    guard.stderr_handle = Some(stderr_handle);
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
    white: State<'_, WhiteEngine>,
    black: State<'_, BlackEngine>,
    side: String,
    path: String,
) -> Result<(), String> {
    let state = state_for_side(&side, &white, &black).clone();
    start_locked(app, state, side, path)
}

#[tauri::command]
pub fn engine_write_line(
    white: State<'_, WhiteEngine>,
    black: State<'_, BlackEngine>,
    side: String,
    line: String,
) -> Result<(), String> {
    write_line_locked(state_for_side(&side, &white, &black), &line)
}

#[tauri::command]
pub fn engine_stop(
    white: State<'_, WhiteEngine>,
    black: State<'_, BlackEngine>,
    side: String,
) -> Result<(), String> {
    stop_locked(state_for_side(&side, &white, &black))
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

    #[test]
    fn stderr_tail_is_capped() {
        let state = new_shared_state();
        for i in 0..(STDERR_TAIL_LINES + 10) {
            push_stderr_line(&state, format!("line {i}"));
        }
        let guard = lock(&state).unwrap();
        assert_eq!(guard.stderr_tail.len(), STDERR_TAIL_LINES);
        // Oldest lines are dropped first -- the most recent ones survive.
        assert_eq!(guard.stderr_tail.first().unwrap(), "line 10");
        assert_eq!(guard.stderr_tail.last().unwrap(), "line 29");
    }

    #[test]
    fn two_engine_slots_are_fully_independent() {
        // The white/black split only matters if mutating one slot's state
        // (here, its stderr tail -- the cheapest thing to mutate without an
        // AppHandle) never touches the other.
        let white = new_shared_state();
        let black = new_shared_state();
        push_stderr_line(&white, "white only".to_string());
        assert!(lock(&white).unwrap().stderr_tail.contains(&"white only".to_string()));
        assert!(lock(&black).unwrap().stderr_tail.is_empty());
    }
}
