export type BoardPaletteName = "classic" | "forest" | "ocean" | "slate";

export interface BoardPalette {
  name: BoardPaletteName;
  label: string;
  light: string;
  dark: string;
  /** Frame color -- used for the labeled border around the 8x8 playing area
   *  and for the opaque base plate under the board. A darker, less-saturated
   *  shade of the dark square color so the border reads as a framing element
   *  distinct from any single square, light or dark. */
  frame: string;
  /** Coordinate-label color on the frame -- light enough to read against
   *  `frame` from any viewing angle. */
  frameText: string;
}

const PALETTES: Record<BoardPaletteName, BoardPalette> = {
  classic: {
    name: "classic",
    label: "Classic",
    light: "#EDD6B0",
    dark: "#8B5A2B",
    frame: "#3E2817",
    frameText: "#EDD6B0",
  },
  forest: {
    name: "forest",
    label: "Forest",
    light: "#EEEED2",
    dark: "#769656",
    frame: "#2F3F26",
    frameText: "#EEEED2",
  },
  ocean: {
    name: "ocean",
    label: "Ocean",
    light: "#DEE3E6",
    dark: "#4B7399",
    frame: "#1F3047",
    frameText: "#DEE3E6",
  },
  slate: {
    name: "slate",
    label: "Slate",
    light: "#D9D9D9",
    dark: "#5B6470",
    frame: "#2A2F38",
    frameText: "#D9D9D9",
  },
};

export const BOARD_PALETTE_NAMES = Object.keys(PALETTES) as BoardPaletteName[];

export function getBoardPalette(name: BoardPaletteName): BoardPalette {
  return PALETTES[name];
}
