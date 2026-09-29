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

## Layout

See README.md's Development > Layout section — kept in one place to avoid drift between
this file and the human-facing docs.

## Design decisions (do not re-derive, re-read instead)

- **One Three.js scene, camera-mode toggle** (`BoardScene.tsx`) — not two renderers for
  2D vs 3D. Board/piece meshes are shared; only the camera type + controls differ.
- **All chess rules/PGN/UCI parsing live in `src/lib/chessRules.ts`**, wrapping `chess.js`.
  Nothing else in the codebase should import `chess.js` directly — route through this
  module so there is exactly one seam to test and one place that understands FEN/SAN/UCI.
- **`src-tauri` has zero chess domain logic in M1.** It exists only for OS-level concerns
  (file dialogs now; engine process spawning is M2). Do not add chess rules to Rust.
- **Think-time is derived, not authoritative.** `%emt` comments are used directly when
  present; otherwise think-time is computed by diffing consecutive `%clk` readings for the
  same color plus the `TimeControl` header's increment. A PGN with neither leaves
  `thinkTimeSeconds` `undefined` — the UI must show `—`, never a fabricated value.
- **`fs` capability is scoped**, not `fs:default`. Only `fs:allow-read-text-file` under
  `$HOME`/`$DOCUMENT`/`$DOWNLOAD`/`$DESKTOP`. Do not widen this without a concrete need.
- **`security.csp` is set explicitly** in `tauri.conf.json`. Never revert to `null`.

## Testing conventions

- Framework: Vitest. Black-box per the user's testing rules — tests exercise
  `chessRules.ts`'s exported functions only, never `chess.js` internals.
- One test file per lib module: `chessRules.test.ts`, `time.test.ts`.
- No Rust tests yet — `src-tauri` has no domain logic to test until M2.

## Non-goals (for now)

- Spawning/talking to an engine process (M2)
- Playing against an engine (M3)
- GLTF piece models / animations / themes (M4)

Do not build these speculatively — each is a real milestone with its own design
questions (process lifecycle + capability scoping for M2 especially) that deserve their
own planning pass, not a drive-by addition on top of an unrelated change.
