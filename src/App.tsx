import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardPaletteSelect } from "./components/BoardPaletteSelect";
import { BoardScene } from "./components/BoardScene";
import { EngineControls } from "./components/EngineControls";
import { EngineOptions } from "./components/EngineOptions";
import { GameLoader } from "./components/GameLoader";
import { LichessControls } from "./components/LichessControls";
import { MoveList } from "./components/MoveList";
import { MoveLog } from "./components/MoveLog";
import { PlaybackControls } from "./components/PlaybackControls";
import { ThemeToggle } from "./components/ThemeToggle";
import { useAppliedTheme } from "./hooks/useAppliedTheme";
import { fenAtPly } from "./lib/chessRules";
import { useGameStore } from "./state/gameStore";
import "./App.css";

function App() {
  const theme = useAppliedTheme();
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const setCameraMode = useGameStore((s) => s.setCameraMode);
  const fen = fenAtPly(plies, ply);

  return (
    <div className="app">
      <header className="app-header">
        <h1>chess-board</h1>
        <div className="app-header-controls">
          <button
            className="camera-toggle"
            onClick={() => setCameraMode(cameraMode === "2d" ? "3d" : "2d")}
          >
            View: {cameraMode.toUpperCase()}
          </button>
          <BoardPaletteSelect />
          <ThemeToggle />
        </div>
      </header>
      <main className="app-body">
        <div className="board-panel">
          <BoardScene fen={fen} cameraMode={cameraMode} theme={theme} />
          <PlaybackControls />
        </div>
        <aside className="side-panel">
          <EngineControls />
          <EngineOptions />
          <AnalysisPanel />
          <LichessControls />
          <GameLoader />
          <MoveList />
          <MoveLog />
        </aside>
      </main>
    </div>
  );
}

export default App;
