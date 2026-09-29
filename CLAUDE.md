# chess-board

A Tauri + React + Three.js desktop app for visualizing/replaying chess games. Sibling
project to `jedi-knights/chess-engine` — built for anyone developing a UCI chess engine,
not tied to that specific engine. Author: single dev, hobby project.

## Build & test

```
pnpm install          # install frontend deps
pnpm tauri dev         # run the app (hot reload)
pnpm exec tsc --noEmit # typecheck
pnpm test              # Vitest suite for src/lib/*.ts
pnpm test:coverage     # same, + coverage/lcov.info
pnpm build             # typecheck + production frontend build
pnpm tauri build       # full desktop bundle
```

Rust side (`src-tauri/`): `cargo check` / `cargo build` from within `src-tauri/`.

## Workflow

**All changes land on `main` via a pull request — never commit directly to `main`.**
Branch first (`git checkout -b <type>/<short-desc>` off a freshly pulled `main`), commit
there, push, open a PR, and merge through GitHub. This holds even for small fixes and even
though `main` currently has no branch-protection ruleset configured — the rule is "always
open a PR," not "open a PR because the branch is protected." If you find yourself with
staged changes and `main` checked out, stop and move them to a branch before committing.

## Hard requirements (not negotiable, not "later polish")

- **Chess pieces must be visually recognizable as their actual piece type.** A single bare
  primitive per piece (one cone, one box) is explicitly **not acceptable** — this shipped
  once, the user called it out directly ("don't look anything like the pieces they should
  represent"), and it must not regress. The current bar, set in `Piece.tsx`: each piece is
  a small stack/composition of primitives shaped to its real silhouette (pawn: peg + ball;
  rook: crenellated turret; knight: an actual extruded horse-head profile, not two rotated
  boxes; bishop: tall and slender with a pointed mitre, clearly distinct from the pawn;
  queen: crown with spikes; king: cross topper). GLTF piece models are still optional
  further polish (see Non-goals) — but the current composed-primitive shapes are the
  **floor**, not a placeholder waiting to be simplified back down. Do not "clean up"
  `Piece.tsx` by collapsing a piece back to one primitive.
- **Never leave the working tree checked out on `main` (or any branch) that lacks a
  change the user is actively looking at in a running `pnpm tauri dev` session.** Vite
  watches the filesystem, not git — switching branches while the dev server is running
  changes what's rendered live, even with zero new edits. This caused a real regression:
  checking out `main` to clean up after opening PRs reverted `Piece.tsx` to its
  pre-improvement state on disk, and the user saw the primitive placeholder pieces come
  back. If a dev server is running against work that only exists on an unmerged branch,
  either keep that branch checked out, or merge it first, before switching away.

## Layout

See README.md's Development > Layout section — kept in one place to avoid drift between
this file and the human-facing docs.

## Design decisions (do not re-derive, re-read instead)

- **One Three.js scene, camera-mode toggle** (`BoardScene.tsx`) — not two renderers for
  2D vs 3D. Board/piece meshes are shared; only the camera type + controls differ. Default
  mode is 3D.
- **Board orientation follows `humanColor`, via the camera, never the board data.**
  `squareToPosition`/`squareName` and every move-logic function stay in one fixed world
  frame (white's home ranks always at world -Z) — only `BoardScene`'s camera position/`up`
  vector change to put the human's side at the bottom of the view. In 2D mode the camera
  looks straight down, which is a near-degenerate case for `lookAt`'s default up-vector
  disambiguation — the explicit horizontal `up` set in `LookAtBoardCenter` is what actually
  decides orientation there, not camera position. Do not "fix" orientation by flipping
  `squareToPosition`'s sign — that would desync rendering from every move-legality check.
- **All chess rules/PGN/UCI parsing live in `src/lib/chessRules.ts`**, wrapping `chess.js`.
  Nothing else in the codebase should import `chess.js` directly — route through this
  module so there is exactly one seam to test and one place that understands FEN/SAN/UCI.
- **`src-tauri` has zero chess/UCI-protocol logic.** `src-tauri/src/engine.rs` spawns the
  picked binary and pipes raw stdout lines as `engine-stdout` events — it never parses a
  UCI line. All `bestmove`/`info` parsing and all outgoing `position`/`go` construction
  live in `src/lib/uci.ts`, the UCI-protocol counterpart to `chessRules.ts`. Do not add
  parsing logic to `engine.rs`; extend `uci.ts` instead.
- **No `shell:execute` capability is granted, by design.** The `shell` plugin's model is
  built for bundled sidecars or a fixed allowlist, not an arbitrary path picked live from a
  file dialog. `engine_start` spawns directly via `std::process::Command` and validates the
  path itself (must be a real file) — the native file dialog is the trust boundary here,
  the same reasoning already applied to the `fs` read scope below. Do not "fix" this by
  adding a `shell:allow-execute` permission; it doesn't fit this use case.
- **`gameStore` knows nothing about the engine.** `attemptMove(from, to, promotion?)` is
  the single append path for both a human's click and an applied engine `bestmove` — it
  just validates via `chessRules.tryMove` and appends. Turn-taking orchestration
  (`engineStore.ts`'s `maybeRequestEngineMove`) lives entirely in `engineStore`, which
  subscribes to `gameStore`; the dependency only ever points one way.
- **Starting a new game resets `gameStore` *before* spawning the engine, never after.**
  `EngineControls.start()` calls `startNewGame()` first, then `startEngine()`. Reversing
  that order is the exact bug that shipped once already: `startEngine`'s post-ready turn
  check can fire against the *previous* game's leftover position, and the resulting
  (stale) `bestmove` lands on the fresh game as a spurious "illegal move" error.
- **`startEngine` guards against re-entrancy.** A double-invocation while a start is
  already in flight would spawn a second process, whose Rust-side startup kills the first
  one mid-flight — surfacing as a misleading "engine process exited unexpectedly" that has
  nothing to do with the engine binary itself. See `NOT_RUNNING` check in `engineStore.ts`.
- **The selected engine path (and movetime) persist across sessions** via `engineStore`'s
  zustand `persist` middleware, same pattern as `themeStore`. Only `path`/`movetimeMs` are
  persisted (`partialize`) — live `status`/`lastInfo`/`errorMessage` must not survive a
  reload, since they describe a process that no longer exists.
- **The engine label shows a derived "owner/repo" identifier** (`src/lib/engineIdentifier.ts`),
  not a raw path or bare filename, and the label text itself distinguishes "selected" from
  "running" (`Engine: x` vs `Running: x` vs `Starting: x…`) — do not collapse that back to a
  bare path/basename display.
- **Think-time is derived, not authoritative.** `%emt` comments are used directly when
  present; otherwise think-time is computed by diffing consecutive `%clk` readings for the
  same color plus the `TimeControl` header's increment. A PGN with neither leaves
  `thinkTimeSeconds` `undefined` — the UI must show `—`, never a fabricated value.
- **`fs` capability is scoped**, not `fs:default`. Only `fs:allow-read-text-file` under
  `$HOME`/`$DOCUMENT`/`$DOWNLOAD`/`$DESKTOP`. Do not widen this without a concrete need.
- **`security.csp` is set explicitly** in `tauri.conf.json`. Never revert to `null`.

## Testing conventions

- Framework: Vitest. Black-box per the user's testing rules — tests exercise each
  module's exported functions only, never `chess.js` internals or another module's
  private state.
- One test file per lib/state module: `chessRules.test.ts`, `time.test.ts`, `uci.test.ts`,
  `boardGeometry.test.ts`, `gameStore.test.ts`, `engineIdentifier.test.ts`.
- Rust: `engine.rs` has a couple of unit tests for the pure state-transition helpers
  (`write_line_locked`, `stop_locked` with no process running) that don't need a real
  `AppHandle`. The path-validation and actual-process-lifecycle branches are verified
  manually against the real `chess-engine` binary instead — see the PR that introduced
  live play for the exact verification steps.

## Non-goals (for now)

- GLTF piece models / tweened move animations / board themes (visual polish)
- Surfacing a picked engine's UCI `option` lines as real controls
- Drag-and-drop move input (click-to-select-then-click-destination is what's built; only
  revisit this if it turns out to be a real usability problem, not preemptively)

Do not build these speculatively — each is real scope with its own design questions that
deserve their own planning pass, not a drive-by addition on top of an unrelated change.
