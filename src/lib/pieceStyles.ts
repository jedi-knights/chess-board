/**
 * Selectable piece rendering styles -- same pattern as boardPalettes.ts,
 * just for piece geometry instead of board square colors.
 *
 * Researched from real chess set design conventions rather than guessed:
 * classic Staunton sets use smooth, round-turned forms (high segment
 * count) with round bases; modern minimalist/low-poly sets deliberately
 * strip pieces down to faceted, angular forms with an octagonal base as
 * their signature look. Varying segment count on the same underlying
 * primitive composition in Piece.tsx is what actually produces that
 * distinction, not a different geometry per style.
 */
export type PieceStyleName = "classic" | "modern";

export interface PieceStyle {
  name: PieceStyleName;
  label: string;
  /** Radial segment count for round parts (cylinders, cones, spheres). */
  segments: number;
  /** Segment count for the base cylinder specifically -- round for
   * classic, octagonal for modern. */
  baseSegments: number;
}

const STYLES: Record<PieceStyleName, PieceStyle> = {
  classic: { name: "classic", label: "Classic", segments: 16, baseSegments: 20 },
  modern: { name: "modern", label: "Modern (low-poly)", segments: 8, baseSegments: 8 },
};

export const PIECE_STYLE_NAMES = Object.keys(STYLES) as PieceStyleName[];

export function getPieceStyle(name: PieceStyleName): PieceStyle {
  return STYLES[name];
}
