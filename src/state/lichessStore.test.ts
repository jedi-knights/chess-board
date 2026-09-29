import { describe, expect, it } from "vitest";
import type { Ply } from "../lib/chessRules";
import { movesToApply, pendingMoveToSend } from "./lichessStore";

function ply(uci: string, color: "w" | "b"): Ply {
  return { san: uci, uci, fenBefore: "", fenAfter: "", color };
}

describe("pendingMoveToSend", () => {
  it("returns null when there are no plies yet", () => {
    expect(pendingMoveToSend([], "w", null)).toBeNull();
  });

  it("returns the human's last move when it hasn't been sent yet", () => {
    const plies = [ply("e2e4", "w")];
    expect(pendingMoveToSend(plies, "w", null)).toBe("e2e4");
  });

  it("returns null when the last move was the opponent's, not the human's", () => {
    const plies = [ply("e2e4", "w"), ply("e7e5", "b")];
    expect(pendingMoveToSend(plies, "w", "e2e4")).toBeNull();
  });

  it("returns null when the human's last move was already sent", () => {
    const plies = [ply("e2e4", "w")];
    expect(pendingMoveToSend(plies, "w", "e2e4")).toBeNull();
  });

  it("works symmetrically for a human playing black", () => {
    const plies = [ply("e2e4", "w"), ply("e7e5", "b")];
    expect(pendingMoveToSend(plies, "b", null)).toBe("e7e5");
  });
});

describe("movesToApply", () => {
  it("returns every move on a fresh connection", () => {
    expect(movesToApply(["e2e4", "e7e5"], 0)).toEqual(["e2e4", "e7e5"]);
  });

  it("returns only the moves not yet applied locally", () => {
    expect(movesToApply(["e2e4", "e7e5", "g1f3"], 2)).toEqual(["g1f3"]);
  });

  it("returns nothing when Lichess echoes back a move already applied locally", () => {
    // Regression: this is exactly the case that broke when `knownMoveCount`
    // was tracked separately instead of diffing against the live ply count
    // -- sending the human's own move to Lichess, then receiving it echoed
    // straight back in the next stream line, must not re-append it.
    expect(movesToApply(["e2e4"], 1)).toEqual([]);
  });

  it("returns nothing when there are no new moves at all", () => {
    expect(movesToApply([], 0)).toEqual([]);
  });
});
