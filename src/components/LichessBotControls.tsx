import { useState } from "react";
import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import { useEngineStore } from "../state/engineStore";
import { useLichessBotStore } from "../state/lichessBotStore";

const UPGRADE_CONFIRM_TEXT = "UPGRADE";

export function LichessBotControls() {
  const [confirmText, setConfirmText] = useState("");

  const enginePath = useEngineStore((s) => s.path);

  const status = useLichessBotStore((s) => s.status);
  const errorMessage = useLichessBotStore((s) => s.errorMessage);
  const activeGameId = useLichessBotStore((s) => s.activeGameId);
  const upgradeToBotAccount = useLichessBotStore((s) => s.upgradeToBotAccount);
  const startListening = useLichessBotStore((s) => s.startListening);
  const stopListening = useLichessBotStore((s) => s.stopListening);

  const listening = status === "listening" || status === "playing";
  const canUpgrade = confirmText.trim().toUpperCase() === UPGRADE_CONFIRM_TEXT;

  async function upgrade() {
    if (await upgradeToBotAccount()) setConfirmText("");
  }

  return (
    <div className="lichess-controls">
      <h2>Bridge engine to Lichess (Bot API)</h2>
      <p className="hint">
        Upgrading to a Bot account is <strong>irreversible</strong> -- a bot account can
        never play rated games as a human again, nor be converted back. Only do this on an
        account you're dedicating to running engines.
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

      {!enginePath && <p className="hint">Choose an engine binary above first.</p>}
      {!listening ? (
        <button onClick={() => startListening()} disabled={!enginePath}>
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
    </div>
  );
}
