# chess-board

A Tauri + Three.js desktop app for visualizing and stepping through chess games move by move — built for people writing their own UCI chess engines.

[![CI](https://github.com/jedi-knights/chess-board/actions/workflows/ci.yml/badge.svg)](https://github.com/jedi-knights/chess-board/actions/workflows/ci.yml)
[![Badge](https://github.com/jedi-knights/chess-board/actions/workflows/badge.yaml/badge.svg)](https://github.com/jedi-knights/chess-board/actions/workflows/badge.yaml)
[![Coverage](https://img.shields.io/badge/Coverage-98.5%25-brightgreen)](https://jedi-knights.github.io/chess-board/?v=2)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<p align="center">
  <a href="#overview">Overview</a> ·
  <a href="#features">Features</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#examples">Examples</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a>
</p>

## Overview

If you're building your own UCI engine — like [jedi-knights/chess-engine](https://github.com/jedi-knights/chess-engine) — you already have a way to talk to it: pipe `position startpos` / `go depth 8` into its stdin and read `info`/`bestmove` lines back out, or point a tournament GUI (Arena, Cute Chess, ChessBase) at the binary and let it run full matches. Both are exactly right for what they're built for.

Neither is built for the moment you actually need most during development: your engine just played something wrong at ply 23 of a 40-move game, and you want to *see* the position, not reconstruct it in your head from a FEN string or a scrollback full of `bestmove` lines. Tournament GUIs assume a finished, trustworthy opponent engine running a full match — they're heavyweight for "let me just look at this one position." Reading a raw UCI move list or FEN and mentally rendering an 8x8 board, square by square, is exactly the kind of manual step where transposition bugs, off-by-one castling rights, and misread en passant squares hide in plain sight.

**chess-board** closes that gap: paste in whatever your engine already produces — a raw UCI move list straight from a `position ... moves e2e4 e7e5 ...` log line, or a full PGN — and step through it ply by ply on an actual rendered board, in 2D or 3D, with a move-by-move transcript alongside it.

```text
Paste:  e2e4 e7e5 g1f3 b8c6 f1b5 a7a6
Get:    a board you can step through one ply at a time, forward or back,
        in either a top-down 2D view or an angled 3D view — no engine
        wiring, no tournament GUI, no mental FEN parsing required.
```

This first milestone is replay-only — chess-board doesn't spawn or talk to your engine process yet (see [Roadmap](#contributing) in Contributing). It's deliberately scoped that way: the board rendering and move model needed to be right before adding the harder problem of managing a live engine process.

## Features

- **One Three.js scene, 2D and 3D from a single camera toggle** — no duplicated rendering path between the two views.
- **Load a game three ways**: paste a PGN, paste a bare UCI move list (`e2e4 e7e5 g1f3 ...`), or use the native "Open PGN file…" dialog.
- **Step through ply by ply** — forward/back buttons, jump to start/end, autoplay, or click any move directly in the move list to jump to it.
- **Move log transcript** with a live wall clock and, when the source PGN carries lichess/chess.com-style `%clk` or ICC-style `%emt` annotations, how long each side took on each move.
- **Light / dark theme** — follows the OS by default, with a manual override that persists across restarts.
- **Engine-agnostic by design** — the move model is driven by standard PGN and UCI move notation, not any one engine's output format.

## Requirements

- **Rust** with `cargo`/`rustc` (any recent stable toolchain — Tauri's own requirement)
- **Node.js** `^20.19.0` or `>=22.12.0`, plus [`pnpm`](https://pnpm.io/) `10.x`
- macOS or Linux with the usual [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/) (Xcode command line tools on macOS; `libwebkit2gtk-4.1-dev` + friends on Linux) — Windows should work but is untested here

## Installation

```bash
git clone https://github.com/jedi-knights/chess-board.git
cd chess-board
pnpm install
```

## Usage

```bash
pnpm tauri dev
```

This opens the app window. Paste a game into the text box on the right (a PGN or a bare UCI move list), click **Load**, then use the playback controls under the board — `|<` `<` `Play/Pause` `>` `>|` — or click any move in the move list to jump straight to it. Toggle **View: 2D / View: 3D** in the header to switch camera modes, and **Theme** to cycle system → light → dark.

## Examples

**1. Replay a finished game.** Paste a PGN — even a short one:

```text
1. f3 e5 2. g4 Qh4#
```

Click **Load** and step forward twice; the board reaches checkmate on Black's queen delivering `Qh4#`. Useful as a quick sanity check that PGN parsing and board rendering agree with each other before trusting the tool with your own engine's games.

**2. Debug your own engine's move list directly.** Copy the move sequence straight out of your engine's `position startpos moves ...` log line and paste it as-is:

```text
e2e4 e7e5 g1f3 b8c6 f1b5 a7a6
```

No PGN formatting needed — chess-board applies each UCI move in order and shows you the resulting position. **Gotcha:** a bare move list carries no timing information, so every row in the move log shows `—` instead of a think-time.

**3. Inspect think-time from a real lichess/chess.com export.** PGNs downloaded from lichess or chess.com annotate each move with a `%clk` comment:

```text
[TimeControl "180+2"]

1. e4 {[%clk 0:03:00]} 1... e5 {[%clk 0:02:58]} 2. Nf3 {[%clk 0:02:55]} *
```

The move log now shows how long each side took per move, derived from the clock deltas and the game's own time control. **Gotcha:** this is only as accurate as the source annotations — a PGN with no `%clk`/`%emt` comments (like the one in Example 1) always shows `—`.

## Configuration

No environment variables or config files. Two things worth knowing about what the app can touch on your machine:

| Setting | Value | Why |
|---|---|---|
| Content-Security-Policy | Set explicitly in `src-tauri/tauri.conf.json` (`default-src 'self'`, no remote script/style sources) | The webview can't load arbitrary remote content |
| File-read scope | `src-tauri/capabilities/default.json` grants read access only under `$HOME`, `$DOCUMENT`, `$DOWNLOAD`, `$DESKTOP` — not the whole filesystem | The "Open PGN file…" dialog can only read files under your common user directories |

## Development

```bash
pnpm install        # install frontend dependencies
pnpm tauri dev       # run the app with hot reload
pnpm exec tsc --noEmit  # typecheck
pnpm test            # run the chess-rules test suite (Vitest)
pnpm test:coverage   # same, with an LCOV coverage report in coverage/
pnpm build           # typecheck + production frontend build
pnpm tauri build     # full desktop app bundle
```

### Layout

```
src/
  App.tsx / App.css      top-level layout, wires state to components
  components/
    BoardScene.tsx        the Three.js scene — camera-mode ("2d"|"3d") toggle,
                           shared square/piece meshes for both views
    Piece.tsx              one piece mesh; primitive geometry per piece type
                           (GLTF piece models are a later polish milestone)
    MoveList.tsx            compact numbered SAN grid, click-to-jump
    MoveLog.tsx             chronological transcript + live wall clock +
                           per-move think-time
    PlaybackControls.tsx    step/play/pause/jump-to-start/end + autoplay
    GameLoader.tsx          paste-PGN / paste-UCI textarea + "Open PGN file…"
    ThemeToggle.tsx, WallClock.tsx
  hooks/
    useAppliedTheme.ts      resolves system/light/dark and applies it
  lib/
    chessRules.ts           the only seam that touches chess.js: PGN/UCI
                           parsing, FEN-per-ply, think-time derivation
    boardGeometry.ts        algebraic square -> 3D world coordinates
    time.ts                 duration/clock formatting
  state/
    gameStore.ts            loaded game, current ply, camera mode
    themeStore.ts           theme preference, persisted
src-tauri/
  src/lib.rs                Tauri Builder + fs/dialog/opener plugins
  capabilities/default.json scoped permissions (see Configuration)
  tauri.conf.json           explicit CSP
```

All chess rules and PGN/UCI parsing live in `src/lib/chessRules.ts`, wrapping [`chess.js`](https://github.com/jhlywa/chess.js). Tests in `chessRules.test.ts` exercise it entirely through its exported functions — no reaching into `chess.js` internals — so the suite survives refactors of how the wrapper is implemented, not just what it currently calls.

## Contributing

Contributions welcome — fork, branch, and open a PR. Since this is early and replay-only, the natural next things to pick up (each as its own PR) are:

1. **Engine process management** — spawn a user-picked UCI binary, stream `info`/`bestmove` back to the frontend.
2. **Live analysis view** — show a running engine's PV/eval alongside a loaded game.
3. **Play against the engine** — turn-taking `go`/`bestmove` round-trips applied to the board.
4. **Visual polish** — GLTF piece models, tweened move animations, board themes.

If you're working on a UCI engine of your own and this tool is missing something you need to debug it, that's exactly the kind of issue/PR this project wants.

## License

MIT — see [LICENSE](LICENSE).
