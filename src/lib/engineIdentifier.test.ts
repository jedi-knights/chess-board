import { describe, expect, it } from "vitest";
import { deriveEngineIdentifier } from "./engineIdentifier";

describe("deriveEngineIdentifier", () => {
  it("extracts owner/repo from a ~/src/github/<owner>/<repo> layout", () => {
    expect(
      deriveEngineIdentifier(
        "/Users/omar.crosby/src/github/jedi-knights/chess-engine/engine",
      ),
    ).toBe("jedi-knights/chess-engine");
  });

  it("finds the github segment regardless of how deep it is", () => {
    expect(deriveEngineIdentifier("/opt/github/someone/some-engine/bin/run")).toBe(
      "someone/some-engine",
    );
  });

  it("falls back to the parent directory name when there's no github segment", () => {
    expect(deriveEngineIdentifier("/opt/stockfish/stockfish")).toBe("stockfish");
  });

  it("falls back to the raw path when there's nothing else to go on", () => {
    expect(deriveEngineIdentifier("engine")).toBe("engine");
  });
});
