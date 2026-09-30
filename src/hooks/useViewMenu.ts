import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBoardThemeStore } from "../state/boardThemeStore";
import {
  useBlackEngineStore,
  useWhiteEngineStore,
  type EngineStatus,
} from "../state/engineStore";
import { useGameModeStore } from "../state/gameModeStore";
import { useGameStore } from "../state/gameStore";
import { useLichessBotStore, type LichessBotStatus } from "../state/lichessBotStore";
import { useLichessStore, type LichessStatus } from "../state/lichessStore";
import { usePieceStyleStore } from "../state/pieceStyleStore";
import { useThemeStore } from "../state/themeStore";

// Locking on `mode === "play"` alone missed three real cases: an engine
// "starting"/"ready" between games in engine-vs-engine, a Lichess bot
// account "listening" for its next challenge, and a human seek waiting on
// an opponent -- all are live-session states where switching modes would
// silently drop a running task on the floor.
const LIVE_ENGINE: Set<EngineStatus> = new Set(["starting", "ready", "thinking"]);
const LIVE_LICHESS: Set<LichessStatus> = new Set(["connecting", "connected"]);
const LIVE_LICHESS_BOT: Set<LichessBotStatus> = new Set(["listening", "playing"]);

/** Every native View-menu item id (see src-tauri/src/menu.rs's own
 * `GROUPS`) mapped to the store action it triggers. The menu is the only
 * way to change any of these now -- App.tsx/the sidebar no longer have
 * their own controls for them -- so this is the single place translating
 * a menu click into an actual state change. */
const ACTIONS: Record<string, () => void> = {
  "mode-human-vs-engine": () => useGameModeStore.getState().setPreset("human-vs-engine"),
  "mode-human-vs-lichess": () => useGameModeStore.getState().setPreset("human-vs-lichess"),
  "mode-engine-vs-lichess": () => useGameModeStore.getState().setPreset("engine-vs-lichess"),
  "mode-engine-vs-engine": () => useGameModeStore.getState().setPreset("engine-vs-engine"),
  "view-camera-2d": () => useGameStore.getState().setCameraMode("2d"),
  "view-camera-3d": () => useGameStore.getState().setCameraMode("3d"),
  "view-pov-white": () => useGameStore.getState().setPov("w"),
  "view-pov-black": () => useGameStore.getState().setPov("b"),
  "view-palette-classic": () => useBoardThemeStore.getState().setPalette("classic"),
  "view-palette-forest": () => useBoardThemeStore.getState().setPalette("forest"),
  "view-palette-ocean": () => useBoardThemeStore.getState().setPalette("ocean"),
  "view-palette-slate": () => useBoardThemeStore.getState().setPalette("slate"),
  "view-style-classic": () => usePieceStyleStore.getState().setStyle("classic"),
  "view-style-modern": () => usePieceStyleStore.getState().setStyle("modern"),
  "view-theme-system": () => useThemeStore.getState().setPreference("system"),
  "view-theme-light": () => useThemeStore.getState().setPreference("light"),
  "view-theme-dark": () => useThemeStore.getState().setPreference("dark"),
};

/** Wires the native View menu to this app's stores. Call once at the app
 * root. Three responsibilities:
 *
 * 1. On mount, tells the Rust side which of the 4 *persisted* settings
 *    (game mode, board palette, piece style, theme) actually restored
 *    from localStorage, so the menu's checkmarks match -- the menu is
 *    built with hardcoded defaults (see menu.rs) since Rust has no
 *    visibility into the frontend's localStorage.
 * 2. Listens for the menu's own click events and dispatches them through
 *    `ACTIONS`. The listener's unlisten handle is stored and called on
 *    cleanup -- unlike `engineStore.ts`'s original `listen()` calls
 *    (see that module's own fix), a leaked listener here would double-
 *    dispatch a single click across dev HMR reloads.
 * 3. Keeps the game-mode group's enabled state in sync with whether any
 *    live session is running -- engine starting/ready/thinking, Lichess
 *    connecting/connected, or Lichess bot listening/playing. Switching
 *    modes while any of these are live would silently drop the running
 *    task (an engine mid-search, a challenge stream, a pending seek).
 */
export function useViewMenu() {
  const wStatus = useWhiteEngineStore((s) => s.status);
  const bStatus = useBlackEngineStore((s) => s.status);
  const lichessStatus = useLichessStore((s) => s.status);
  const lichessBotStatus = useLichessBotStore((s) => s.status);
  const anyLive =
    LIVE_ENGINE.has(wStatus) ||
    LIVE_ENGINE.has(bStatus) ||
    LIVE_LICHESS.has(lichessStatus) ||
    LIVE_LICHESS_BOT.has(lichessBotStatus);

  useEffect(() => {
    void invoke("sync_view_menu", {
      modeId: `mode-${useGameModeStore.getState().preset}`,
      paletteId: `view-palette-${useBoardThemeStore.getState().palette}`,
      styleId: `view-style-${usePieceStyleStore.getState().style}`,
      themeId: `view-theme-${useThemeStore.getState().preference}`,
    });

    const unlisten = listen<string>("menu-view-action", (event) => {
      ACTIONS[event.payload]?.();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    void invoke("set_game_mode_menu_enabled", { enabled: !anyLive });
  }, [anyLive]);
}
