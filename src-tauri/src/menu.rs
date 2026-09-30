//! Builds the app's native menu bar, replacing the sidebar's game-mode
//! selector and the header's camera-mode/POV/board-palette/piece-style/
//! theme controls with a native "View" menu -- desktop convention, and it
//! declutters the header and sidebar. Deliberately dumb, same boundary as
//! `engine.rs`/`lichess.rs`: this module knows the menu item ids and their
//! radio-group membership, nothing about chess. Every click just
//! re-checks the clicked item's siblings and emits the id string to the
//! frontend, which owns what each id actually *means*.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuEvent, Submenu, SubmenuBuilder};
use tauri::{App, AppHandle, Emitter, Manager, Wry};

/// Holds the View submenu specifically (not the whole menu bar) so the
/// menu-event handler and the `sync_view_menu` command can look up and
/// re-check items by id without walking the rest of the menu bar.
pub struct ViewMenu(pub Submenu<Wry>);

const MODE_IDS: &[&str] = &[
  "mode-human-vs-engine",
  "mode-human-vs-lichess",
  "mode-engine-vs-lichess",
  "mode-engine-vs-engine",
];
const CAMERA_IDS: &[&str] = &["view-camera-2d", "view-camera-3d"];
const POV_IDS: &[&str] = &["view-pov-white", "view-pov-black"];
const PALETTE_IDS: &[&str] = &[
  "view-palette-classic",
  "view-palette-forest",
  "view-palette-ocean",
  "view-palette-slate",
];
const STYLE_IDS: &[&str] = &["view-style-classic", "view-style-modern"];
const THEME_IDS: &[&str] = &["view-theme-system", "view-theme-light", "view-theme-dark"];

/// Every radio-exclusive group of checkable ids in the View menu. A click
/// on any id in a group unchecks every other id in that same group.
const GROUPS: &[&[&str]] = &[MODE_IDS, CAMERA_IDS, POV_IDS, PALETTE_IDS, STYLE_IDS, THEME_IDS];

fn group_for(id: &str) -> Option<&'static [&'static str]> {
  GROUPS.iter().copied().find(|group| group.contains(&id))
}

/// Sets one item's checked state. A menu id we just built ourselves
/// failing to resolve, or a native item failing to update, isn't
/// recoverable at this call site -- there's no user-facing action to
/// retry or surface it through, so this fails silently rather than
/// panicking the menu-event handler over a cosmetic checkmark.
fn set_checked(view_menu: &Submenu<Wry>, id: &str, checked: bool) {
  if let Some(kind) = view_menu.get(id) {
    if let Some(item) = kind.as_check_menuitem() {
      let _ = item.set_checked(checked);
    }
  }
}

/// Same reasoning and failure handling as `set_checked`, for the
/// enabled/clickable state instead of the checkmark.
fn set_enabled(view_menu: &Submenu<Wry>, id: &str, enabled: bool) {
  if let Some(kind) = view_menu.get(id) {
    if let Some(item) = kind.as_check_menuitem() {
      let _ = item.set_enabled(enabled);
    }
  }
}

/// `id` becomes checked, every other id in its own group becomes
/// unchecked. Used for both menu clicks and the initial sync from
/// persisted frontend state (`sync_view_menu`) -- same operation either
/// way, just a different caller.
fn apply_radio_check(view_menu: &Submenu<Wry>, id: &str) {
  let Some(group) = group_for(id) else { return };
  for member in group {
    set_checked(view_menu, member, *member == id);
  }
}

/// Builds the View submenu: the default "Enter Full Screen" item (macOS
/// only, matching `Menu::default`'s own behavior) followed by this app's
/// checkable groups. Checked defaults here must match each frontend
/// store's own initial value -- gameStore's cameraMode/pov are never
/// persisted, so "3D"/"White" being checked here is always correct;
/// boardThemeStore/pieceStyleStore/themeStore *are* persisted, so their
/// checkmarks get corrected by `sync_view_menu` once the frontend mounts
/// and reads its restored localStorage state.
fn build_view_submenu(app: &App) -> tauri::Result<Submenu<Wry>> {
  let builder = SubmenuBuilder::with_id(app, "view-menu", "View");
  #[cfg(target_os = "macos")]
  let builder = builder.fullscreen().separator();
  let view_menu = builder
    .check("mode-human-vs-engine", "Human vs Engine")
    .check("mode-human-vs-lichess", "Human vs Lichess")
    .check("mode-engine-vs-lichess", "Engine vs Lichess (Bot API)")
    .check("mode-engine-vs-engine", "Engine vs Engine")
    .separator()
    .check("view-camera-2d", "2D")
    .check("view-camera-3d", "3D")
    .separator()
    .check("view-pov-white", "View from White")
    .check("view-pov-black", "View from Black")
    .separator()
    .check("view-palette-classic", "Board: Classic")
    .check("view-palette-forest", "Board: Forest")
    .check("view-palette-ocean", "Board: Ocean")
    .check("view-palette-slate", "Board: Slate")
    .separator()
    .check("view-style-classic", "Pieces: Classic")
    .check("view-style-modern", "Pieces: Modern")
    .separator()
    .check("view-theme-system", "Theme: System")
    .check("view-theme-light", "Theme: Light")
    .check("view-theme-dark", "Theme: Dark")
    .build()?;

  // Every item built via the `.check()` convenience method above defaults
  // to checked=true (muda's own default, not something this code opts
  // into), so a bare set_checked(..., true) on just the intended default
  // leaves its sibling(s) *also* still true from that same default --
  // apply_radio_check is what actually unchecks the rest of the group,
  // which a plain set_checked call does not do.
  apply_radio_check(&view_menu, "mode-human-vs-engine");
  apply_radio_check(&view_menu, "view-camera-3d");
  apply_radio_check(&view_menu, "view-pov-white");
  apply_radio_check(&view_menu, "view-palette-classic");
  apply_radio_check(&view_menu, "view-style-classic");
  apply_radio_check(&view_menu, "view-theme-system");

  Ok(view_menu)
}

