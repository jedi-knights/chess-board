import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardPaletteSelect } from "./components/BoardPaletteSelect";
import { BoardScene } from "./components/BoardScene";
import { EngineControls } from "./components/EngineControls";
import { EngineOptions } from "./components/EngineOptions";
import { EngineVsEngineControls } from "./components/EngineVsEngineControls";
import { GameLoader } from "./components/GameLoader";
import { GameModeSelect } from "./components/GameModeSelect";
import { LichessBotControls } from "./components/LichessBotControls";
import { LichessControls } from "./components/LichessControls";
import { MoveList } from "./components/MoveList";
import { MoveLog } from "./components/MoveLog";
import { PieceStyleSelect } from "./components/PieceStyleSelect";
import { PlaybackControls } from "./components/PlaybackControls";
import { ThemeToggle } from "./components/ThemeToggle";
import { useAppliedTheme } from "./hooks/useAppliedTheme";
import { fenAtPly } from "./lib/chessRules";
import { useGameModeStore } from "./state/gameModeStore";
import { useGameStore } from "./state/gameStore";
import "./App.css";

function App() {
  const theme = useAppliedTheme();
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const setCameraMode = useGameStore((s) => s.setCameraMode);
  const pov = useGameStore((s) => s.pov);
  const setPov = useGameStore((s) => s.setPov);
  const playMode = useGameStore((s) => s.mode);
  const fen = fenAtPly(plies, ply);
  const gameModePreset = useGameModeStore((s) => s.preset);

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
          <select
            value={pov}
            onChange={(e) => setPov(e.target.value === "b" ? "b" : "w")}
            title="Which side's home ranks render at the bottom"
          >
            <option value="w">View from: White</option>
            <option value="b">View from: Black</option>
          </select>
          <BoardPaletteSelect />
          <PieceStyleSelect />
          <ThemeToggle />
        </div>
      </header>
      <main className="app-body">
        <div className="board-panel">
          <BoardScene fen={fen} cameraMode={cameraMode} theme={theme} />
          <PlaybackControls />
        </div>
        <aside className="side-panel">
          <GameModeSelect disabled={playMode === "play"} />
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
