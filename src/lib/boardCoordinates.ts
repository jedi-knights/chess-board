import { CanvasTexture } from "three";

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

/** World-space dimensions of the border strips. The 8x8 playing area
 *  spans ±4 world units; the border sits in the margin from ±4 to
 *  ±(4 + BORDER_WIDTH). Thinner than a square (which is 1 unit) so it
 *  reads as a frame, not an extra row of squares. */
export const BORDER_WIDTH = 0.45;

const PX_PER_UNIT = 128;

/**
 * Renders file labels (a-h) horizontally along a thin strip. The returned
 * texture is sized 8 x BORDER_WIDTH world units so letters appear
 * un-stretched when mapped to the horizontal border planes.
 *
 * `povBlack` rotates the canvas 180 degrees via a point reflection, same
 * mechanism as createGlyphTexture's `flip` parameter -- the border mesh's
 * fixed world-space rotation reads correctly for one POV and upside-down
 * for the other, and correcting that in 2D canvas space (rather than
 * via a second 3D rotation of the mesh) is far easier to verify by looking
 * at the drawn pixels.
 */
/* v8 ignore start -- DOM canvas API unavailable in vitest's node test environment; see vite.config.ts */
export function createFileStripTexture(
  frameColor: string,
  textColor: string,
  povBlack: boolean,
): CanvasTexture {
  const widthUnits = 8;
  const heightUnits = BORDER_WIDTH;
  const width = widthUnits * PX_PER_UNIT;
  const height = heightUnits * PX_PER_UNIT;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new CanvasTexture(canvas);

  ctx.fillStyle = frameColor;
  ctx.fillRect(0, 0, width, height);

  if (povBlack) {
    ctx.translate(width, height);
    ctx.rotate(Math.PI);
  }

  const fontSize = height * 0.6;
  ctx.font = `bold ${fontSize}px "Segoe UI", "Helvetica Neue", "Arial", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  for (let i = 0; i < 8; i++) {
    const x = (i + 0.5) * PX_PER_UNIT;
    const y = height / 2;
    ctx.fillText(FILES[i], x, y);
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
/* v8 ignore stop */

/**
 * Renders rank labels (1-8) vertically along a thin strip. Returned
 * texture is sized BORDER_WIDTH x 8 world units. Rank 1 is drawn at the
 * canvas row that maps to world Z = -3.5 (White's home side), matching
 * squareToPosition's indexing in boardGeometry.ts.
 */
/* v8 ignore start -- DOM canvas API unavailable in vitest's node test environment; see vite.config.ts */
export function createRankStripTexture(
  frameColor: string,
  textColor: string,
  povBlack: boolean,
): CanvasTexture {
  const widthUnits = BORDER_WIDTH;
  const heightUnits = 8;
  const width = widthUnits * PX_PER_UNIT;
  const height = heightUnits * PX_PER_UNIT;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new CanvasTexture(canvas);

  ctx.fillStyle = frameColor;
  ctx.fillRect(0, 0, width, height);

  if (povBlack) {
    ctx.translate(width, height);
    ctx.rotate(Math.PI);
  }

  const fontSize = width * 0.6;
  ctx.font = `bold ${fontSize}px "Segoe UI", "Helvetica Neue", "Arial", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  // Canvas Y maps to world Z (with flipY=true default): canvas y=0 is the
  // -Z-pointing edge of the plane in local space, which after the mesh's
  // [-PI/2, 0, 0] rotation and the UV flip ends up at world +Z (Black's
  // home). So rank 8 (world z=+3.5) belongs near canvas top, rank 1 near
  // canvas bottom.
  for (let i = 0; i < 8; i++) {
    const y = (i + 0.5) * PX_PER_UNIT;
    const x = width / 2;
    const rankIndex = 7 - i;
    ctx.fillText(RANKS[rankIndex], x, y);
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
/* v8 ignore stop */
