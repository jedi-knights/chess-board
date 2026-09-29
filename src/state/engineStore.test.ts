import { describe, expect, it } from "vitest";
import { formatEngineExitMessage } from "./engineStore";

describe("formatEngineExitMessage", () => {
  it("reports the exit code when known", () => {
    expect(formatEngineExitMessage({ code: 134, stderr: "" })).toBe(
      "engine process exited (code 134)",
    );
  });

  it("reports 'unexpectedly' when no exit code is known", () => {
    expect(formatEngineExitMessage({ code: null, stderr: "" })).toBe(
      "engine process exited unexpectedly",
    );
  });

  it("appends stderr when the engine printed anything before exiting", () => {
    expect(
      formatEngineExitMessage({
        code: 134,
        stderr: "Assertion failed: king != nullptr\nAborted",
      }),
    ).toBe(
      "engine process exited (code 134)\nAssertion failed: king != nullptr\nAborted",
    );
  });

  it("trims incidental whitespace around captured stderr", () => {
    expect(formatEngineExitMessage({ code: null, stderr: "  \n  oops  \n  " })).toBe(
      "engine process exited unexpectedly\noops",
    );
  });
});
