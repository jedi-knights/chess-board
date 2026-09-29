import { describe, expect, it } from "vitest";
import { squareName, squareToPosition } from "./boardGeometry";

describe("squareToPosition", () => {
  it("centers a1 and h8 symmetrically around the origin", () => {
    expect(squareToPosition("a1")).toEqual([-3.5, -3.5]);
    expect(squareToPosition("h8")).toEqual([3.5, 3.5]);
  });

  it("places e4 off-center as expected", () => {
    expect(squareToPosition("e4")).toEqual([0.5, -0.5]);
  });
});

describe("squareName", () => {
  it("is the inverse of squareToPosition's file/rank indexing", () => {
    expect(squareName(0, 0)).toBe("a1");
    expect(squareName(7, 7)).toBe("h8");
    expect(squareName(4, 3)).toBe("e4");
  });

  it("round-trips through squareToPosition for every square on the board", () => {
    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const name = squareName(file, rank);
        const [x, z] = squareToPosition(name);
        expect(x).toBe(file - 3.5);
        expect(z).toBe(rank - 3.5);
      }
    }
  });
});
