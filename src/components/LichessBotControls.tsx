import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import { parseBotOnlineList, type LichessBotSummary } from "../lib/lichess";
import { useLichessBotStore } from "../state/lichessBotStore";

const UPGRADE_CONFIRM_TEXT = "UPGRADE";
const BOTS_TO_LIST = 20;

function ratingsText(ratings: Record<string, number>): string {
  const entries = Object.entries(ratings);
  if (entries.length === 0) return "unrated";
  return entries.map(([perf, rating]) => `${perf} ${rating}`).join(", ");
}

export function LichessBotControls() {
  const [confirmText, setConfirmText] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [bots, setBots] = useState<LichessBotSummary[]>([]);
  const [loadingBots, setLoadingBots] = useState(false);
  const [clockLimitMinutes, setClockLimitMinutes] = useState(5);
  const [clockIncrementSeconds, setClockIncrementSeconds] = useState(3);
  const [color, setColor] = useState<"random" | "white" | "black">("random");
  const [challengingUsername, setChallengingUsername] = useState<string | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const hasToken = useLichessBotStore((s) => s.hasToken);
  const verifiedAccount = useLichessBotStore((s) => s.verifiedAccount);
  const verifyError = useLichessBotStore((s) => s.verifyError);
  const refreshHasToken = useLichessBotStore((s) => s.refreshHasToken);
  const setToken = useLichessBotStore((s) => s.setToken);
  const clearToken = useLichessBotStore((s) => s.clearToken);
  const verifyAccount = useLichessBotStore((s) => s.verifyAccount);

  const enginePath = useLichessBotStore((s) => s.enginePath);
  const setEnginePath = useLichessBotStore((s) => s.setEnginePath);
  const movetimeMs = useLichessBotStore((s) => s.movetimeMs);
  const setMovetimeMs = useLichessBotStore((s) => s.setMovetimeMs);

  const status = useLichessBotStore((s) => s.status);
  const errorMessage = useLichessBotStore((s) => s.errorMessage);
  const activeGameId = useLichessBotStore((s) => s.activeGameId);
  const upgradeToBotAccount = useLichessBotStore((s) => s.upgradeToBotAccount);
  const startListening = useLichessBotStore((s) => s.startListening);
  const stopListening = useLichessBotStore((s) => s.stopListening);

  const listening = status === "listening" || status === "playing";
  const canChallenge = status === "listening";
  const canUpgrade = confirmText.trim().toUpperCase() === UPGRADE_CONFIRM_TEXT;
  const isBotAccount = verifiedAccount?.isBot === true;
  const canListen = hasToken && !!verifiedAccount && isBotAccount && !!enginePath;

  useEffect(() => {
    void refreshHasToken();
  }, [refreshHasToken]);

  // Auto-verify on mount and after a token change; same rationale as
  // LichessControls' auto-verify effect.
  useEffect(() => {
    if (hasToken && !verifiedAccount && !verifyError) {
      void verifyAccount();
    }
  }, [hasToken, verifiedAccount, verifyError, verifyAccount]);

  async function chooseEngine() {
    const picked = await open({ multiple: false });
    if (!picked || Array.isArray(picked)) return;
    setEnginePath(picked);
  }

  async function saveToken() {
    if (!tokenInput.trim()) return;
    await setToken(tokenInput);
    setTokenInput("");
    // Fresh token -> fresh verify. If the user hasn't upgraded this
    // account yet, verify will report isBot=false and the UI shows the
    // "Upgrade to Bot account" panel instead of the listen button.
    await verifyAccount();
  }

  async function upgrade() {
    if (await upgradeToBotAccount()) {
      setConfirmText("");
      // After a successful upgrade, re-verify so the UI reflects the
      // BOT title Lichess just applied. Without this, the "not a BOT
      // account" refusal would persist until the next mount.
      await verifyAccount();
    }
  }

  async function browseBots() {
    setLoadingBots(true);
    setChallengeError(null);
    try {
      const raw = await invoke<string>("lichess_bot_online", { nb: BOTS_TO_LIST });
      setBots(parseBotOnlineList(raw));
    } catch (err) {
      setChallengeError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingBots(false);
    }
  }

  async function challenge(username: string) {
    setChallengeError(null);
    setChallengingUsername(username);
    try {
      await invoke("lichess_challenge_bot", {
        username,
        clockLimitSeconds: clockLimitMinutes * 60,
        clockIncrementSeconds,
        color,
      });
    } catch (err) {
      setChallengeError(err instanceof Error ? err.message : String(err));
    } finally {
      setChallengingUsername(null);
    }
  }

  return (
    <div className="lichess-controls">
      <h2>Bridge engine to Lichess (Bot API)</h2>
      <p className="hint">
        This mode uses its own bot-slot Lichess token, separate from the human slot in
        Play-on-Lichess mode. Use a token from an account you have dedicated to running
        engines — never your regular human account.
      </p>
      {!hasToken ? (
        <div className="lichess-token-field">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Lichess token for the BOT account (bot:play + challenge:write)"
          />
          <button onClick={saveToken} disabled={!tokenInput.trim()}>
            Save bot token
          </button>
        </div>
      ) : (
        <div className="lichess-token-field">
          <p className="lichess-token-status">
            Bot token saved in the OS keychain
            {verifiedAccount ? ` — verified as ${verifiedAccount.username}` : ""}
            {verifiedAccount ? (isBotAccount ? " (BOT account)" : " (not a BOT account)") : ""}
          </p>
          <button onClick={clearToken} disabled={listening}>
            Clear bot token
          </button>
        </div>
      )}
      {verifyError && <p className="load-error">{verifyError}</p>}
      {hasToken && verifiedAccount && !isBotAccount && (
        <>
          <p className="hint">
            This account is not yet a BOT. Upgrading is <strong>irreversible</strong> — a bot
            account can never play rated games as a human again, nor be converted back. Only
            do this on an account you're dedicating to running engines.
          </p>
          <div className="lichess-token-field">
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={`Type "${UPGRADE_CONFIRM_TEXT}" to confirm`}
              disabled={listening}
            />
            <button onClick={upgrade} disabled={!canUpgrade || listening}>
              Upgrade to Bot account
            </button>
          </div>
        </>
      )}

      <button onClick={chooseEngine} disabled={listening}>
        {enginePath ? `Engine: ${deriveEngineIdentifier(enginePath)}` : "Choose engine binary…"}
      </button>
      <label className="engine-field">
        Movetime (ms)
        <input
          type="number"
          min={100}
          step={100}
          value={movetimeMs}
          onChange={(e) => setMovetimeMs(Number(e.target.value))}
          disabled={listening}
        />
      </label>
      {!listening ? (
        <button onClick={() => startListening()} disabled={!canListen}>
          Start listening for challenges
        </button>
      ) : (
        <button onClick={() => stopListening()}>Stop listening</button>
      )}
      <p className="engine-status">
        Status: {status}
        {activeGameId && ` — playing ${activeGameId}`}
        {enginePath && ` (engine: ${deriveEngineIdentifier(enginePath)})`}
      </p>
      {errorMessage && <p className="load-error">{errorMessage}</p>}

      <h3>Challenge an engine on Lichess</h3>
      <p className="hint">
        Needs "Start listening" above running first, so the resulting game has somewhere
        to land. Always unrated.
      </p>
      <div className="lichess-token-field">
        <label className="engine-field">
          Minutes
          <input
            type="number"
            min={1}
            max={60}
            value={clockLimitMinutes}
            onChange={(e) => setClockLimitMinutes(Number(e.target.value))}
          />
        </label>
        <label className="engine-field">
          Increment (s)
          <input
            type="number"
            min={0}
            max={60}
            value={clockIncrementSeconds}
            onChange={(e) => setClockIncrementSeconds(Number(e.target.value))}
          />
        </label>
        <label className="engine-field">
          Color
          <select value={color} onChange={(e) => setColor(e.target.value as typeof color)}>
            <option value="random">Random</option>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
      </div>
      <button onClick={browseBots} disabled={loadingBots}>
        {loadingBots ? "Loading…" : "Browse online bots"}
      </button>
      {challengeError && <p className="load-error">{challengeError}</p>}
      {bots.length > 0 && (
        <ul className="lichess-bot-list">
          {bots.map((bot) => (
            <li key={bot.username}>
              <span>
                {bot.username} — {ratingsText(bot.ratings)}
              </span>
              <button
                onClick={() => challenge(bot.username)}
                disabled={!canChallenge || challengingUsername === bot.username}
              >
                {challengingUsername === bot.username ? "Challenging…" : "Challenge"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
