import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "./gameStore";
import {
  engineStoreForSide,
  formatEngineExitMessage,
  useBlackEngineStore,
  useWhiteEngineStore,
  type EngineStoreState,
} from "./engineStore";

// `invoke`/`listen` are Tauri's own IPC boundary -- mocking them here is the
// same kind of adapter-edge mock as a Stripe/S3 client mock (see
// rules/black-box-testing.md's "legitimate exception" carve-out), not a
// same-team collaborator. Nothing below reaches into the store's internal
// closures; every assertion goes through the store's or gameStore's public
// state, exactly as a real caller would observe it.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;

/** Callbacks the store registered via `listen(eventName, cb)`, keyed by
 * event name -- calling one simulates a real `engine-stdout-{side}` /
 * `engine-exit-{side}` event arriving through the same public seam the
 * store itself subscribes to. */
const listeners = new Map<string, (event: { payload: unknown }) => void>();

function emit(eventName: string, payload: unknown) {
  listeners.get(eventName)?.({ payload });
}

const IDLE_ENGINE_STATE: Pick<
  EngineStoreState,
  "path" | "status" | "movetimeMs" | "lastInfo" | "searchInfoHistory" | "options" | "optionValues" | "errorMessage"
> = {
  path: null,
  status: "idle",
  movetimeMs: 1000,
  lastInfo: null,
  searchInfoHistory: [],
  options: [],
  optionValues: {},
  errorMessage: null,
};

beforeEach(() => {
  // Deliberately not cleared: `installListenersOnce` only ever calls
  // `listen()` once per store instance (module-lifetime guard, same as in
  // production), so re-registering a fresh callback here on every test
  // would silently stop matching what the store itself actually does.
  mockedListen.mockImplementation(
    (eventName: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, cb);
      return Promise.resolve(() => listeners.delete(eventName));
    },
  );
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined);

  useGameStore.getState().loadGame([]);
  useGameStore.getState().startNewGame({ w: "human", b: "human" });
  useGameStore.getState().enterPlayMode();

  useWhiteEngineStore.setState(IDLE_ENGINE_STATE);
  useBlackEngineStore.setState(IDLE_ENGINE_STATE);
});

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
    ).toBe("engine process exited (code 134)\nAssertion failed: king != nullptr\nAborted");
  });

  it("trims incidental whitespace around captured stderr", () => {
    expect(formatEngineExitMessage({ code: null, stderr: "  \n  oops  \n  " })).toBe(
      "engine process exited unexpectedly\noops",
    );
  });
});

describe("two engine slots", () => {
  it("are fully independent instances -- mutating one never touches the other", () => {
    useWhiteEngineStore.setState({ path: "/white/engine" });
    useBlackEngineStore.setState({ path: "/black/engine" });
    expect(useWhiteEngineStore.getState().path).toBe("/white/engine");
    expect(useBlackEngineStore.getState().path).toBe("/black/engine");
  });

  it("engineStoreForSide resolves each side to its own store", () => {
    expect(engineStoreForSide("w")).toBe(useWhiteEngineStore);
    expect(engineStoreForSide("b")).toBe(useBlackEngineStore);
  });
});

describe("startEngine", () => {
  it("re-entrancy guard: a second call while one is already starting is a no-op", () => {
    void useWhiteEngineStore.getState().startEngine("/bin/engine-a");
    expect(useWhiteEngineStore.getState().status).toBe("starting");
    void useWhiteEngineStore.getState().startEngine("/bin/engine-b");
    expect(useWhiteEngineStore.getState().path).toBe("/bin/engine-a");
  });

  it("success path: status goes idle -> ready and path is recorded", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    const state = useWhiteEngineStore.getState();
    expect(state.status).toBe("ready");
    expect(state.path).toBe("/bin/engine");
    expect(state.errorMessage).toBeNull();
  });

  it("failure path: status becomes error, errorMessage is set, and gameStore exits play mode", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "engine_start" ? Promise.reject(new Error("spawn failed")) : Promise.resolve(undefined),
    );
    await useWhiteEngineStore.getState().startEngine("/bad/path");
    const state = useWhiteEngineStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("spawn failed");
    expect(useGameStore.getState().mode).toBe("replay");
  });
});

describe("stopEngine", () => {
  it("resets to idle, clears info/error state, and resets the board via gameStore.loadGame", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    useWhiteEngineStore.setState({
      errorMessage: "stale error",
      lastInfo: { type: "info", depth: 5 },
      searchInfoHistory: [{ type: "info", depth: 5 }],
    });
    useGameStore.getState().attemptMove("e2", "e4");

    await useWhiteEngineStore.getState().stopEngine();

    const state = useWhiteEngineStore.getState();
    expect(state.status).toBe("idle");
    expect(state.lastInfo).toBeNull();
    expect(state.searchInfoHistory).toEqual([]);
    expect(state.errorMessage).toBeNull();
    expect(useGameStore.getState().plies).toEqual([]);
  });
});

