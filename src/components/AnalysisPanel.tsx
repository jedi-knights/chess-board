import { engineStoreForSide, type Side } from "../state/engineStore";

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
export function AnalysisPanel({ side }: { side: Side }) {
  const history = engineStoreForSide(side)((s) => s.searchInfoHistory);

  if (history.length === 0) {
    return null;
  }

  return (
    <div className="analysis-panel">
      <h2>Search history ({side === "w" ? "White" : "Black"})</h2>
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
