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
  // Same gate as EngineOptions: when no side is engine-controlled, a
  // fall-through default read the wrong (stopped) engine's history.
  const controllers = useGameStore((s) => s.controllers);
  const engineSide: "w" | "b" | null =
    controllers.w === "engine" ? "w" : controllers.b === "engine" ? "b" : null;
  const history = engineStoreForSide(engineSide ?? "w")((s) => s.searchInfoHistory);

  if (engineSide === null || history.length === 0) {
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
