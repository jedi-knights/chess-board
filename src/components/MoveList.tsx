import { useGameStore } from "../state/gameStore";

interface MoveRow {
  moveNumber: number;
  white: string;
  whitePly: number;
  black?: string;
  blackPly?: number;
}

export function MoveList() {
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const goToPly = useGameStore((s) => s.goToPly);

  if (plies.length === 0) {
    return <p className="move-list-empty">No game loaded yet.</p>;
  }

  const rows: MoveRow[] = [];
  for (let i = 0; i < plies.length; i += 2) {
    rows.push({
      moveNumber: i / 2 + 1,
      white: plies[i].san,
      whitePly: i + 1,
      black: plies[i + 1]?.san,
      blackPly: plies[i + 1] ? i + 2 : undefined,
    });
  }

  return (
    <ol className="move-list">
      {rows.map((row) => (
        <li key={row.moveNumber}>
          <span className="move-number">{row.moveNumber}.</span>
          <button
            className={ply === row.whitePly ? "move active" : "move"}
            onClick={() => goToPly(row.whitePly)}
          >
            {row.white}
          </button>
          {row.black && (
            <button
              className={ply === row.blackPly ? "move active" : "move"}
              onClick={() => goToPly(row.blackPly as number)}
            >
              {row.black}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
