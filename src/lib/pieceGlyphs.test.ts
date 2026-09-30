import { describe, expect, it } from "vitest";
import { getPieceGlyph } from "./pieceGlyphs";

describe("getPieceGlyph", () => {
  it("returns a distinct glyph for every piece type", () => {
    const types = ["p", "n", "b", "r", "q", "k"] as const;
    const glyphs = types.map(getPieceGlyph);
    expect(new Set(glyphs).size).toBe(types.length);
  });

  it("uses the solid-filled Unicode variant, never the hollow one, for every type", () => {
    // Solid ("black") chess glyphs are U+265A-U+265F; hollow ("white")
    // glyphs are U+2654-U+2659 -- rendering of the hollow set is
    // inconsistent across fonts/platforms, so this must never regress.
    const types = ["p", "n", "b", "r", "q", "k"] as const;
    for (const type of types) {
      const codePoint = getPieceGlyph(type).codePointAt(0)!;
      expect(codePoint).toBeGreaterThanOrEqual(0x265a);
      expect(codePoint).toBeLessThanOrEqual(0x265f);
    }
  });
});
