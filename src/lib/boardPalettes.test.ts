import { describe, expect, it } from "vitest";
import { BOARD_PALETTE_NAMES, getBoardPalette } from "./boardPalettes";

describe("boardPalettes", () => {
  it("every declared name resolves to a palette with distinct light/dark colors", () => {
    expect(BOARD_PALETTE_NAMES.length).toBeGreaterThan(0);
    for (const name of BOARD_PALETTE_NAMES) {
      const palette = getBoardPalette(name);
      expect(palette.name).toBe(name);
      expect(palette.light).not.toBe(palette.dark);
      expect(palette.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(palette.dark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(palette.frame).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(palette.frameText).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("includes the original hardcoded classic colors so the default look doesn't change", () => {
    expect(getBoardPalette("classic")).toEqual({
      name: "classic",
      label: "Classic",
      light: "#EDD6B0",
      dark: "#8B5A2B",
      frame: "#3E2817",
      frameText: "#EDD6B0",
    });
  });
});
