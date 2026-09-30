import { CanvasTexture } from "three";
import type { PieceOnSquare } from "./chessRules";

/**
 * One Unicode glyph per piece type, used for *both* colors -- deliberately
 * always the solid-filled ("black") variant (♚♛♜♝♞♟), never the hollow
 * ("white") variant (♔♕♖♗♘♙). Font rendering of the hollow set is
 * inconsistent across platforms (some fonts render it filled anyway), so
 * relying on the glyph itself to encode color is fragile. Color is encoded
 * entirely through fill/stroke in createGlyphTexture instead -- this
 * matches the universal 2D chess convention (a colored, outlined
 * side-profile silhouette) every reference image and every real chess UI
 * uses, rather than a top-down photo of a 3D piece (which is what this
 * app's 2D mode did before -- every piece read as a nearly identical disc).
 */
const GLYPHS: Record<PieceOnSquare["type"], string> = {
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  k: "♚",
};

export function getPieceGlyph(type: PieceOnSquare["type"]): string {
  return GLYPHS[type];
}

const TEXTURE_SIZE = 128;

/**
 * Renders a single glyph into a square canvas texture, filled with `fill`
 * and outlined with `stroke` -- outlining in the *opposite* tone is what
 * keeps a piece visible on both light and dark squares regardless of its
 * own color, matching every printed/digital chess diagram convention
 * (white pieces: white fill, dark outline; black pieces: dark fill, light
 * outline).
 */
export function createGlyphTexture(
  glyph: string,
  fill: string,
  stroke: string,
  flip = false,
): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Extremely unlikely (2D canvas context is universally supported) --
    // fail closed with a blank texture rather than throwing and taking
    // the whole board render down with it.
    return new CanvasTexture(canvas);
  }

  // `flip` rotates the drawing 180 degrees in canvas space (a plain 2D
  // point reflection) before drawing the glyph -- used by Piece.tsx to
  // correct for POV white, where the mesh's fixed 3D rotation reads
  // upside-down. This is deliberately a 2D canvas transform, not a 3D
  // mesh rotation: composing 3D rotations to land the texture right-side
  // up while keeping the plane's face normal pointed at the camera is
  // exactly the kind of hand-derived matrix math that's cheap to get
  // wrong (it was, twice). A canvas rotate's effect is directly
  // verifiable by looking at the drawn pixels, with no 3D reasoning
  // required.
  if (flip) {
    ctx.translate(TEXTURE_SIZE, TEXTURE_SIZE);
    ctx.rotate(Math.PI);
  }

  const centerX = TEXTURE_SIZE / 2;
  const centerY = TEXTURE_SIZE / 2 + TEXTURE_SIZE * 0.05;
  ctx.font = `${TEXTURE_SIZE * 0.85}px "Segoe UI Symbol", "Apple Symbols", "DejaVu Sans", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = TEXTURE_SIZE * 0.06;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.strokeText(glyph, centerX, centerY);
  ctx.fillText(glyph, centerX, centerY);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
