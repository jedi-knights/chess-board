import { BOARD_PALETTE_NAMES, getBoardPalette } from "../lib/boardPalettes";
import { useBoardThemeStore } from "../state/boardThemeStore";

/** Selects the board's square-color palette, persisted across restarts. */
export function BoardPaletteSelect() {
  const palette = useBoardThemeStore((s) => s.palette);
  const setPalette = useBoardThemeStore((s) => s.setPalette);

  return (
    <select
      className="board-palette-select"
      value={palette}
      onChange={(e) => setPalette(e.target.value as typeof palette)}
      title="Board color palette"
    >
      {BOARD_PALETTE_NAMES.map((name) => (
        <option key={name} value={name}>
          {getBoardPalette(name).label}
        </option>
      ))}
    </select>
  );
}
