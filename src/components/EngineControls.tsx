import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import {
  engineStoreForSide,
  useBlackEngineStore,
  useWhiteEngineStore,
  type Side,
} from "../state/engineStore";
import { useGameStore, type Controller } from "../state/gameStore";

const RUNNING_STATUSES = new Set(["starting", "ready", "thinking"]);

function engineLabel(path: string | null, status: string): string {
  if (!path) return "Choose engine binary…";
  const identifier = deriveEngineIdentifier(path);
  if (status === "ready" || status === "thinking") return `Running: ${identifier}`;
  if (status === "starting") return `Starting: ${identifier}…`;
  return `Engine: ${identifier}`;
}

function SidePicker({
  side,
  label,
  controller,
  onControllerChange,
  disabled,
}: {
  side: Side;
  label: string;
  controller: Controller;
  onControllerChange: (controller: Controller) => void;
  disabled: boolean;
}) {
  const store = engineStoreForSide(side);
  const path = store((s) => s.path);
  const status = store((s) => s.status);
  const movetimeMs = store((s) => s.movetimeMs);
  const setPath = store((s) => s.setPath);
  const setMovetimeMs = store((s) => s.setMovetimeMs);

  async function chooseEngine() {
    const picked = await open({ multiple: false });
    if (!picked || Array.isArray(picked)) return;
    setPath(picked);
  }

  return (
    <div className="side-picker">
      <label className="engine-field">
        {label}
        <select
          value={controller}
          onChange={(e) => onControllerChange(e.target.value as Controller)}
          disabled={disabled}
        >
          <option value="human">Human</option>
          <option value="engine">Engine</option>
        </select>
      </label>
      {controller === "engine" && (
        <>
          <button onClick={chooseEngine} disabled={disabled}>
            {engineLabel(path, status)}
          </button>
          <label className="engine-field">
            Movetime (ms)
            <input
              type="number"
              min={100}
              step={100}
              value={movetimeMs}
              onChange={(e) => setMovetimeMs(Number(e.target.value))}
              disabled={disabled}
            />
          </label>
        </>
      )}
    </div>
  );
}

export function EngineControls() {
  const [whiteController, setWhiteController] = useState<Controller>("human");
  const [blackController, setBlackController] = useState<Controller>("engine");

  const mode = useGameStore((s) => s.mode);
  const startNewGame = useGameStore((s) => s.startNewGame);
  const playbackDelayMs = useGameStore((s) => s.playbackDelayMs);
  const setPlaybackDelayMs = useGameStore((s) => s.setPlaybackDelayMs);

  const whiteStatus = useWhiteEngineStore((s) => s.status);
  const blackStatus = useBlackEngineStore((s) => s.status);
  const whiteError = useWhiteEngineStore((s) => s.errorMessage);
  const blackError = useBlackEngineStore((s) => s.errorMessage);
  const whitePath = useWhiteEngineStore((s) => s.path);
  const blackPath = useBlackEngineStore((s) => s.path);

  const whiteRunning = whiteController === "engine" && RUNNING_STATUSES.has(whiteStatus);
  const blackRunning = blackController === "engine" && RUNNING_STATUSES.has(blackStatus);
  const running = whiteRunning || blackRunning;
  const fullyAutomated = whiteController === "engine" && blackController === "engine";

  async function start() {
    // Resets the board but leaves moves locked (mode stays "replay") --
    // enterPlayMode only fires below, once every engine this game actually
    // needs has confirmed it started. Unlocking as soon as the *first* of
    // two requested engines is ready would let a move happen before we
    // know whether the other side's engine will start at all.
    startNewGame({ w: whiteController, b: blackController });

    const starts: Promise<void>[] = [];
    if (whiteController === "engine" && whitePath) {
      starts.push(useWhiteEngineStore.getState().startEngine(whitePath));
    }
    if (blackController === "engine" && blackPath) {
      starts.push(useBlackEngineStore.getState().startEngine(blackPath));
    }
    await Promise.all(starts);

    const whiteOk = whiteController !== "engine" || useWhiteEngineStore.getState().status === "ready";
    const blackOk = blackController !== "engine" || useBlackEngineStore.getState().status === "ready";
    if (whiteOk && blackOk) {
      useGameStore.getState().enterPlayMode();
      // Neither side's own append-a-ply subscription fired yet (mode just
      // flipped, nothing was appended) -- nudge both explicitly so the
      // side to move actually starts, whether that's White or Black.
      useWhiteEngineStore.getState().checkTurn();
      useBlackEngineStore.getState().checkTurn();
    }
  }

  async function stop() {
    if (whiteController === "engine") await useWhiteEngineStore.getState().stopEngine();
    if (blackController === "engine") await useBlackEngineStore.getState().stopEngine();
  }

  const canStart =
    (whiteController === "human" || !!whitePath) && (blackController === "human" || !!blackPath);

  return (
    <div className="engine-controls">
      <h2>Play</h2>
      <SidePicker
        side="w"
        label="White"
        controller={whiteController}
        onControllerChange={setWhiteController}
        disabled={running}
      />
      <SidePicker
        side="b"
        label="Black"
        controller={blackController}
        onControllerChange={setBlackController}
        disabled={running}
      />
      {fullyAutomated && (
        <label className="engine-field">
          Playback speed (ms)
          <input
            type="number"
            min={0}
            step={100}
            value={playbackDelayMs}
            onChange={(e) => setPlaybackDelayMs(Number(e.target.value))}
            disabled={running}
          />
        </label>
      )}
      {!running ? (
        <button onClick={start} disabled={!canStart}>
          Start game
        </button>
      ) : (
        <button onClick={stop}>Stop</button>
      )}
      <p className="engine-status">
        White: {whiteController === "engine" ? whiteStatus : "human"} · Black:{" "}
        {blackController === "engine" ? blackStatus : "human"}
      </p>
      {whiteError && <p className="load-error">White: {whiteError}</p>}
      {blackError && <p className="load-error">Black: {blackError}</p>}
      {mode === "play" && (
        <p className="hint">Click a piece, then click a highlighted square to move.</p>
      )}
    </div>
  );
}
