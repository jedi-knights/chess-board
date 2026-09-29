mod debug_log;
mod engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::new_shared_state())
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
            debug_log::debug_log_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
