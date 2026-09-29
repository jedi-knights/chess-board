import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import { useEngineStore } from "../state/engineStore";
import { useGameStore } from "../state/gameStore";

const RUNNING_STATUSES = new Set(["starting", "ready", "thinking"]);

function engineLabel(path: string | null, status: string): string {
  if (!path) return "Choose engine binary…";
  const identifier = deriveEngineIdentifier(path);
  if (status === "ready" || status === "thinking") return `Running: ${identifier}`;
  if (status === "starting") return `Starting: ${identifier}…`;
  return `Engine: ${identifier}`;
}

export function EngineControls() {
  const [humanColor, setHumanColor] = useState<"w" | "b">("w");

  const path = useEngineStore((s) => s.path);
  const status = useEngineStore((s) => s.status);
  const movetimeMs = useEngineStore((s) => s.movetimeMs);
  const setPath = useEngineStore((s) => s.setPath);
  const setMovetimeMs = useEngineStore((s) => s.setMovetimeMs);
  const startEngine = useEngineStore((s) => s.startEngine);
  const stopEngine = useEngineStore((s) => s.stopEngine);
  const errorMessage = useEngineStore((s) => s.errorMessage);
  const lastInfo = useEngineStore((s) => s.lastInfo);

  const startNewGame = useGameStore((s) => s.startNewGame);
  const mode = useGameStore((s) => s.mode);

  const running = RUNNING_STATUSES.has(status);

  async function chooseEngine() {
    const picked = await open({ multiple: false });
    if (!picked || Array.isArray(picked)) return;
    setPath(picked);
  }

  async function start() {
    if (!path) return;
    // Reset the game to a clean, empty position *before* the engine
    // reports ready -- otherwise, on a restart, the engine's post-ready
    // turn check can fire against the previous game's leftover position
    // and its (stale) reply lands on the fresh game as an "illegal move".
    // startNewGame deliberately leaves moves locked (mode stays "replay");
    // startEngine only unlocks them (enterPlayMode) once it has confirmed
    // the engine actually started -- see gameStore.startNewGame's comment.
    startNewGame(humanColor);
    await startEngine(path);
  }

  return (
    <div className="engine-controls">
      <h2>Play vs. engine</h2>
      <button onClick={chooseEngine} disabled={running}>
        {engineLabel(path, status)}
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
        <button onClick={start} disabled={!path}>
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
