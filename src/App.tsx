import { useEffect, useState } from "react";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardScene } from "./components/BoardScene";
import { EngineControls } from "./components/EngineControls";
import { EngineOptions } from "./components/EngineOptions";
import { EngineVsEngineControls } from "./components/EngineVsEngineControls";
import { GameLoader } from "./components/GameLoader";
import { LichessBotControls } from "./components/LichessBotControls";
import { LichessControls } from "./components/LichessControls";
import { LiveGameActions } from "./components/LiveGameActions";
import { LiveGameClocks } from "./components/LiveGameClocks";
import { MoveList } from "./components/MoveList";
import { MoveLog } from "./components/MoveLog";
import { PlaybackControls } from "./components/PlaybackControls";
import { SessionControl } from "./components/SessionControl";
import { WinnerBanner } from "./components/WinnerBanner";
import { useAppliedTheme } from "./hooks/useAppliedTheme";
import { useViewMenu } from "./hooks/useViewMenu";
import { fenAtPly } from "./lib/chessRules";
import { GAME_MODE_LABELS, useGameModeStore } from "./state/gameModeStore";
import { useGameStore } from "./state/gameStore";
import "./App.css";

type SideTab = "config" | "moves";

function App() {
  const theme = useAppliedTheme();
  // Game mode, camera mode, POV, board palette, piece style, and theme
  // are all set via the native View menu now (src-tauri/src/menu.rs +
  // hooks/useViewMenu.ts) -- the sidebar/header used to hold a control
  // for each one directly.
  useViewMenu();
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const startFen = useGameStore((s) => s.startFen);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const mode = useGameStore((s) => s.mode);
  const fen = fenAtPly(plies, ply, startFen ?? undefined);
  const gameModePreset = useGameModeStore((s) => s.preset);

  const [sideTab, setSideTab] = useState<SideTab>("config");
  // Not persisted, deliberately -- this is a per-session "give me more
  // board room right now" toggle, not a standing preference like the
  // View menu's settings. Reopening the app should start from the normal
  // layout.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    // Jump to the move log the moment a game actually starts, so the
    // user isn't left looking at the configuration panel (now locked
    // anyway, see the native View menu's game-mode group) while moves
    // are happening off-screen.
    if (mode === "play") {
      setSideTab("moves");
    }
  }, [mode]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>{GAME_MODE_LABELS[gameModePreset]}</h1>
        <SessionControl />
      </header>
      <main className="app-body">
        <div className="board-panel">
          <WinnerBanner />
          <BoardScene fen={fen} cameraMode={cameraMode} theme={theme} />
          <PlaybackControls />
        </div>
        <aside className={sidebarCollapsed ? "side-panel collapsed" : "side-panel"}>
          <button
            className="side-panel-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? "◂" : "▸"}
          </button>
          {/* CSS-hidden, not conditionally unmounted -- same reasoning as
              the tab panels below: collapsing shouldn't reset anything
              (e.g. a running game's controls, an in-progress path pick)
              just because the board needed more room for a moment. */}
          <div className="side-panel-content">
            <div className="side-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={sideTab === "config"}
                className={sideTab === "config" ? "side-tab active" : "side-tab"}
                onClick={() => setSideTab("config")}
              >
                Configuration
              </button>
              <button
                role="tab"
                aria-selected={sideTab === "moves"}
                className={sideTab === "moves" ? "side-tab active" : "side-tab"}
                onClick={() => setSideTab("moves")}
              >
                Move log
              </button>
            </div>
            {/* CSS-hidden, not conditionally unmounted -- EngineControls and
                the other mode panels hold their own local UI state (e.g.
                which color to play as), and unmounting them on every tab
                switch would silently reset it even though nothing the user
                did should have changed it. */}
            <div className={sideTab === "config" ? "side-tab-panel" : "side-tab-panel hidden"}>
              {gameModePreset === "human-vs-engine" && <EngineControls />}
              {gameModePreset === "human-vs-lichess" && <LichessControls />}
              {gameModePreset === "engine-vs-lichess" && <LichessBotControls />}
              {gameModePreset === "engine-vs-engine" && <EngineVsEngineControls />}
              <EngineOptions />
              <AnalysisPanel />
              <GameLoader />
            </div>
            <div className={sideTab === "moves" ? "side-tab-panel" : "side-tab-panel hidden"}>
              <LiveGameClocks />
              <LiveGameActions />
              <MoveList />
              <MoveLog />
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
