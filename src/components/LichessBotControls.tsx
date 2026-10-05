import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import { parseBotOnlineList, type LichessBotSummary } from "../lib/lichess";
import {
  categoryFor,
  matchPreset,
  TIME_CONTROL_PRESETS,
} from "../lib/lichessTimeControl";
import { ENGINE_NOT_RUNNING, useWhiteEngineStore } from "../state/engineStore";
import { parseRateLimitSeconds, useLichessBotStore } from "../state/lichessBotStore";
import { EngineOptions } from "./EngineOptions";

const UPGRADE_CONFIRM_TEXT = "UPGRADE";
const BOTS_TO_LIST = 200;

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
  const [challengingUsername, setChallengingUsername] = useState<string | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const hasToken = useLichessBotStore((s) => s.hasToken);
  const verifiedAccount = useLichessBotStore((s) => s.verifiedAccount);
  const verifyError = useLichessBotStore((s) => s.verifyError);
  const refreshHasToken = useLichessBotStore((s) => s.refreshHasToken);
  const setToken = useLichessBotStore((s) => s.setToken);
  const clearToken = useLichessBotStore((s) => s.clearToken);
  const lastOutgoingDecline = useLichessBotStore((s) => s.lastOutgoingChallengeDecline);
  const declinedBots = useLichessBotStore((s) => s.declinedBots);
  const clearOutgoingChallengeDecline = useLichessBotStore(
    (s) => s.clearOutgoingChallengeDecline,
  );
  const recordBotChallengeFailure = useLichessBotStore((s) => s.recordBotChallengeFailure);
  const verifyAccount = useLichessBotStore((s) => s.verifyAccount);
  const oauthLogin = useLichessBotStore((s) => s.oauthLogin);
  const cancelOauthLogin = useLichessBotStore((s) => s.cancelOauthLogin);
  const [oauthInFlight, setOauthInFlight] = useState(false);

  const enginePath = useLichessBotStore((s) => s.enginePath);
  const setEnginePath = useLichessBotStore((s) => s.setEnginePath);
  const movetimeMs = useLichessBotStore((s) => s.movetimeMs);
  const setMovetimeMs = useLichessBotStore((s) => s.setMovetimeMs);
  const acceptRated = useLichessBotStore((s) => s.acceptRated);
  const setAcceptRated = useLichessBotStore((s) => s.setAcceptRated);
  const color = useLichessBotStore((s) => s.challengeColor);
  const setColor = useLichessBotStore((s) => s.setChallengeColor);
  const sendRated = useLichessBotStore((s) => s.sendRated);
  const setSendRated = useLichessBotStore((s) => s.setSendRated);
  const clockLimitMinutes = useLichessBotStore((s) => s.clockLimitMinutes);
  const setClockLimitMinutes = useLichessBotStore((s) => s.setClockLimitMinutes);
  const clockIncrementSeconds = useLichessBotStore((s) => s.clockIncrementSeconds);
  const setClockIncrementSeconds = useLichessBotStore((s) => s.setClockIncrementSeconds);
  const lagMarginMs = useLichessBotStore((s) => s.lagMarginMs);
  const setLagMarginMs = useLichessBotStore((s) => s.setLagMarginMs);

  // The preview affordance spawns the engine on the White store so the
  // operator can see what options the engine advertises before accepting
  // a challenge. White is arbitrary -- bot mode doesn't know its assigned
  // color until Lichess sends `gameFull`. `handleGameStart` copies
  // White's `optionOverrides` to the resolved side if Black is assigned,
  // so edits in the preview apply regardless of color.
  const previewEngineStatus = useWhiteEngineStore((s) => s.status);
  const previewEnginePath = useWhiteEngineStore((s) => s.path);
  const startPreviewEngine = useWhiteEngineStore((s) => s.startEngine);
  const stopPreviewEngine = useWhiteEngineStore((s) => s.stopEngine);
  const previewReady = previewEngineStatus === "ready";

  const status = useLichessBotStore((s) => s.status);
  const errorMessage = useLichessBotStore((s) => s.errorMessage);
  const activeGameId = useLichessBotStore((s) => s.activeGameId);
  const upgradeToBotAccount = useLichessBotStore((s) => s.upgradeToBotAccount);
  const startListening = useLichessBotStore((s) => s.startListening);
  const stopListening = useLichessBotStore((s) => s.stopListening);
  const autoRunning = useLichessBotStore((s) => s.autoRunning);
  const autoRunQueue = useLichessBotStore((s) => s.autoRunQueue);
  const autoRunCurrentUsername = useLichessBotStore((s) => s.autoRunCurrentUsername);
  const startAutoRun = useLichessBotStore((s) => s.startAutoRun);
  const stopAutoRun = useLichessBotStore((s) => s.stopAutoRun);

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

  // Auto-start listening once per mount when every precondition is
  // satisfied: a valid token, a verified bot account, and an engine
  // picked. The ref latch ensures we only auto-start a single time --
  // if the user manually clicks Stop afterwards, the status returns
  // to "idle" but we don't retry. The same latch also prevents a
  // retry after a `startListening` failure (status "error"), so the
  // user has to click the button themselves to opt back in.
  const didAutoStartRef = useRef(false);
  useEffect(() => {
    if (didAutoStartRef.current) return;
    if (canListen && status === "idle") {
      didAutoStartRef.current = true;
      void startListening();
    }
  }, [canListen, status, startListening]);

  // Auto-start auto-run once per mount, right after the auto-start-
  // listening transition above lands us in "listening". Same latch
  // discipline as didAutoStartRef: fires exactly once, so clicking
  // Stop auto-run returns to listening without a retry loop. The
  // guard on `!autoRunning` is defensive -- the latch handles the
  // one-shot semantics on its own, but it also keeps us from
  // scheduling a redundant startAutoRun if hot-reload re-renders the
  // component while auto-run is already going.
  const didAutoRunRef = useRef(false);
  useEffect(() => {
    if (didAutoRunRef.current) return;
    if (status === "listening" && !autoRunning) {
      didAutoRunRef.current = true;
      startAutoRun();
    }
  }, [status, autoRunning, startAutoRun]);

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

  async function signIn() {
    setOauthInFlight(true);
    try {
      await oauthLogin();
    } finally {
      setOauthInFlight(false);
    }
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
    // Clear any previous decline banner -- the user is initiating a
    // fresh attempt, so the old "X declined: ..." is no longer current.
    clearOutgoingChallengeDecline();
    setChallengingUsername(username);
    try {
      await invoke("lichess_challenge_bot", {
        username,
        clockLimitSeconds: clockLimitMinutes * 60,
        clockIncrementSeconds,
        color,
        rated: sendRated,
      });
      // Success means the POST landed -- Lichess has queued the
      // challenge. Whether the target accepts is a separate async
      // signal (`challengeDeclined` or `gameStart` on the event
      // stream); surfaced by `lastOutgoingDecline`/game-start handler.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setChallengeError(message);
      // POST failed (400 rate limit, offline, etc.) -- hide them from
      // the list. When Lichess tells us the exact rate-limit window
      // via `"ratelimit":{"seconds":N}`, use it; otherwise the store
      // falls back to a 24 h TTL (one `bot.vsBot.day` reset cycle).
      const rateLimitSeconds = parseRateLimitSeconds(message) ?? undefined;
      recordBotChallengeFailure(username, rateLimitSeconds);
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
        <>
          {oauthInFlight ? (
            <>
              <p className="hint">
                Waiting for browser… approve the request on Lichess as your BOT
                account, or click Cancel to retry.
              </p>
              <button onClick={() => void cancelOauthLogin()}>Cancel sign-in</button>
            </>
          ) : (
            <button onClick={signIn}>Sign in with Lichess (BOT account)</button>
          )}
          <p className="hint">
            Opens a browser tab to Lichess so you can approve the bot:play and
            challenge:write scopes. Or paste a token directly below — either way, it's
            stored in your OS keychain, not in the app.
          </p>
          <div className="lichess-token-field">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Personal access token (bot:play + challenge:write)"
              disabled={oauthInFlight}
            />
            <button onClick={saveToken} disabled={!tokenInput.trim() || oauthInFlight}>
              Save bot token
            </button>
          </div>
        </>
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
        Movetime cap (ms)
        <input
          type="number"
          min={100}
          step={100}
          value={movetimeMs}
          onChange={(e) => setMovetimeMs(Number(e.target.value))}
          disabled={listening}
        />
      </label>
      <label className="engine-field">
        Lag margin (ms)
        <input
          type="number"
          min={0}
          step={10}
          value={lagMarginMs}
          onChange={(e) => setLagMarginMs(Number(e.target.value))}
          disabled={listening}
        />
      </label>
      <label className="engine-field">
        <input
          type="checkbox"
          checked={acceptRated}
          onChange={(e) => setAcceptRated(e.target.checked)}
          disabled={listening}
        />
        Accept rated challenges (off by default — a testing bot affects real
        opponents&rsquo; ratings)
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

      <h3>Engine options</h3>
      <p className="hint">
        Spawn the engine briefly to inspect and tweak its UCI options (UseNNUE,
        Hash, EvalFile, &hellip;) before accepting a challenge. Edits persist across
        sessions. Not available during a live game &mdash; the panel below
        appears automatically when a game is in progress.
      </p>
      {status === "playing" ? (
        // During a live game, EngineOptions renders via the normal
        // controller-based path (gameStore.controllers[side] === "engine").
        // Rendering it here with a forced side would double-render; let
        // the outer App-level EngineOptions handle it.
        <p className="hint">Game in progress &mdash; see the options panel below.</p>
      ) : !previewReady ? (
        <button
          onClick={() => enginePath && void startPreviewEngine(enginePath)}
          disabled={!enginePath || !ENGINE_NOT_RUNNING.has(previewEngineStatus)}
        >
          {previewEngineStatus === "starting" ? "Starting…" : "Preview engine options"}
        </button>
      ) : (
        <>
          <button onClick={() => void stopPreviewEngine()}>Stop preview</button>
          <EngineOptions side="w" />
          {previewEnginePath && previewEnginePath !== enginePath && (
            <p className="hint">
              Previewing a different engine ({deriveEngineIdentifier(previewEnginePath)}) than
              the one currently chosen ({enginePath ? deriveEngineIdentifier(enginePath) : "none"})
              &mdash; click Stop preview, pick again, then re-open preview.
            </p>
          )}
        </>
      )}

      <h3>Challenge an engine on Lichess</h3>
      <p className="hint">
        Needs "Start listening" above running first, so the resulting game has somewhere
        to land. Default casual; tick "Rated" to affect both bots&rsquo; ratings.
      </p>
      <div className="lichess-token-field">
        <label className="engine-field">
          Time control
          <select
            value={matchPreset(clockLimitMinutes, clockIncrementSeconds)?.label ?? "custom"}
            onChange={(e) => {
              const preset = TIME_CONTROL_PRESETS.find((p) => p.label === e.target.value);
              if (preset) {
                setClockLimitMinutes(preset.clockLimitMinutes);
                setClockIncrementSeconds(preset.clockIncrementSeconds);
              }
            }}
          >
            {TIME_CONTROL_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.label}>
                {preset.label}
              </option>
            ))}
            <option value="custom" disabled>
              Custom ({clockLimitMinutes}+{clockIncrementSeconds})
            </option>
          </select>
        </label>
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
        <label className="engine-field">
          <input
            type="checkbox"
            checked={sendRated}
            onChange={(e) => setSendRated(e.target.checked)}
          />
          Rated
        </label>
      </div>
      <p className="hint">
        Category: {categoryFor(clockLimitMinutes, clockIncrementSeconds)} — rated games
        update the {categoryFor(clockLimitMinutes, clockIncrementSeconds).toLowerCase()}{" "}
        rating pool.
      </p>
      <button onClick={browseBots} disabled={loadingBots}>
        {loadingBots ? "Loading…" : "Browse online bots"}
      </button>
      {!autoRunning ? (
        <button onClick={startAutoRun} disabled={!canChallenge}>
          Auto-run matches
        </button>
      ) : (
        <button onClick={stopAutoRun}>Stop auto-run</button>
      )}
      {autoRunning && (
        <p className="hint">
          Auto-running:{" "}
          {autoRunCurrentUsername
            ? `trying ${autoRunCurrentUsername}`
            : autoRunQueue.length > 0
              ? "picking next bot…"
              : "refreshing bot list…"}
          {autoRunQueue.length > 0 && ` (${autoRunQueue.length} left in cycle)`}
        </p>
      )}
      {challengeError && <p className="load-error">{challengeError}</p>}
      {lastOutgoingDecline && (
        <p className="hint">
          {lastOutgoingDecline.username ?? "Opponent"} declined
          {lastOutgoingDecline.reason ? `: ${lastOutgoingDecline.reason}` : ""}
        </p>
      )}
      {(() => {
        // Filter out bots whose decline entry hasn't yet expired. The
        // store already prunes expired entries on rehydrate; this
        // live check catches entries that expire mid-render (user left
        // the panel open past the TTL boundary). Matches the user's
        // intent: "I don't want bots I can't play to even show up".
        const now = Date.now();
        const activeDeclines = new Set(
          declinedBots.filter((e) => e.expiresAtMs > now).map((e) => e.username),
        );
        const visible = bots.filter((b) => !activeDeclines.has(b.username));
        const hiddenCount = bots.length - visible.length;
        return (
          <>
            {hiddenCount > 0 && (
              <p className="hint">
                {hiddenCount} bot{hiddenCount === 1 ? "" : "s"} hidden (previously declined
                or rate-limited; they'll return once their quota resets).
              </p>
            )}
            {visible.length > 0 && (
              <ul className="lichess-bot-list">
                {visible.map((bot) => (
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
          </>
        );
      })()}
    </div>
  );
}