/// Builds the full menu bar: the same App/File/Edit/Window/Help submenus
/// `Menu::default` would build, but with this app's own View submenu
/// (built above) in place of the default's bare one. Structure mirrors
/// `Menu::default`'s own source -- see tauri::menu::Menu::default -- so
/// this stays a superset of the platform default rather than a
/// from-scratch reinvention of it.
pub fn build(app: &App) -> tauri::Result<Menu<Wry>> {
  let pkg_info = app.package_info();
  let config = app.config();
  let about_metadata = AboutMetadata {
    name: Some(pkg_info.name.clone()),
    version: Some(pkg_info.version.to_string()),
    copyright: config.bundle.copyright.clone(),
    authors: config.bundle.publisher.clone().map(|p| vec![p]),
    ..Default::default()
  };

  let view_menu = build_view_submenu(app)?;

  #[cfg(target_os = "macos")]
  let app_menu = SubmenuBuilder::new(app, pkg_info.name.clone())
    .about(Some(about_metadata))
    .separator()
    .services()
    .separator()
    .hide()
    .hide_others()
    .separator()
    .quit()
    .build()?;

  #[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  )))]
  let file_menu = {
    let builder = SubmenuBuilder::new(app, "File").close_window();
    #[cfg(not(target_os = "macos"))]
    let builder = builder.quit();
    builder.build()?
  };

  let edit_menu = SubmenuBuilder::new(app, "Edit")
    .undo()
    .redo()
    .separator()
    .cut()
    .copy()
    .paste()
    .select_all()
    .build()?;

  let window_menu = SubmenuBuilder::new(app, "Window")
    .minimize()
    .maximize()
    .close_window()
    .build()?;

  let menu = MenuBuilder::new(app);
  #[cfg(target_os = "macos")]
  let menu = menu.item(&app_menu);
  #[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  )))]
  let menu = menu.item(&file_menu);
  let menu = menu
    .item(&edit_menu)
    .item(&view_menu)
    .item(&window_menu)
    .build()?;

  app.manage(ViewMenu(view_menu));
  Ok(menu)
}

/// Dispatches a native menu click. Only acts on ids this module's own
/// `GROUPS` own -- a predefined item (Quit, Copy, ...) also fires this
/// same event, and `group_for` returning `None` for those is exactly the
/// signal to leave them alone.
pub fn handle_event(app: &AppHandle, event: MenuEvent) {
  let id = event.id().0.clone();
  if group_for(&id).is_none() {
    return;
  }
  let view_menu = app.state::<ViewMenu>();
  apply_radio_check(&view_menu.0, &id);
  let _ = app.emit("menu-view-action", id);
}

/// Corrects the View menu's checkmarks for the 4 persisted settings
/// (game mode, board palette, piece style, theme) once the frontend has
/// mounted and read its own restored localStorage state -- see
/// `build_view_submenu`'s doc comment for why only these (not camera/POV)
/// need this.
#[tauri::command]
pub fn sync_view_menu(
  app: AppHandle,
  mode_id: String,
  palette_id: String,
  style_id: String,
  theme_id: String,
) {
  let view_menu = app.state::<ViewMenu>();
  apply_radio_check(&view_menu.0, &mode_id);
  apply_radio_check(&view_menu.0, &palette_id);
  apply_radio_check(&view_menu.0, &style_id);
  apply_radio_check(&view_menu.0, &theme_id);
}

/// Enables or disables the whole game-mode group at once -- switching
/// modes mid-game would hide the panel controlling whatever's actually
/// running (an engine process, a Lichess connection) with no way to see
/// its status or stop it, same reasoning the old sidebar selector's
/// `disabled` prop had. The frontend calls this whenever
/// `gameStore.mode` changes.
#[tauri::command]
pub fn set_game_mode_menu_enabled(app: AppHandle, enabled: bool) {
  let view_menu = app.state::<ViewMenu>();
  for id in MODE_IDS {
    set_enabled(&view_menu.0, id, enabled);
  }
}
