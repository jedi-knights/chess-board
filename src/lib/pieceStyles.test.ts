import { describe, expect, it } from "vitest";
import { getPieceStyle, PIECE_STYLE_NAMES } from "./pieceStyles";

describe("pieceStyles", () => {
  it("every declared name resolves to a style with a positive segment count", () => {
    expect(PIECE_STYLE_NAMES.length).toBeGreaterThan(0);
    for (const name of PIECE_STYLE_NAMES) {
      const style = getPieceStyle(name);
      expect(style.name).toBe(name);
      expect(style.segments).toBeGreaterThan(0);
      expect(style.baseSegments).toBeGreaterThan(0);
    }
  });

  it("includes the original hardcoded classic segment counts so the default look doesn't change", () => {
    expect(getPieceStyle("classic")).toEqual({
      name: "classic",
      label: "Classic",
      segments: 16,
      baseSegments: 20,
    });
  });

  it("the modern style is genuinely lower-poly than classic, not just relabeled", () => {
    const classic = getPieceStyle("classic");
    const modern = getPieceStyle("modern");
    expect(modern.segments).toBeLessThan(classic.segments);
    expect(modern.baseSegments).toBeLessThan(classic.baseSegments);
  });
});
