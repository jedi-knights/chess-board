import { describe, expect, it } from "vitest";
import { deriveEngineIdentifier } from "./engineIdentifier";

describe("deriveEngineIdentifier", () => {
  it("extracts owner/repo from the canonical ~/src/github.com/<owner>/<repo> layout", () => {
    // This is the layout `git clone` + `ghq` produce; also the one
    // CLAUDE.md documents. Pre-fix this fell through to "chess-engine".
    expect(
      deriveEngineIdentifier(
        "/Users/omar/src/github.com/jedi-knights/chess-engine/engine",
      ),
    ).toBe("jedi-knights/chess-engine");
  });

  it("extracts owner/repo from the flat ~/github/<owner>/<repo> layout", () => {
    expect(
      deriveEngineIdentifier(
        "/Users/omar.crosby/src/github/jedi-knights/chess-engine/engine",
      ),
    ).toBe("jedi-knights/chess-engine");
  });

  it("finds the forge segment regardless of how deep it is", () => {
    expect(deriveEngineIdentifier("/opt/github/someone/some-engine/bin/run")).toBe(
      "someone/some-engine",
    );
  });

  it("recognizes gitlab.com and bitbucket.org too", () => {
    expect(
      deriveEngineIdentifier("/Users/me/src/gitlab.com/some-org/engine/build/engine"),
    ).toBe("some-org/engine");
    expect(
      deriveEngineIdentifier("/Users/me/src/bitbucket.org/team/project/engine"),
    ).toBe("team/project");
  });

  it("falls back to the parent directory name when there's no forge segment", () => {
    expect(deriveEngineIdentifier("/opt/stockfish/stockfish")).toBe("stockfish");
  });

  it("falls back to the raw path when there's nothing else to go on", () => {
    expect(deriveEngineIdentifier("engine")).toBe("engine");
  });
});
