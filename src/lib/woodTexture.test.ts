import { describe, expect, it } from "vitest";
import { hexToRgb } from "./woodTexture";

describe("hexToRgb", () => {
  it("parses a hex color into its RGB components", () => {
    expect(hexToRgb("#EDD6B0")).toEqual({ r: 0xed, g: 0xd6, b: 0xb0 });
  });

  it("parses black and white correctly", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("works without a leading #", () => {
    expect(hexToRgb("8B5A2B")).toEqual({ r: 0x8b, g: 0x5a, b: 0x2b });
  });
});
