import { describe, expect, it } from "vitest";
import { formatEngineExitMessage, useBlackEngineStore, useWhiteEngineStore } from "./engineStore";

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

describe("useWhiteEngineStore / useBlackEngineStore", () => {
  it("are fully independent -- setting one side's path never touches the other's", () => {
    useWhiteEngineStore.getState().setPath("/path/to/white-engine");
    useBlackEngineStore.getState().setPath("/path/to/black-engine");

    expect(useWhiteEngineStore.getState().path).toBe("/path/to/white-engine");
    expect(useBlackEngineStore.getState().path).toBe("/path/to/black-engine");
  });

  it("have independent movetime settings", () => {
    useWhiteEngineStore.getState().setMovetimeMs(500);
    useBlackEngineStore.getState().setMovetimeMs(3000);

    expect(useWhiteEngineStore.getState().movetimeMs).toBe(500);
    expect(useBlackEngineStore.getState().movetimeMs).toBe(3000);
  });
});
