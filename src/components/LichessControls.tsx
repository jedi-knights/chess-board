import { useEffect, useState } from "react";
import { useGameStore } from "../state/gameStore";
import { useLichessStore } from "../state/lichessStore";

const CONNECTED_STATUSES = new Set(["connecting", "connected"]);

export function LichessControls() {
  const [humanColor, setHumanColor] = useState<"w" | "b">("w");
  const [gameIdInput, setGameIdInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");

  const hasToken = useLichessStore((s) => s.hasToken);
  const status = useLichessStore((s) => s.status);
  const errorMessage = useLichessStore((s) => s.errorMessage);
  const refreshHasToken = useLichessStore((s) => s.refreshHasToken);
  const setToken = useLichessStore((s) => s.setToken);
  const clearToken = useLichessStore((s) => s.clearToken);
  const connect = useLichessStore((s) => s.connect);
  const disconnect = useLichessStore((s) => s.disconnect);

  const startNewGame = useGameStore((s) => s.startNewGame);
  const mode = useGameStore((s) => s.mode);

  const connected = CONNECTED_STATUSES.has(status);

  useEffect(() => {
    void refreshHasToken();
  }, [refreshHasToken]);

  async function saveToken() {
    if (!tokenInput.trim()) return;
    await setToken(tokenInput);
    setTokenInput("");
  }

  async function start() {
    if (!gameIdInput.trim()) return;
    // Same ordering as EngineControls.start(): reset the board *before*
    // the connection is confirmed, so a stale stream event from a previous
    // game can never land on the fresh one -- connect() only unlocks moves
    // (enterPlayMode) once Lichess actually confirms the stream opened.
    startNewGame(
      { w: humanColor === "w" ? "human" : "lichess", b: humanColor === "b" ? "human" : "lichess" },
      humanColor,
    );
    await connect(gameIdInput);
  }

  return (
    <div className="lichess-controls">
      <h2>Play on Lichess</h2>
      {!hasToken ? (
        <div className="lichess-token-field">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Lichess personal access token (board:play scope)"
          />
          <button onClick={saveToken} disabled={!tokenInput.trim()}>
            Save token
          </button>
        </div>
      ) : (
        <div className="lichess-token-field">
          <p className="lichess-token-status">Token saved in the OS keychain.</p>
          <button onClick={clearToken} disabled={connected}>
            Clear token
          </button>
        </div>
      )}

      <input
        type="text"
        value={gameIdInput}
        onChange={(e) => setGameIdInput(e.target.value)}
        placeholder="Lichess game id or URL"
        disabled={connected}
      />
      <label className="engine-field">
        Play as
        <select
          value={humanColor}
          onChange={(e) => setHumanColor(e.target.value === "b" ? "b" : "w")}
          disabled={connected}
        >
          <option value="w">White</option>
          <option value="b">Black</option>
        </select>
      </label>
      {!connected ? (
        <button onClick={start} disabled={!hasToken || !gameIdInput.trim()}>
          Connect
        </button>
      ) : (
        <button onClick={() => disconnect()}>Disconnect</button>
      )}
      <p className="engine-status">Status: {status}</p>
      {errorMessage && <p className="load-error">{errorMessage}</p>}
      {mode === "play" && status === "connected" && (
        <p className="hint">Click a piece, then click a highlighted square to move.</p>
      )}
    </div>
  );
}
