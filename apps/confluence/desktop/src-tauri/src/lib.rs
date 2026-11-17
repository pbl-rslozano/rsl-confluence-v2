//! rsL Confluence Terminal — Tauri 2 desktop shell.
//!
//! Thin by design (ADR-0001): the product is the web core in ../web/out. This crate only
//! registers plugins (SQLite records, native dialogs, scoped file access, external links,
//! path-scoped HTTP GET for Coins.ph public market data),
//! keeps a single instance with remembered window state, and builds the native menu.
//! Menu actions are emitted to the web app as `rsl-menu` events with the item id.

mod oauth_loopback;

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

pub const APP_TITLE: &str = "rsL Confluence Terminal";

/// WP28: the sign-in redirect listener. Held between `bind` and `wait`; `wait` takes it and drops it on every exit.
#[derive(Default)]
struct OAuthLoopback {
    listener: Mutex<Option<TcpListener>>,
    cancelled: Arc<AtomicBool>,
}

#[tauri::command]
fn oauth_loopback_bind(state: tauri::State<'_, OAuthLoopback>) -> Result<(), String> {
    let mut slot = state.listener.lock().map_err(|_| "io".to_string())?;
    *slot = None; // drop any listener left from an earlier attempt before binding again
    state.cancelled.store(false, Ordering::SeqCst);
    *slot = Some(oauth_loopback::bind()?);
    Ok(())
}

#[tauri::command]
async fn oauth_loopback_wait(state: tauri::State<'_, OAuthLoopback>, timeout_ms: u64, relay_fragment: bool) -> Result<String, String> {
    let listener = state.listener.lock().map_err(|_| "io".to_string())?.take().ok_or_else(|| "not-bound".to_string())?;
    let cancelled = Arc::clone(&state.cancelled);
    tauri::async_runtime::spawn_blocking(move || {
        oauth_loopback::wait(listener, Duration::from_millis(timeout_ms), relay_fragment, &cancelled)
    })
    .await
    .map_err(|_| "io".to_string())?
}

#[tauri::command]
fn oauth_loopback_cancel(state: tauri::State<'_, OAuthLoopback>) {
    state.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = state.listener.lock() {
        *slot = None;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Second launch focuses the existing window instead of opening another.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // v2.6: Coins.ph public market data (no CORS); URL scope in capabilities/main.json (R16).
        .plugin(tauri_plugin_http::init())
        .manage(OAuthLoopback::default())
        .invoke_handler(tauri::generate_handler![oauth_loopback_bind, oauth_loopback_wait, oauth_loopback_cancel])
        .setup(|app| {
            let about = MenuItemBuilder::with_id("about", format!("About {APP_TITLE}")).build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let export = MenuItemBuilder::with_id("backup.export", "Export backup…")
                .accelerator("CmdOrCtrl+E")
                .build(app)?;
            let restore = MenuItemBuilder::with_id("backup.restore", "Restore backup…").build(app)?;
            let refresh = MenuItemBuilder::with_id("refresh", "Refresh scan")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let contact = MenuItemBuilder::with_id("contact", "Contact developer…").build(app)?;

            let file = SubmenuBuilder::new(app, "File")
                .item(&export)
                .item(&restore)
                .separator()
                .close_window()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .item(&refresh)
                .separator()
                .fullscreen()
                .build()?;
            let help = SubmenuBuilder::new(app, "Help").item(&contact).item(&about).build()?;

            // macOS: the first submenu is the application menu (About, Settings ⌘,, Quit ⌘Q).
            #[cfg(target_os = "macos")]
            let menu = {
                let app_menu = SubmenuBuilder::new(app, APP_TITLE)
                    .item(&about)
                    .separator()
                    .item(&settings)
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &help]).build()?
            };
            #[cfg(not(target_os = "macos"))]
            let menu = {
                let tools = SubmenuBuilder::new(app, "Tools").item(&settings).build()?;
                MenuBuilder::new(app).items(&[&file, &edit, &view, &tools, &help]).build()?
            };
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("rsl-menu", event.id().0.clone());
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running rsL Confluence Terminal");
}
