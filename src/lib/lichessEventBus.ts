/**
 * The single seam for Lichess's account event stream
 * (`/api/stream/event`). Pre-PR-4 the listener lived inside
 * `lichessBotStore`, which meant a human-mode session had no way to
 * subscribe (there is only one such stream per app). This bus installs
 * the raw `lichess-event-stream` / `lichess-event-exit` listeners
 * exactly once for the app lifetime, and *routes* each event to
 * whichever store the current game-mode preset says owns human vs. bot
 * behavior.
 *
 * Ownership is by preset, not by "is this store's status listening":
 *   - `human-vs-lichess` -> `useLichessStore`
 *   - `engine-vs-lichess` -> `useLichessBotStore`
 *   - anything else -> the event is dropped (the menu lock in
 *     `useViewMenu` prevents switching to those presets while a
 *     Lichess session runs, so this branch is defensive only).
 *
 * The two Lichess modes never run at once by construction (the game-mode
 * menu is locked while any live session runs -- see the "Live-session
 * menu lock" design decision in CLAUDE.md), so a single-slot event
 * connection is enough.
 */

import { listen } from "@tauri-apps/api/event";
import { parseLichessAccountEvent, type LichessAccountEvent } from "./lichess";
import { useGameModeStore } from "../state/gameModeStore";
import { useLichessBotStore } from "../state/lichessBotStore";
import { useLichessStore } from "../state/lichessStore";

let installed = false;

function dispatch(event: LichessAccountEvent) {
  const preset = useGameModeStore.getState().preset;
  if (preset === "human-vs-lichess") {
    useLichessStore.getState().handleAccountEvent(event);
  } else if (preset === "engine-vs-lichess") {
    useLichessBotStore.getState().handleAccountEvent(event);
  }
  // Other presets drop the event on purpose.
}

function dispatchExit(reason: string) {
  const preset = useGameModeStore.getState().preset;
  if (preset === "human-vs-lichess") {
    useLichessStore.getState().handleEventStreamExit(reason);
  } else if (preset === "engine-vs-lichess") {
    useLichessBotStore.getState().handleEventStreamExit(reason);
  }
}

/** Idempotent: safe to call on every mode entry, listener install
 * happens exactly once. On HMR module replace, the `import.meta.hot?.dispose`
 * callback unlistens the Tauri subscriptions and resets the latch so the
 * fresh module instance can install cleanly -- without this, every edit
 * to a file in this import graph stacks another live listener on the same
 * Rust event, producing duplicate dispatches to `handleAccountEvent`
 * (and so duplicate `handleGameStart` / `handleGameFinish` runs) in dev. */
export function installLichessEventBusOnce(): void {
  if (installed) return;
  installed = true;

  const streamUnlisten = listen<string>("lichess-event-stream", (event) => {
    const parsed = parseLichessAccountEvent(event.payload);
    if (parsed) dispatch(parsed);
  });

  const exitUnlisten = listen<string>("lichess-event-exit", (event) => {
    dispatchExit(event.payload);
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      try {
        (await streamUnlisten)();
      } catch {
        // swallow: dispose must not throw, and a failed unlisten is at
        // worst a leaked listener (same outcome as before this fix).
      }
      try {
        (await exitUnlisten)();
      } catch {
        /* same */
      }
      installed = false;
    });
  }
}
