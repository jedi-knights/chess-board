import { describe, expect, it } from "vitest";
import { BORDER_WIDTH, FILES, RANKS } from "./boardCoordinates";

describe("boardCoordinates", () => {
  it("exposes 8 file labels a-h in order", () => {
    expect(FILES).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("exposes 8 rank labels 1-8 in order", () => {
    expect(RANKS).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("border is thinner than a square so it reads as a frame, not a row", () => {
    expect(BORDER_WIDTH).toBeGreaterThan(0);
    expect(BORDER_WIDTH).toBeLessThan(1);
  });
});
