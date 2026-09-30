import { useEffect, useState } from "react";
import { useGameStore } from "../state/gameStore";
import { useLichessBotStore } from "../state/lichessBotStore";
import { useLichessStore } from "../state/lichessStore";

/**
 * Resign / Abort / Draw / Claim-Victory action panel for whichever
 * Lichess mode is currently live. Reads controllers to decide which
 * store owns the actions -- both modes expose the same shape
 * (`resign` / `abort` / `agreeToDraw` / `declineDraw` / `claimVictory`),
 * so the JSX doesn't branch beyond selecting which one to call.
 *
 * Rendered only when a live Lichess game is running:
 *   - human mode: `useLichessStore.status === "connected"`
 *   - bot mode:   `useLichessBotStore.status === "playing"`
 * Any other state returns `null` so no stale buttons linger between
 * games or before the first move.
 */
export function LiveGameActions() {
  const humanStatus = useLichessStore((s) => s.status);
  const humanGone = useLichessStore((s) => s.opponentGone);
  const humanActions = useLichessStore((s) => ({
    resign: s.resign,
    abort: s.abort,
    agreeToDraw: s.agreeToDraw,
    declineDraw: s.declineDraw,
    claimVictory: s.claimVictory,
  }));

  const botStatus = useLichessBotStore((s) => s.status);
  const botGone = useLichessBotStore((s) => s.opponentGone);
  const botActions = useLichessBotStore((s) => ({
    resign: s.resign,
    abort: s.abort,
    agreeToDraw: s.agreeToDraw,
    declineDraw: s.declineDraw,
    claimVictory: s.claimVictory,
  }));

  const plies = useGameStore((s) => s.plies);
  const humanLive = humanStatus === "connected";
  const botLive = botStatus === "playing";
  const actions = humanLive ? humanActions : botLive ? botActions : null;
  const opponentGone = humanLive ? humanGone : botLive ? botGone : null;

  // The countdown displayed to the user ticks locally between server
  // updates. Only Lichess's most recent `claimWinInSeconds` value is
  // authoritative; we just interpolate down from it once per second.
  const [displaySeconds, setDisplaySeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!opponentGone?.gone || opponentGone.claimWinInSeconds === null) {
      setDisplaySeconds(null);
      return;
    }
    setDisplaySeconds(opponentGone.claimWinInSeconds);
    const id = window.setInterval(() => {
      setDisplaySeconds((prev) => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [opponentGone?.gone, opponentGone?.claimWinInSeconds]);

  if (!actions) return null;

  // Lichess allows `/abort` only through the first move by each side;
  // after two plies the endpoint 400s. Gate the button locally so the
  // user isn't offered an action that will fail. Resign / draw stay
  // enabled for the whole game.
  const canAbort = plies.length < 2;
  const canClaimVictory =
    opponentGone?.gone === true && displaySeconds !== null && displaySeconds <= 0;

  return (
    <div className="live-game-actions">
      <h3>Game actions</h3>
      {opponentGone?.gone && (
        <p className="hint">
          Opponent left the board
          {displaySeconds !== null && displaySeconds > 0
            ? ` — you can claim victory in ${displaySeconds}s`
            : displaySeconds !== null
              ? " — you can claim victory now"
              : ""}
          .
        </p>
      )}
      <div className="live-game-actions-row">
        <button onClick={() => void actions.resign()}>Resign</button>
        <button onClick={() => void actions.abort()} disabled={!canAbort}>
          Abort
        </button>
        <button onClick={() => void actions.agreeToDraw()}>Offer/agree draw</button>
        <button onClick={() => void actions.declineDraw()}>Decline draw</button>
        <button onClick={() => void actions.claimVictory()} disabled={!canClaimVictory}>
          Claim victory
        </button>
      </div>
    </div>
  );
}
