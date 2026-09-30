import { useEffect, useState } from "react";
import { fenAtPly, sideToMove } from "../lib/chessRules";
import { formatClockMs } from "../lib/time";
import { useGameStore } from "../state/gameStore";
import { useLichessBotStore } from "../state/lichessBotStore";
import { useLichessStore, type LiveClocks } from "../state/lichessStore";

/** How often (ms) to re-render for the ticking clock. 100 ms is fast enough
 * that the seconds counter never lags visibly and slow enough that this
 * won't be visible on a CPU flame graph. */
const TICK_INTERVAL_MS = 100;

/** Reads whichever Lichess mode is currently the source of live clocks.
 * Only one is non-null at a time in practice (the game-mode menu is
 * locked while any live session runs -- see useViewMenu), but read both
 * defensively rather than coupling to `useGameModeStore` here. */
function useLiveClocks(): LiveClocks | null {
  const human = useLichessStore((s) => s.serverClocks);
  const bot = useLichessBotStore((s) => s.serverClocks);
  return human ?? bot;
}

/**
 * Two-line live clock display for the currently-active Lichess game.
 * Interpolates locally between server updates: the side to move sees its
 * clock tick down every 100 ms; the other side's clock is frozen at the
 * server-reported value. On each new `gameState` update the store's
 * `serverClocks` snapshot advances and the display re-syncs.
 *
 * Renders `null` when no Lichess mode has clocks yet -- avoids showing
 * a stale zero'd panel between games or before the first move.
 */
export function LiveGameClocks() {
  const clocks = useLiveClocks();
  const plies = useGameStore((s) => s.plies);
  // Force a re-render every 100 ms so the tick advances. `now` is the
  // dependency the render body reads; storing it in state is what makes
  // React re-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!clocks) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [clocks]);

  if (!clocks) return null;

  const fen = fenAtPly(plies, plies.length);
  const toMove = sideToMove(fen);
  const elapsedSinceUpdate = Math.max(0, now - clocks.updatedAtMs);
  const wDisplay = toMove === "w" ? clocks.wtimeMs - elapsedSinceUpdate : clocks.wtimeMs;
  const bDisplay = toMove === "b" ? clocks.btimeMs - elapsedSinceUpdate : clocks.btimeMs;

  return (
    <div className="live-game-clocks">
      <div className={toMove === "b" ? "clock active" : "clock"}>
        <span className="clock-side">Black</span>
        <span className="clock-time">{formatClockMs(bDisplay)}</span>
      </div>
      <div className={toMove === "w" ? "clock active" : "clock"}>
        <span className="clock-side">White</span>
        <span className="clock-time">{formatClockMs(wDisplay)}</span>
      </div>
    </div>
  );
}
