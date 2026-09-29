import { useEffect, useState } from "react";
import { useGameStore } from "../state/gameStore";

const AUTOPLAY_INTERVAL_MS = 800;

export function PlaybackControls() {
  const ply = useGameStore((s) => s.ply);
  const totalPlies = useGameStore((s) => s.plies.length);
  const goToStart = useGameStore((s) => s.goToStart);
  const goToEnd = useGameStore((s) => s.goToEnd);
  const stepForward = useGameStore((s) => s.stepForward);
  const stepBackward = useGameStore((s) => s.stepBackward);

  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const state = useGameStore.getState();
      if (state.ply >= state.plies.length) {
        setPlaying(false);
        return;
      }
      state.stepForward();
    }, AUTOPLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const disabled = totalPlies === 0;
  const atStart = ply === 0;
  const atEnd = ply === totalPlies;

  return (
    <div className="playback-controls">
      <button onClick={goToStart} disabled={disabled || atStart} aria-label="Go to start">
        |&lt;
      </button>
      <button onClick={stepBackward} disabled={disabled || atStart} aria-label="Step back">
        &lt;
      </button>
      <button onClick={() => setPlaying((p) => !p)} disabled={disabled}>
        {playing ? "Pause" : "Play"}
      </button>
      <button onClick={stepForward} disabled={disabled || atEnd} aria-label="Step forward">
        &gt;
      </button>
      <button onClick={goToEnd} disabled={disabled || atEnd} aria-label="Go to end">
        &gt;|
      </button>
      <span className="ply-counter">
        {ply} / {totalPlies}
      </span>
    </div>
  );
}
