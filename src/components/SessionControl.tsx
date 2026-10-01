import { useBlackEngineStore, useWhiteEngineStore } from "../state/engineStore";
import { useGameModeStore } from "../state/gameModeStore";
import { useLichessBotStore } from "../state/lichessBotStore";
import { useLichessStore } from "../state/lichessStore";

/**
 * Context-aware primary session action, rendered in the app header so
 * the user never has to switch sidebar tabs to stop a running session.
 * Before this, Stop lived inside each mode's control panel in the
 * Configuration tab, which auto-flipped to Move log the moment a game
 * started -- the Stop button was then two clicks away, which bit hard
 * on 2026-09-30 while debugging a stuck bot match.
 *
 * The button is deliberately mode-specific rather than a universal
 * verb: "Stop listening" is correct in bot mode but misleading in
 * human-vs-engine mode (where Stop means stopping the engine process,
 * not an open-ended listener). Labels and actions are picked per mode
 * so the button text always matches what will actually happen.
 *
 * Human-vs-Lichess mode has no single Start action (seek, challenge,
 * challenge AI, and join-by-id are four distinct flows) so Start is
 * omitted and Stop/Disconnect is the only action -- the Configuration
 * tab is still where you kick off a human-mode session.
 */
export function SessionControl() {
  const preset = useGameModeStore((s) => s.preset);

  // Pull everything each mode might need, unconditionally -- Zustand
  // selectors with primitive returns are cheap and this is the only
  // place that needs cross-mode state. Pulling conditionally would
  // violate the Rules of Hooks.
  const whiteStatus = useWhiteEngineStore((s) => s.status);
  const whiteStop = useWhiteEngineStore((s) => s.stopEngine);

  const blackStatus = useBlackEngineStore((s) => s.status);
  const blackStop = useBlackEngineStore((s) => s.stopEngine);

  const humanLichessStatus = useLichessStore((s) => s.status);
  const humanLichessSeekStatus = useLichessStore((s) => s.seekStatus);
  const humanLichessDisconnect = useLichessStore((s) => s.disconnect);
  const humanLichessStopSeek = useLichessStore((s) => s.stopSeek);

  const botStatus = useLichessBotStore((s) => s.status);
  const botEnginePath = useLichessBotStore((s) => s.enginePath);
  const botStartListening = useLichessBotStore((s) => s.startListening);
  const botStopListening = useLichessBotStore((s) => s.stopListening);
  const botHasToken = useLichessBotStore((s) => s.hasToken);

  switch (preset) {
    case "human-vs-engine": {
      // The engine's "side" in human-vs-engine mode is whichever one isn't
      // the human. EngineControls owns the detailed start flow (board
      // reset -> engine start -> enterPlayMode -> checkTurn); mirroring
      // the full orchestration here would duplicate logic. Keep this
      // header button narrow: only Stop, and only when the engine is
      // actually running. The Configuration tab remains the single entry
      // point for the start flow since it also owns the engine-path
      // picker, which is a precondition.
      const running = whiteStatus === "ready" || whiteStatus === "thinking" || whiteStatus === "starting";
      const otherRunning =
        blackStatus === "ready" || blackStatus === "thinking" || blackStatus === "starting";
      if (running) {
        return (
          <button className="session-control" onClick={() => void whiteStop()}>
            Stop engine
          </button>
        );
      }
      if (otherRunning) {
        return (
          <button className="session-control" onClick={() => void blackStop()}>
            Stop engine
          </button>
        );
      }
      return null;
    }

    case "engine-vs-engine": {
      // Both engines may be running simultaneously. Stop both when either
      // is live. Start is intentionally omitted -- EngineVsEngineControls
      // owns the paired start sequence and precondition checks (both
      // engine paths selected).
      const anyRunning =
        whiteStatus === "ready" ||
        whiteStatus === "thinking" ||
        whiteStatus === "starting" ||
        blackStatus === "ready" ||
        blackStatus === "thinking" ||
        blackStatus === "starting";
      if (!anyRunning) return null;
      return (
        <button
          className="session-control"
          onClick={() => {
            // Fire-and-forget: both stops happen in parallel. Order
            // doesn't matter -- each store's stopEngine is independent.
            void whiteStop();
            void blackStop();
          }}
        >
          Stop both engines
        </button>
      );
    }

    case "human-vs-lichess": {
      // A pending seek is distinct from a live game: the seek is a
      // long-poll that must be aborted via stopSeek, not disconnect.
      if (humanLichessSeekStatus === "seeking") {
        return (
          <button className="session-control" onClick={() => void humanLichessStopSeek()}>
            Cancel seek
          </button>
        );
      }
      // Live game, waiting for first move, or just-ended but not yet
      // acknowledged -- all three states warrant Disconnect.
      const live =
        humanLichessStatus === "connecting" ||
        humanLichessStatus === "connected" ||
        humanLichessStatus === "gameOver";
      if (!live) return null;
      return (
        <button className="session-control" onClick={() => void humanLichessDisconnect()}>
          Disconnect
        </button>
      );
    }

    case "engine-vs-lichess": {
      // Bot mode has a clear Start/Stop pair: startListening / stopListening.
      // "Playing" is a sub-status of being connected, so a single Stop
      // button covers both. Start requires an engine path and a token;
      // disable rather than hide so the user knows a precondition is
      // missing (hiding the button entirely leaves them searching the
      // UI for what's wrong).
      if (botStatus === "listening" || botStatus === "playing") {
        return (
          <button className="session-control" onClick={() => void botStopListening()}>
            Stop listening
          </button>
        );
      }
      const canStart = Boolean(botHasToken && botEnginePath);
      return (
        <button
          className="session-control"
          disabled={!canStart}
          title={
            canStart
              ? undefined
              : !botHasToken
                ? "Add a Lichess bot token first (Configuration tab)"
                : "Select an engine binary first (Configuration tab)"
          }
          onClick={() => void botStartListening()}
        >
          Start listening
        </button>
      );
    }
  }
}
