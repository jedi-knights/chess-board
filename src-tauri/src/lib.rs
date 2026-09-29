mod engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::new_shared_state())
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_write_line,
            engine::engine_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
