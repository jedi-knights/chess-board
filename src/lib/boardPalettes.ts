export type BoardPaletteName = "classic" | "forest" | "ocean" | "slate";

export interface BoardPalette {
  name: BoardPaletteName;
  label: string;
  light: string;
  dark: string;
}

const PALETTES: Record<BoardPaletteName, BoardPalette> = {
  classic: { name: "classic", label: "Classic", light: "#EDD6B0", dark: "#8B5A2B" },
  forest: { name: "forest", label: "Forest", light: "#EEEED2", dark: "#769656" },
  ocean: { name: "ocean", label: "Ocean", light: "#DEE3E6", dark: "#4B7399" },
  slate: { name: "slate", label: "Slate", light: "#D9D9D9", dark: "#5B6470" },
};

export const BOARD_PALETTE_NAMES = Object.keys(PALETTES) as BoardPaletteName[];

export function getBoardPalette(name: BoardPaletteName): BoardPalette {
  return PALETTES[name];
}
