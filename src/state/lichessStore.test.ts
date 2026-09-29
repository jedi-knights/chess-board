import { describe, expect, it } from "vitest";
import type { Ply } from "../lib/chessRules";
import { pendingMoveToSend } from "./lichessStore";

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
