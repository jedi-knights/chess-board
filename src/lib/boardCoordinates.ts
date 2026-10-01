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
 * Each glyph is rotated in place (around its own center), not via a
 * whole-canvas pre-transform -- a whole-canvas translate+rotate moves
 * *where* a glyph ends up on the mesh as well as how it reads, which
 * silently re-breaks the position mapping for whichever POV doesn't get
 * the rotation (confirmed by working through the actual screen-space
 * projection: for the camera positions/up-vectors this app uses, POV
 * white's un-rotated mapping comes out net-flipped on screen while POV
 * black's does not -- see createRankStripTexture's longer derivation
 * comment, which applies identically here since both strips go through
 * the same mesh rotation and texture.flipY chain). Rotating per-glyph
 * around its own already-correct position fixes readability without
 * touching where each letter sits.
 */
/* v8 ignore start -- DOM canvas API unavailable in vitest's node test environment; see vite.config.ts */
export function createFileStripTexture(
  frameColor: string,
  textColor: string,
  pov: "w" | "b",
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

  const fontSize = height * 0.6;
  ctx.font = `bold ${fontSize}px "Segoe UI", "Helvetica Neue", "Arial", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  const flip = pov === "w";
  for (let i = 0; i < 8; i++) {
    const x = (i + 0.5) * PX_PER_UNIT;
    const y = height / 2;
    if (flip) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI);
      ctx.fillText(FILES[i], 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(FILES[i], x, y);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
/* v8 ignore stop */

/**
 * Renders rank labels (1-8) vertically along a thin strip. Returned
 * texture is sized BORDER_WIDTH x 8 world units.
 *
 * Position: canvas Y maps to world Z via texture.flipY (default true) and
 * the mesh's [-PI/2, 0, 0] rotation. Tracing it through -- flipY means
 * canvas row 0 (top) maps to the plane geometry's local y=+height/2, and
 * the rotation maps local (x, y, 0) to world (x, 0, -y) -- so canvas-top
 * (small y, large local y) lands at world Z = -height/2, i.e. **White's**
 * home side, not Black's. So rank "1" (White's home rank, world Z=-3.5)
 * belongs near canvas y=0, rank "8" near canvas y=height. This is the
 * opposite of what an earlier version of this comment claimed -- verified
 * both by re-deriving the rotation matrix directly and by comparing
 * against a live screenshot, where the previous `rankIndex = 7 - i`
 * mapping put rank "1"'s label on Black's home square.
 *
 * Orientation: working the same rotation through to actual on-screen
 * projection (camera position/up-vector for each POV) shows POV white's
 * un-rotated glyph reads upside-down on screen while POV black's reads
 * correctly as-is -- so only POV white needs the in-place 180 deg flip.
 * This is the opposite of the previous `povBlack` flag's condition, which
 * flipped for Black and left White un-rotated.
 */
/* v8 ignore start -- DOM canvas API unavailable in vitest's node test environment; see vite.config.ts */
export function createRankStripTexture(
  frameColor: string,
  textColor: string,
  pov: "w" | "b",
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

  const fontSize = width * 0.6;
  ctx.font = `bold ${fontSize}px "Segoe UI", "Helvetica Neue", "Arial", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  const flip = pov === "w";
  for (let i = 0; i < 8; i++) {
    const y = (i + 0.5) * PX_PER_UNIT;
    const x = width / 2;
    if (flip) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI);
      ctx.fillText(RANKS[i], 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(RANKS[i], x, y);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
/* v8 ignore stop */
