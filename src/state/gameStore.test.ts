import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "./gameStore";

beforeEach(() => {
  useGameStore.getState().startNewGame("w");
});

describe("startNewGame", () => {
  it("resets to an empty game in play mode with the chosen human color", () => {
    useGameStore.getState().startNewGame("b");
    const state = useGameStore.getState();
    expect(state.mode).toBe("play");
    expect(state.humanColor).toBe("b");
    expect(state.plies).toEqual([]);
    expect(state.ply).toBe(0);
    expect(state.selectedSquare).toBeNull();
  });
});

describe("selectSquare", () => {
  it("selects the human's own piece and lists its legal destinations", () => {
    useGameStore.getState().selectSquare("b1");
    const state = useGameStore.getState();
    expect(state.selectedSquare).toBe("b1");
    expect(state.legalDestinationSquares.sort()).toEqual(["a3", "c3"]);
  });

  it("does not select an opponent's piece", () => {
    useGameStore.getState().selectSquare("b8");
    const state = useGameStore.getState();
    expect(state.selectedSquare).toBeNull();
  });

  it("does not select anything outside play mode", () => {
    useGameStore.getState().loadGame([]);
    useGameStore.getState().selectSquare("b1");
    expect(useGameStore.getState().selectedSquare).toBeNull();
  });

  it("deselects when the same square is clicked again", () => {
    useGameStore.getState().selectSquare("b1");
    useGameStore.getState().selectSquare("b1");
    expect(useGameStore.getState().selectedSquare).toBeNull();
  });

  it("clicking a highlighted destination applies the move and clears selection", () => {
    useGameStore.getState().selectSquare("e2");
    useGameStore.getState().selectSquare("e4");
    const state = useGameStore.getState();
    expect(state.selectedSquare).toBeNull();
    expect(state.plies).toHaveLength(1);
    expect(state.plies[0].uci).toBe("e2e4");
    expect(state.ply).toBe(1);
  });

  it("is not the human's turn once it becomes black's move, so a white click is a no-op", () => {
    useGameStore.getState().selectSquare("e2");
    useGameStore.getState().selectSquare("e4"); // white just moved; black to move
    useGameStore.getState().selectSquare("d2"); // white piece, but not white's turn
    expect(useGameStore.getState().selectedSquare).toBeNull();
  });
});

describe("attemptMove", () => {
  it("applies a legal move and returns true", () => {
    const applied = useGameStore.getState().attemptMove("e2", "e4");
    expect(applied).toBe(true);
    expect(useGameStore.getState().plies).toHaveLength(1);
  });

  it("returns false and leaves state untouched for an illegal move", () => {
    const applied = useGameStore.getState().attemptMove("e2", "e5");
    expect(applied).toBe(false);
    expect(useGameStore.getState().plies).toHaveLength(0);
  });

  it("applies a promotion move end-to-end", () => {
    const promotionFen = "8/4P3/8/8/8/8/8/4K2k w - - 0 1";
    // loadGame's public surface takes a Ply[]; seed one fake prior ply whose
    // fenAfter is the position under test, then jump to it via goToPly.
    useGameStore.getState().loadGame([
      { san: "-", uci: "-", fenBefore: promotionFen, fenAfter: promotionFen, color: "b" },
    ]);
    useGameStore.getState().goToPly(1);

    const applied = useGameStore.getState().attemptMove("e7", "e8", "q");
    expect(applied).toBe(true);

    const state = useGameStore.getState();
    expect(state.plies[1].san).toBe("e8=Q");
    expect(state.plies[1].uci).toBe("e7e8q");
  });
});
