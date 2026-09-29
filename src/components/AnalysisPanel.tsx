import { engineStoreForSide } from "../state/engineStore";
import { useGameStore } from "../state/gameStore";

function formatScore(depth: number | undefined, scoreCp?: number, scoreMate?: number): string {
  const parts: string[] = [];
  if (depth !== undefined) parts.push(`d${depth}`);
  if (scoreMate !== undefined) parts.push(`mate ${scoreMate}`);
  else if (scoreCp !== undefined) parts.push(`${(scoreCp / 100).toFixed(2)}`);
  return parts.join(" ");
}

/**
 * Scrolling history of the current search's `info` lines (one per completed
 * depth) -- the current single-line status only shows the latest, which
 * isn't enough to see how a search actually converged while debugging.
 */
export function AnalysisPanel() {
  // "The" engine, for this single-engine-at-a-time panel, is whichever
  // side controllers currently marks "engine" -- true for every mode this
  // panel is shown in today (human vs. engine, engine vs. Lichess).
  const engineSide = useGameStore((s) => (s.controllers.w === "engine" ? "w" : "b"));
  const history = engineStoreForSide(engineSide)((s) => s.searchInfoHistory);

  if (history.length === 0) {
    return null;
  }

  return (
    <div className="analysis-panel">
      <h2>Search history</h2>
      <ol className="analysis-entries">
        {history
          .slice()
          .reverse()
          .map((info, i) => (
            <li key={history.length - i} className="analysis-entry">
              <span className="analysis-score">
                {formatScore(info.depth, info.scoreCp, info.scoreMate)}
              </span>
              <span className="analysis-nodes">
                {info.nodes !== undefined ? `${info.nodes} nodes` : ""}
              </span>
              <span className="analysis-pv">{info.pv?.join(" ") ?? ""}</span>
            </li>
          ))}
      </ol>
    </div>
  );
}
