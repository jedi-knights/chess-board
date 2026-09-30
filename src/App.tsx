import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardScene } from "./components/BoardScene";
import { EngineControls } from "./components/EngineControls";
import { EngineOptions } from "./components/EngineOptions";
import { EngineVsEngineControls } from "./components/EngineVsEngineControls";
import { GameLoader } from "./components/GameLoader";
import { LichessBotControls } from "./components/LichessBotControls";
import { LichessControls } from "./components/LichessControls";
import { MoveList } from "./components/MoveList";
import { MoveLog } from "./components/MoveLog";
import { PlaybackControls } from "./components/PlaybackControls";
import { useAppliedTheme } from "./hooks/useAppliedTheme";
import { useViewMenu } from "./hooks/useViewMenu";
import { fenAtPly } from "./lib/chessRules";
import { GAME_MODE_LABELS, useGameModeStore } from "./state/gameModeStore";
import { useGameStore } from "./state/gameStore";
import "./App.css";

function App() {
  const theme = useAppliedTheme();
  // Game mode, camera mode, POV, board palette, piece style, and theme
  // are all set via the native View menu now (src-tauri/src/menu.rs +
  // hooks/useViewMenu.ts) -- the sidebar/header used to hold a control
  // for each one directly.
  useViewMenu();
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const fen = fenAtPly(plies, ply);
  const gameModePreset = useGameModeStore((s) => s.preset);

  return (
    <div className="app">
      <header className="app-header">
        <h1>{GAME_MODE_LABELS[gameModePreset]}</h1>
      </header>
      <main className="app-body">
        <div className="board-panel">
          <BoardScene fen={fen} cameraMode={cameraMode} theme={theme} />
          <PlaybackControls />
        </div>
        <aside className="side-panel">
          {gameModePreset === "human-vs-engine" && <EngineControls />}
          {gameModePreset === "human-vs-lichess" && <LichessControls />}
          {gameModePreset === "engine-vs-lichess" && <LichessBotControls />}
          {gameModePreset === "engine-vs-engine" && <EngineVsEngineControls />}
          <EngineOptions />
          <AnalysisPanel />
          <GameLoader />
          <MoveList />
          <MoveLog />
        </aside>
      </main>
    </div>
  );
}

export default App;
