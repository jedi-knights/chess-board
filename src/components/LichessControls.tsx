import { useEffect, useState } from "react";
import { useLichessStore, type LichessColor } from "../state/lichessStore";

const CONNECTED_STATUSES = new Set(["connecting", "connected"]);

/** Board API real-time limits -- matches `MAX_TIME_MINUTES` /
 * `MAX_INCREMENT_SECONDS` in `src-tauri/src/lichess.rs`, mirrored so
 * the UI can `min`/`max`-clamp inputs before dispatch. */
const MAX_TIME_MINUTES = 180;
const MAX_INCREMENT_SECONDS = 60;

export function LichessControls() {
  const [tokenInput, setTokenInput] = useState("");

  const [seekMinutes, setSeekMinutes] = useState(5);
  const [seekIncrement, setSeekIncrement] = useState(3);
  const [seekRated, setSeekRated] = useState(false);
  const [seekColor, setSeekColor] = useState<LichessColor>("random");

  const [challengeUsername, setChallengeUsername] = useState("");

  const [aiLevel, setAiLevel] = useState(1);

  const [gameIdInput, setGameIdInput] = useState("");

  const hasToken = useLichessStore((s) => s.hasToken);
  const verifiedAccount = useLichessStore((s) => s.verifiedAccount);
  const verifyError = useLichessStore((s) => s.verifyError);
  const status = useLichessStore((s) => s.status);
  const seekStatus = useLichessStore((s) => s.seekStatus);
  const errorMessage = useLichessStore((s) => s.errorMessage);
  const refreshHasToken = useLichessStore((s) => s.refreshHasToken);
  const setToken = useLichessStore((s) => s.setToken);
  const clearToken = useLichessStore((s) => s.clearToken);
  const verifyAccount = useLichessStore((s) => s.verifyAccount);
  const seek = useLichessStore((s) => s.seek);
  const stopSeek = useLichessStore((s) => s.stopSeek);
  const challengeUser = useLichessStore((s) => s.challengeUser);
  const challengeAi = useLichessStore((s) => s.challengeAi);
  const joinGameById = useLichessStore((s) => s.joinGameById);
  const disconnect = useLichessStore((s) => s.disconnect);

  const connected = CONNECTED_STATUSES.has(status);
  const seeking = seekStatus === "seeking";
  const isBotAccount = verifiedAccount?.isBot === true;
  const canInitiate = hasToken && !!verifiedAccount && !isBotAccount && !connected && !seeking;

  useEffect(() => {
    void refreshHasToken();
  }, [refreshHasToken]);

  useEffect(() => {
    if (hasToken && !verifiedAccount && !verifyError) {
      void verifyAccount();
    }
  }, [hasToken, verifiedAccount, verifyError, verifyAccount]);

  async function saveToken() {
    if (!tokenInput.trim()) return;
    await setToken(tokenInput);
    setTokenInput("");
    await verifyAccount();
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
          <p className="lichess-token-status">
            Token saved in the OS keychain
            {verifiedAccount ? ` — verified as ${verifiedAccount.username}` : ""}
            {isBotAccount ? " (BOT account)" : ""}
          </p>
          <button onClick={clearToken} disabled={connected || seeking}>
            Clear token
          </button>
        </div>
      )}
      {hasToken && isBotAccount && (
        <p className="load-error">
          This is a BOT account. Human mode refuses BOT tokens to protect Lichess fair-play —
          clear this token and put it in the Bot slot under Engine-vs-Lichess mode instead.
        </p>
      )}
      {verifyError && <p className="load-error">{verifyError}</p>}

      {!connected && (
        <>
          <h3>Seek an opponent</h3>
          <p className="hint">
            Posts an open seek to Lichess's real-time lobby. Auto-connects when someone
            accepts.
          </p>
          <div className="lichess-token-field">
            <label className="engine-field">
              Minutes
              <input
                type="number"
                min={0}
                max={MAX_TIME_MINUTES}
                value={seekMinutes}
                onChange={(e) => setSeekMinutes(Number(e.target.value))}
                disabled={!canInitiate}
              />
            </label>
            <label className="engine-field">
              Increment (s)
              <input
                type="number"
                min={0}
                max={MAX_INCREMENT_SECONDS}
                value={seekIncrement}
                onChange={(e) => setSeekIncrement(Number(e.target.value))}
                disabled={!canInitiate}
              />
            </label>
            <label className="engine-field">
              Color
              <select
                value={seekColor}
                onChange={(e) => setSeekColor(e.target.value as LichessColor)}
                disabled={!canInitiate}
              >
                <option value="random">Random</option>
                <option value="white">White</option>
                <option value="black">Black</option>
              </select>
            </label>
            <label className="engine-field">
              <input
                type="checkbox"
                checked={seekRated}
                onChange={(e) => setSeekRated(e.target.checked)}
                disabled={!canInitiate}
              />
              Rated
            </label>
          </div>
          {!seeking ? (
            <button
              onClick={() =>
                seek({
                  time: { minutes: seekMinutes, increment: seekIncrement },
                  rated: seekRated,
                  color: seekColor,
                })
              }
              disabled={!canInitiate}
            >
              Seek an opponent
            </button>
          ) : (
            <button onClick={() => stopSeek()}>Cancel seek</button>
          )}

          <h3>Challenge a user</h3>
          <div className="lichess-token-field">
            <input
              type="text"
              value={challengeUsername}
              onChange={(e) => setChallengeUsername(e.target.value)}
              placeholder="Lichess username"
              disabled={!canInitiate}
            />
            <button
              onClick={() =>
                challengeUser({
                  username: challengeUsername,
                  time: { minutes: seekMinutes, increment: seekIncrement },
                  rated: seekRated,
                  color: seekColor,
                })
              }
              disabled={!canInitiate || !challengeUsername.trim()}
            >
              Challenge
            </button>
          </div>

          <h3>Play the Lichess AI</h3>
          <div className="lichess-token-field">
            <label className="engine-field">
              Level (1–8)
              <input
                type="number"
                min={1}
                max={8}
                value={aiLevel}
                onChange={(e) => setAiLevel(Number(e.target.value))}
                disabled={!canInitiate}
              />
            </label>
            <button
              onClick={() =>
                challengeAi({
                  level: aiLevel,
                  time: { minutes: seekMinutes, increment: seekIncrement },
                  color: seekColor,
                })
              }
              disabled={!canInitiate}
            >
              Play AI level {aiLevel}
            </button>
          </div>

          <h3>Join a game by id</h3>
          <p className="hint">
            Fallback for when a challenge already exists on lichess.org (e.g. someone
            invited you) and you want to play it here.
          </p>
          <div className="lichess-token-field">
            <input
              type="text"
              value={gameIdInput}
              onChange={(e) => setGameIdInput(e.target.value)}
              placeholder="Lichess game id or URL"
              disabled={!canInitiate}
            />
            <button
              onClick={() => joinGameById(gameIdInput)}
              disabled={!canInitiate || !gameIdInput.trim()}
            >
              Connect
            </button>
          </div>
        </>
      )}

      {connected && <button onClick={() => disconnect()}>Disconnect</button>}
      <p className="engine-status">
        Status: {status}
        {seeking ? " (seeking an opponent…)" : ""}
      </p>
      {errorMessage && <p className="load-error">{errorMessage}</p>}
      {status === "connected" && (
        <p className="hint">
          {verifiedAccount ? `Playing as ${verifiedAccount.username}. ` : ""}
          Click a piece, then click a highlighted square to move.
        </p>
      )}
    </div>
  );
}
