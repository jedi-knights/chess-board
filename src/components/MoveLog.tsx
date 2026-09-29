import { formatDuration } from "../lib/time";
import { useGameStore } from "../state/gameStore";
import { WallClock } from "./WallClock";

const SIDE_LABEL: Record<"w" | "b", string> = { w: "White", b: "Black" };

/**
 * Chronological transcript of every ply — distinct from MoveList's compact
 * numbered SAN grid. Shows which side moved (engine/human labeling arrives
 * in M2/M3, once the app knows who is actually driving each side) and how
 * long they took, when that's derivable from the source PGN's `%emt`/`%clk`
 * annotations. Bare UCI move lists carry no timing data, so those rows show
 * "—".
 */
export function MoveLog() {
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const goToPly = useGameStore((s) => s.goToPly);

  return (
    <div className="move-log">
      <div className="move-log-header">
        <h2>Move log</h2>
        <WallClock />
      </div>
      {plies.length === 0 ? (
        <p className="move-list-empty">No game loaded yet.</p>
      ) : (
        <ol className="move-log-entries">
          {plies.map((p, i) => {
            const plyNumber = i + 1;
            return (
              <li
                key={plyNumber}
                className={ply === plyNumber ? "move-log-entry active" : "move-log-entry"}
              >
                <button className="move-log-row" onClick={() => goToPly(plyNumber)}>
                  <span className="move-log-index">{plyNumber}.</span>
                  <span className="move-log-side">{SIDE_LABEL[p.color]}</span>
                  <span className="move-log-san">{p.san}</span>
                  <span className="move-log-time">
                    {p.thinkTimeSeconds !== undefined
                      ? `took ${formatDuration(p.thinkTimeSeconds)}`
                      : "—"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
