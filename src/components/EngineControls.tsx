import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEngineStore } from "../state/engineStore";
import { useGameStore } from "../state/gameStore";

const RUNNING_STATUSES = new Set(["starting", "ready", "thinking"]);

export function EngineControls() {
  const [enginePath, setEnginePath] = useState<string | null>(null);
  const [humanColor, setHumanColor] = useState<"w" | "b">("w");

  const status = useEngineStore((s) => s.status);
  const movetimeMs = useEngineStore((s) => s.movetimeMs);
  const setMovetimeMs = useEngineStore((s) => s.setMovetimeMs);
  const startEngine = useEngineStore((s) => s.startEngine);
  const stopEngine = useEngineStore((s) => s.stopEngine);
  const errorMessage = useEngineStore((s) => s.errorMessage);
  const lastInfo = useEngineStore((s) => s.lastInfo);

  const startNewGame = useGameStore((s) => s.startNewGame);
  const mode = useGameStore((s) => s.mode);

  const running = RUNNING_STATUSES.has(status);

  async function chooseEngine() {
    const path = await open({ multiple: false });
    if (!path || Array.isArray(path)) return;
    setEnginePath(path);
  }

  async function start() {
    if (!enginePath) return;
    await startEngine(enginePath);
    startNewGame(humanColor);
  }

  return (
    <div className="engine-controls">
      <h2>Play vs. engine</h2>
      <button onClick={chooseEngine} disabled={running}>
        {enginePath ? `Engine: ${enginePath.split("/").pop()}` : "Choose engine binary…"}
      </button>
      <label className="engine-field">
        Play as
        <select
          value={humanColor}
          onChange={(e) => setHumanColor(e.target.value === "b" ? "b" : "w")}
          disabled={running}
        >
          <option value="w">White</option>
          <option value="b">Black</option>
        </select>
      </label>
      <label className="engine-field">
        Movetime (ms)
        <input
          type="number"
          min={100}
          step={100}
          value={movetimeMs}
          onChange={(e) => setMovetimeMs(Number(e.target.value))}
          disabled={running}
        />
      </label>
      {!running ? (
        <button onClick={start} disabled={!enginePath}>
          Start game
        </button>
      ) : (
        <button onClick={() => stopEngine()}>Stop</button>
      )}
      <p className="engine-status">
        Status: {status}
        {lastInfo?.depth !== undefined && ` — depth ${lastInfo.depth}`}
        {lastInfo?.scoreMate !== undefined
          ? `, mate in ${lastInfo.scoreMate}`
          : lastInfo?.scoreCp !== undefined
            ? `, ${lastInfo.scoreCp} cp`
            : ""}
      </p>
      {errorMessage && <p className="load-error">{errorMessage}</p>}
      {mode === "play" && (
        <p className="hint">Click a piece, then click a highlighted square to move.</p>
      )}
    </div>
  );
}
