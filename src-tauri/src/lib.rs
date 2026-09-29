mod debug_log;
mod engine;
mod lichess;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::WhiteEngine(engine::new_shared_state()))
        .manage(engine::BlackEngine(engine::new_shared_state()))
        .manage(lichess::LichessConnection(lichess::new_shared_lichess_state()))
        .manage(lichess::LichessEventConnection(lichess::new_shared_lichess_state()))
        .setup(|app| {
            // A fresh debug.log per session, per the mandate that it must
            // never grow unbounded across a long-running dev session.
            let _ = debug_log::clear(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_write_line,
            engine::engine_stop,
            debug_log::debug_log_append,
            debug_log::debug_log_clear,
            lichess::lichess_export_pgn,
            lichess::lichess_token_set,
            lichess::lichess_token_has,
            lichess::lichess_token_clear,
            lichess::lichess_stream_game,
            lichess::lichess_stop_game,
            lichess::lichess_make_move,
            lichess::lichess_bot_stream_game,
            lichess::lichess_bot_make_move,
            lichess::lichess_stream_events,
            lichess::lichess_stop_events,
            lichess::lichess_challenge_accept,
            lichess::lichess_bot_upgrade,
            lichess::lichess_bot_online,
            lichess::lichess_challenge_bot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
