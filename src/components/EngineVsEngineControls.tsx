import { open } from "@tauri-apps/plugin-dialog";
import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import { useBlackEngineStore, useWhiteEngineStore, type EngineStoreHook } from "../state/engineStore";
import { useGameStore } from "../state/gameStore";

const RUNNING_STATUSES = new Set(["starting", "ready", "thinking"]);

function EngineSlot({ label, useEngine }: { label: string; useEngine: EngineStoreHook }) {
  const path = useEngine((s) => s.path);
  const status = useEngine((s) => s.status);
  const movetimeMs = useEngine((s) => s.movetimeMs);
  const setPath = useEngine((s) => s.setPath);
  const setMovetimeMs = useEngine((s) => s.setMovetimeMs);
  const lastInfo = useEngine((s) => s.lastInfo);
  const errorMessage = useEngine((s) => s.errorMessage);
  const running = RUNNING_STATUSES.has(status);

  async function chooseEngine() {
    const picked = await open({ multiple: false });
    if (!picked || Array.isArray(picked)) return;
    setPath(picked);
  }

  return (
    <div className="engine-vs-engine-slot">
      <h3>{label}</h3>
      <button onClick={chooseEngine} disabled={running}>
        {path ? deriveEngineIdentifier(path) : "Choose engine binary…"}
      </button>
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
    </div>
  );
}

/** Two independent local engines, no human/Lichess side at all. No color
 * picker like EngineControls -- this mode already fixes both sides to
 * "engine", the two slots below are just White's and Black's own binary
 * choices. */
export function EngineVsEngineControls() {
  const whitePath = useWhiteEngineStore((s) => s.path);
  const blackPath = useBlackEngineStore((s) => s.path);
  const whiteStatus = useWhiteEngineStore((s) => s.status);
  const blackStatus = useBlackEngineStore((s) => s.status);
  const startWhite = useWhiteEngineStore((s) => s.startEngine);
  const startBlack = useBlackEngineStore((s) => s.startEngine);
  const stopWhite = useWhiteEngineStore((s) => s.stopEngine);
  const stopBlack = useBlackEngineStore((s) => s.stopEngine);
  const checkTurnWhite = useWhiteEngineStore((s) => s.checkTurn);
  const checkTurnBlack = useBlackEngineStore((s) => s.checkTurn);

  const playbackDelayMs = useGameStore((s) => s.playbackDelayMs);
  const setPlaybackDelayMs = useGameStore((s) => s.setPlaybackDelayMs);
  const startNewGame = useGameStore((s) => s.startNewGame);
  const enterPlayMode = useGameStore((s) => s.enterPlayMode);
  const mode = useGameStore((s) => s.mode);

  const running = RUNNING_STATUSES.has(whiteStatus) || RUNNING_STATUSES.has(blackStatus);

  async function start() {
    if (!whitePath || !blackPath) return;
    // Same ordering/reasoning as EngineControls.start(), doubled: reset
    // the board before either engine reports ready, and only unlock moves
    // once *both* requested engines have confirmed ready -- unlocking on
    // the first one to finish would let the position move before anyone
    // knows whether the other engine will start at all.
    startNewGame({ w: "engine", b: "engine" });
    await Promise.all([startWhite(whitePath), startBlack(blackPath)]);
    const bothReady =
      useWhiteEngineStore.getState().status === "ready" &&
      useBlackEngineStore.getState().status === "ready";
    if (!bothReady) {
      // Don't leave a successfully-started engine dangling with no game
      // to play if the other one failed.
      void stopWhite();
      void stopBlack();
      return;
    }
    enterPlayMode();
    checkTurnWhite();
    checkTurnBlack();
  }

  function stop() {
    void stopWhite();
    void stopBlack();
  }

  return (
    <div className="engine-controls">
      <h2>Engine vs. Engine</h2>
      <EngineSlot label="White" useEngine={useWhiteEngineStore} />
      <EngineSlot label="Black" useEngine={useBlackEngineStore} />
      <label className="engine-field">
        Playback delay (ms)
        <input
          type="number"
          min={0}
          step={100}
          value={playbackDelayMs}
          onChange={(e) => setPlaybackDelayMs(Number(e.target.value))}
          disabled={running}
        />
      </label>
      {!running ? (
        <button onClick={start} disabled={!whitePath || !blackPath}>
          Start game
        </button>
      ) : (
        <button onClick={stop}>Stop</button>
      )}
      {mode === "play" && (
        <p className="hint">Watching -- both sides are engines, there's nothing to click.</p>
      )}
    </div>
  );
}
