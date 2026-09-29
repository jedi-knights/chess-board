import { getPieceStyle, PIECE_STYLE_NAMES } from "../lib/pieceStyles";
import { usePieceStyleStore } from "../state/pieceStyleStore";

/** Selects the piece rendering style, persisted across restarts. */
export function PieceStyleSelect() {
  const style = usePieceStyleStore((s) => s.style);
  const setStyle = usePieceStyleStore((s) => s.setStyle);

  return (
    <select
      className="piece-style-select"
      value={style}
      onChange={(e) => setStyle(e.target.value as typeof style)}
      title="Piece rendering style"
    >
      {PIECE_STYLE_NAMES.map((name) => (
        <option key={name} value={name}>
          {getPieceStyle(name).label}
        </option>
      ))}
    </select>
  );
}