describe("setOption", () => {
  it("records the value and sends setoption to the engine when a value is given", () => {
    useWhiteEngineStore.getState().setOption("Hash", "256");
    expect(useWhiteEngineStore.getState().optionValues.Hash).toBe("256");
    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "w",
      line: "setoption name Hash value 256",
    });
  });

  it("leaves optionValues untouched for a button-type option with no value", () => {
    useWhiteEngineStore.getState().setOption("Clear Hash");
    expect(useWhiteEngineStore.getState().optionValues).toEqual({});
    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "w",
      line: "setoption name Clear Hash",
    });
  });

  it("fails the engine if the write itself rejects", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("pipe closed"));
    useWhiteEngineStore.getState().setOption("Hash", "256");
    await Promise.resolve();
    await Promise.resolve();
    const state = useWhiteEngineStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("pipe closed");
  });
});

describe("setPath / setMovetimeMs", () => {
  it("update the persisted path and movetime directly", () => {
    useWhiteEngineStore.getState().setPath("/bin/new-engine");
    useWhiteEngineStore.getState().setMovetimeMs(2000);
    const state = useWhiteEngineStore.getState();
    expect(state.path).toBe("/bin/new-engine");
    expect(state.movetimeMs).toBe(2000);
  });
});

describe("engine-stdout listener", () => {
  it("a bestmove line applies a real move via gameStore and returns the engine to ready", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    useWhiteEngineStore.setState({ status: "thinking" });

    emit("engine-stdout-w", "bestmove e2e4");

    expect(useGameStore.getState().plies.map((p) => p.uci)).toEqual(["e2e4"]);
    expect(useWhiteEngineStore.getState().status).toBe("ready");
  });

  it("ignores an exact duplicate delivery of the last-applied bestmove", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    useWhiteEngineStore.setState({ status: "thinking" });
    emit("engine-stdout-w", "bestmove e2e4");
    expect(useGameStore.getState().plies).toHaveLength(1);

    emit("engine-stdout-w", "bestmove e2e4");
    expect(useGameStore.getState().plies).toHaveLength(1);
  });

  it("an illegal bestmove fails the engine and exits play mode", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    useWhiteEngineStore.setState({ status: "thinking" });

    emit("engine-stdout-w", "bestmove e2e5");

    const state = useWhiteEngineStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("illegal move");
    expect(useGameStore.getState().mode).toBe("replay");
  });

  it("an info line updates lastInfo and appends to the bounded search history", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");

    emit("engine-stdout-w", "info depth 5 score cp 34 nodes 1000 nps 500 time 20 pv e2e4 e7e5");

    const state = useWhiteEngineStore.getState();
    expect(state.lastInfo?.depth).toBe(5);
    expect(state.lastInfo?.scoreCp).toBe(34);
    expect(state.searchInfoHistory).toHaveLength(1);
  });

  it("an option line upserts options and seeds optionValues with its default", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");

    emit("engine-stdout-w", "option name Hash type spin default 16 min 1 max 1024");

    const state = useWhiteEngineStore.getState();
    expect(state.options).toHaveLength(1);
    expect(state.options[0].name).toBe("Hash");
    expect(state.optionValues.Hash).toBe("16");
  });
});

describe("engine-exit listener", () => {
  it("suppresses the crash report for a deliberate, user-requested stop", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    const stopPromise = useWhiteEngineStore.getState().stopEngine();
    emit("engine-exit-w", { code: 0, stderr: "" });
    await stopPromise;

    expect(useWhiteEngineStore.getState().status).toBe("idle");
  });

  it("an unexpected exit with no stop requested fails the engine as crashed", async () => {
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    useWhiteEngineStore.setState({ status: "ready" });

    emit("engine-exit-w", { code: 134, stderr: "Assertion failed" });

    const state = useWhiteEngineStore.getState();
    expect(state.status).toBe("crashed");
    expect(state.errorMessage).toContain("Assertion failed");
    expect(useGameStore.getState().mode).toBe("replay");
  });
});

describe("checkTurn / maybeRequestEngineMove", () => {
  it("sends position+go when it is this engine's turn on the live position", async () => {
    useGameStore.getState().startNewGame({ w: "engine", b: "human" });
    useGameStore.getState().enterPlayMode();
    await useWhiteEngineStore.getState().startEngine("/bin/engine");
    mockedInvoke.mockClear();

    useWhiteEngineStore.getState().checkTurn();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "w",
      line: "position startpos",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "w",
      line: "go movetime 1000",
    });
    expect(useWhiteEngineStore.getState().status).toBe("thinking");
  });

  it("does nothing when it is not this engine's turn", async () => {
    useGameStore.getState().startNewGame({ w: "human", b: "engine" });
    useGameStore.getState().enterPlayMode();
    await useBlackEngineStore.getState().startEngine("/bin/engine");
    mockedInvoke.mockClear();

    // White to move, but the black engine store checks its own turn.
    useBlackEngineStore.getState().checkTurn();
    await Promise.resolve();

    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "engine_write_line",
      expect.objectContaining({ side: "b" }),
    );
    expect(useBlackEngineStore.getState().status).toBe("ready");
  });

  it("fires automatically when a ply is appended, via the gameStore subscription", async () => {
    useGameStore.getState().startNewGame({ w: "human", b: "engine" });
    useGameStore.getState().enterPlayMode();
    await useBlackEngineStore.getState().startEngine("/bin/engine");
    mockedInvoke.mockClear();

    useGameStore.getState().attemptMove("e2", "e4");
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedInvoke).toHaveBeenCalledWith("engine_write_line", {
      side: "b",
      line: "position startpos moves e2e4",
    });
  });
});
