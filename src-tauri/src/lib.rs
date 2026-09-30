mod debug_log;
mod engine;
mod lichess;
mod menu;

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
        .manage(lichess::LichessSeekConnection(lichess::new_shared_lichess_state()))
        .manage(lichess::new_shared_account_cache())
        .setup(|app| {
            // A fresh debug.log per session, per the mandate that it must
            // never grow unbounded across a long-running dev session.
            let handle = app.handle().clone();
            let _ = debug_log::clear(&handle);
            // Once-per-install migration: pre-PR-1 there was a single
            // `lichess-personal-token` keychain entry; PR 1 split it into
            // per-mode slots. Copy the legacy value into the human slot
            // (the safer default) and delete the old entry so this branch
            // never fires again. A failure here doesn't block launch --
            // the user can just re-enter their token in the new UI.
            match lichess::migrate_legacy_token() {
                Ok(true) => {
                    let _ = debug_log::append(&handle, "[lichess] migrated legacy token -> human slot");
                }
                Ok(false) => {}
                Err(e) => {
                    let _ = debug_log::append(&handle, &format!("[lichess] token migration failed: {e}"));
                }
            }
            let view_menu = menu::build(app)?;
            app.set_menu(view_menu)?;
            app.on_menu_event(menu::handle_event);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_write_line,
            engine::engine_stop,
            debug_log::debug_log_append,
            debug_log::debug_log_clear,
            menu::sync_view_menu,
            menu::set_game_mode_menu_enabled,
            lichess::lichess_export_pgn,
            lichess::lichess_token_set,
            lichess::lichess_token_has,
            lichess::lichess_token_clear,
            lichess::lichess_verify_account,
            lichess::lichess_stream_game,
            lichess::lichess_stop_game,
            lichess::lichess_make_move,
            lichess::lichess_bot_stream_game,
            lichess::lichess_bot_make_move,
            lichess::lichess_stream_events,
            lichess::lichess_stop_events,
            lichess::lichess_challenge_accept,
            lichess::lichess_challenge_decline,
            lichess::lichess_bot_upgrade,
            lichess::lichess_bot_online,
            lichess::lichess_challenge_bot,
            lichess::lichess_challenge_user,
            lichess::lichess_challenge_ai,
            lichess::lichess_seek,
            lichess::lichess_stop_seek,
            lichess::lichess_resign,
            lichess::lichess_abort,
            lichess::lichess_draw,
            lichess::lichess_claim_victory,
            lichess::lichess_bot_resign,
            lichess::lichess_bot_abort,
            lichess::lichess_bot_draw,
            lichess::lichess_bot_claim_victory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
