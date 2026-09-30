import { CanvasTexture, RepeatWrapping } from "three";

/** Parses a "#rrggbb" hex color into 0-255 RGB components. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

const TEXTURE_SIZE = 256;
const GRAIN_LINES = 18;

/**
 * A wood-grain-style canvas texture in one solid color family: the base
 * color plus a handful of wavy horizontal lines in slightly darker/lighter
 * shades of the same hue, with per-line jitter so it doesn't look
 * perfectly regular -- the visual signature of real wood grain, generated
 * procedurally rather than sourced as an image asset (no external file,
 * no licensing question, matches the app's existing "materials are code,
 * not assets" approach).
 */
export function createWoodTexture(baseColor: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Extremely unlikely (2D canvas context is universally supported) --
    // fail closed with a flat, untextured canvas rather than throwing and
    // taking the whole board render down with it.
    return new CanvasTexture(canvas);
  }

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const { r, g, b } = hexToRgb(baseColor);
  for (let i = 0; i < GRAIN_LINES; i++) {
    const y = (i / GRAIN_LINES) * TEXTURE_SIZE + (Math.random() - 0.5) * 6;
    const shade = (Math.random() - 0.5) * 28;
    const alpha = (0.3 + Math.random() * 0.25).toFixed(2);
    ctx.strokeStyle = `rgba(${clampByte(r + shade)}, ${clampByte(g + shade)}, ${clampByte(b + shade)}, ${alpha})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= TEXTURE_SIZE; x += 16) {
      const wobble = Math.sin(x * 0.05 + i) * 4 + (Math.random() - 0.5) * 3;
      ctx.lineTo(x, y + wobble);
    }
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}
