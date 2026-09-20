#[tauri::command]
/// 可执行文件所在目录下的 data 文件夹（Windows 便携模式的数据目录默认值）
fn exe_data_dir() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join("data").to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![exe_data_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
