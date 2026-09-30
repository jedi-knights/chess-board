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
- **Per-side `Controller` (`"human" | "engine" | "lichess"`), not a fixed `humanColor`.**
  `gameStore.ts`'s `Controllers = { w: Controller; b: Controller }` generalizes what used
  to be a single human color, because a game can have zero human sides (engine vs. engine,
  engine vs. Lichess) or two non-human sides at once. `startNewGame(controllers, pov?)`
  replaces the old `startNewGame(humanColor)`; `selectSquare` gates on
  `controllers[sideToMove(fen)] !== "human"`.
- **`pov` is a separate field from `controllers`, camera-only, never board data.**
  `squareToPosition`/`squareName` and every move-logic function stay in one fixed world
  frame (white's home ranks always at world -Z) — only `BoardScene`'s camera position/`up`
  vector change to put `pov`'s side at the bottom of the view. Watching from either side
  makes sense even with no human playing, which is why this is decoupled from `controllers`
  rather than derived from it. In 2D mode the camera looks straight down, which is a
  near-degenerate case for `lookAt`'s default up-vector disambiguation — the explicit
  horizontal `up` set in `LookAtBoardCenter` is what actually decides orientation there, not
  camera position. Do not "fix" orientation by flipping `squareToPosition`'s sign — that
  would desync rendering from every move-legality check.
- **Two independent engine process slots, not one.** `src-tauri/src/engine.rs`'s
  `WhiteEngine`/`BlackEngine` newtypes and `src/state/engineStore.ts`'s
  `createEngineStore(side)` factory (`useWhiteEngineStore`/`useBlackEngineStore`,
  `engineStoreForSide(side)`) exist because a side can be human, engine, or Lichess-
  controlled independently, and in Engine-vs-Engine mode both sides run their own process
  (same binary or different ones). Every Tauri command (`engine_start`/`engine_write_line`/
  `engine_stop`) takes a `side: String` and picks the matching slot. Resist "deduplicating"
  the two `createEngineStore` instances into one with a side field — that's exactly the
  singleton assumption that had to be undone to support two engines at once.
- **A `GameModePreset` (4 fixed values), not a free-form per-side picker.**
  `gameModeStore.ts`'s `"human-vs-engine" | "human-vs-lichess" | "engine-vs-lichess" |
  "engine-vs-engine"` drives which single control panel `App.tsx` renders — never more than
  one at a time. Free-form independent Human/Engine/Lichess pickers per side were
  considered and deliberately rejected as more surface than the app needs.
- **Lichess integration is two independent flows, not one.** `lichessStore.ts` is the
  **Board API** path (a human plays against/with a Lichess game the app streams and posts
  moves to). `lichessBotStore.ts` is the **Bot API** path (a local engine plays a Lichess
  bot game; `handleGameStart` copies its own `enginePath`/`movetimeMs` into whichever
  per-side engine store the bot ends up controlling, since Bot API mode doesn't know its
  assigned color until a challenge arrives). Both derive "which side is mine" from
  `gameStore.controllers` rather than tracking it themselves, and both funnel every
  connection-ending path through a single `failLichess`/`failBot` helper that pairs status
  + `gameStore.exitPlayMode()` — same reasoning as `engineStore`'s `failEngine`. All
  Lichess HTTP/NDJSON plumbing is Rust-side in `src-tauri/src/lichess.rs`; line parsing
  (`parseLichessLine`, `parseLichessAccountEvent`, `isTerminalStatus`) lives in
  `src/lib/lichess.ts`, the Lichess counterpart to `chessRules.ts`/`uci.ts`.
- **An engine's `engine-exit` event is not inherently a crash.** Rust's `stop_locked` kills
  the process and joins its stdout-reader thread — which emits `engine-exit-{side}` on
  EOF — before the `engine_stop` command returns, but Tauri does not order event delivery
  against that invoke's own promise: the event can arrive either before or after
  `stopEngine`'s own `finally` sets status `"idle"`. `engineStore.ts` latches a
  `stopRequested` flag (set before the invoke, consumed by the exit listener, reset at the
  start of a fresh `startEngine` in case a prior stop was a no-op) so a clean,
  user-requested Stop can never be silently overwritten by a spurious `"crashed"` status.
- **Selectable board palettes and piece styles, both same shape, both cosmetic-only.**
  `boardPalettes.ts` (Classic/Forest/Ocean/Slate, picked via `boardThemeStore`) and
  `pieceStyles.ts` (Classic/Modern-low-poly, picked via `pieceStyleStore`) never change
  geometry/behavior — palettes vary `meshStandardMaterial` colors, styles vary
  `segments`/`baseSegments` (round vs. faceted) on the same primitive composition in
  `Piece.tsx`. Board squares layer a procedural `createWoodTexture` (canvas-generated wavy
  grain lines, one texture per color shared across all 32 same-color squares, not one per
  square) on top of the active palette's colors — real, not just flat fill, but still no
  external image asset.
- **2D mode renders pieces as flat, camera-facing glyph icons, not a top-down photo of the
  3D geometry.** A 3D piece viewed from directly above reads as a near-identical disc
  regardless of type; `Piece.tsx`'s `PieceGlyph` instead draws a solid Unicode chess glyph
  (`pieceGlyphs.ts`, always the "black"/filled glyph variant U+265A-265F, color encoded via
  canvas fill/stroke rather than glyph choice, since the hollow variant renders
  inconsistently across fonts) onto a canvas texture mapped to a flat plane. That plane's
  rotation (`rotation={[-Math.PI/2,0,0]}`) is a **fixed world-space transform**, giving it
  a `(0,1,0)` normal that always faces the fixed top-down 2D camera — this must hold for
  every piece, both colors, both POV settings, since the camera flips its `up` vector
  between White/Black POV but this plane's rotation never does. Verified live in both POV
  settings. Do not change this rotation (e.g. via billboarding) without re-verifying every
  piece still renders face-up, not edge-on or upside-down, in both POV settings.
- **Move animation is driven at mount time, not by reacting to prop changes.** A `Piece`'s
  React key is its current square, so the piece that just moved always mounts fresh (its
  key changed) — there is no persisted component instance to animate a `position` prop
  change on for the mover itself. `Piece.tsx`'s `animateFrom` is consumed once in a
  mount-only `useLayoutEffect` (empty deps, deliberately) and driven by `useFrame`; the
  group's position is never set via a JSX `position` attribute, only imperatively, so r3f's
  own prop-diffing never fights the animation. `BoardScene` only computes `animateFrom` for
  an exact single-ply step (forward or backward) via `prevPlyRef` — bigger jumps snap.
- **Check/checkmate detection is `chessRules.checkStatus(fen)`, not a new ad-hoc `chess.js`
  call site.** `MoveHighlights` renders a pulsing ring on the returned `kingSquare` when
  `inCheck` — faster and redder when `checkmate` is also true. Keep this in `chessRules.ts`
  alongside `gameStatus`, not duplicated logic in a component.
- **All chess rules/PGN/UCI parsing live in `src/lib/chessRules.ts`**, wrapping `chess.js`.
  Nothing else in the codebase should import `chess.js` directly — route through this
  module so there is exactly one seam to test and one place that understands FEN/SAN/UCI.
- **`src-tauri` has zero chess/UCI-protocol logic.** `src-tauri/src/engine.rs` spawns the
  picked binary and pipes raw stdout lines as `engine-stdout` events — it never parses a
  UCI line. All `bestmove`/`info` parsing and all outgoing `position`/`go` construction
  live in `src/lib/uci.ts`, the UCI-protocol counterpart to `chessRules.ts`. Do not add
  parsing logic to `engine.rs`; extend `uci.ts` instead. `option` lines (`UciOption`) and
  the bounded per-search `info` history (`appendSearchInfo`, capped at 64 — see
  algorithmic-complexity guidance) live in the same file, same reasoning.
- **`startEngine` sends `uci` right after `engine_start` succeeds, fire-and-forget.** This
  is what makes the engine emit its `id`/`option`/`uciok` burst so `EngineOptions` has
  something to render. It does **not** gate on `uciok` before `maybeRequestEngineMove` —
  the existing position/go turn flow already works without that handshake completing, and
  changing that timing risks re-breaking the race fixed above. If a future engine genuinely
  needs `uciok` before accepting `position`, address that narrowly, not by blocking on it
  globally.
- **`setOption` on a `string`-type control commits on blur, not per-keystroke** — an
  `EvalFile`-style option is often a path, and sending `setoption` on every character would
  spam the engine's stdin with mostly-invalid intermediate values. `check`/`spin`/`combo`
  commit immediately since those are discrete events, not text input.
- **No `shell:execute` capability is granted, by design.** The `shell` plugin's model is
  built for bundled sidecars or a fixed allowlist, not an arbitrary path picked live from a
  file dialog. `engine_start` spawns directly via `std::process::Command` and validates the
  path itself (must be a real file) — the native file dialog is the trust boundary here,
  the same reasoning already applied to the `fs` read scope below. Do not "fix" this by
  adding a `shell:allow-execute` permission; it doesn't fit this use case.
- **Two OS-keychain slots, one per Lichess mode; slot selection lives in Rust, never in JS.**
  Human-vs-Lichess uses `lichess-human-token`, Engine-vs-Lichess uses `lichess-bot-token`
  (both under service `com.jediknights.chessboard`). Every `/api/board/*` Tauri command
  hardcodes `TokenSlot::Human`; every `/api/bot/*` command hardcodes `TokenSlot::Bot`;
  commands both modes use (event stream, challenge accept/decline) take a `slot:
  TokenSlot` parameter that serde validates against a fixed `"human"|"bot"` enum before
  it can reach the keychain. A malformed or admin-y string from a compromised frontend
  is rejected at the deserialize step, not at the request. On first launch after the
  PR-1 upgrade, `migrate_legacy_token` in `src-tauri/src/lichess.rs` copies the old
  single-entry `lichess-personal-token` into the human slot then deletes it — idempotent,
  so subsequent launches skip it.
- **Every authenticated Lichess request runs `enforce_slot_matches` before it goes out.**
  Bot-slot request under a non-BOT account, or human-slot request under a BOT account, is
  refused *in Rust* with a message telling the user which slot to use. The account type
  is verified once per slot via `GET /api/account` and cached in
  `SharedAccountCache`; `lichess_token_set` / `lichess_token_clear` /
  `lichess_bot_upgrade` all invalidate the entry for the affected slot so the next
  request re-verifies. The frontend (`lichessStore.connect`,
  `lichessBotStore.startListening`) checks the cached `verifiedAccount.isBot` for a
  defense-in-depth refusal without a round-trip, but Rust is the authoritative guard:
  the UI check exists only to produce the same error faster, never as a replacement.
  The `lichess_bot_upgrade` command is the one exception — it deliberately skips the
  guard, because the whole point of the endpoint is to *make* an account a bot, and
  requiring `is_bot == true` before it fires would be impossible. It still reads the
  bot slot's own token, so a misclick can't upgrade a real human's account.
- **Incoming challenges are routed through `decideChallenge` in `src/lib/lichess.ts`,
  which returns `accept | decline(reason) | drop(because)`.** Decline reasons are a
  serde-validated enum in Rust (`LichessDeclineReason`) and a matching string-literal
  union in TS -- exactly the set Lichess accepts on `POST /api/challenge/{id}/decline`;
  anything else Lichess 400s. The decision function's branch order is safety-first
  (self-challenge -> drop, wrong-destUser -> decline "generic") before policy
  (concurrent-game -> "later", variant -> "variant", custom-FEN -> "generic",
  correspondence -> "timeControl", rated-without-opt-in -> "rated"), so a malformed
  challenge doesn't get a misleading policy-reason decline that hides the real problem.
  Self-challenges *drop* rather than decline because Lichess 400s a self-decline;
  letting Lichess time them out is the correct behavior. Do not "clean up" by folding
  drop and decline into one branch -- they have different wire-level semantics.
- **`lichessBotStore.acceptRated` defaults to `false` and is persisted.** A bot testing
  an engine must not affect other players' ratings unless the operator has explicitly
  opted in. The checkbox lives in `LichessBotControls`; the decision function reads
  the persisted value. Do not flip the default without a separate, deliberate
  conversation about the fair-play implication.
- **Custom starting positions are declined for now** with reason "generic". Threading
  a start FEN through `Ply`/`gameStore`/`fenAtPly`/`buildPositionCommand` is a
  discrete follow-up (proposed in the PR-1 planning message and left explicitly out
  of scope). When it lands, the decideChallenge branch relaxes; until then, refusing
  is safer than accepting a challenge we can't actually play correctly.
- **Bot mode drives the engine with server clocks + lag margin; movetime is a *cap*, not
  the whole budget.** `handleGameStart` installs a `goBuilder` on the bot's side engine
  store (`engineStore.setGoBuilder`) that reads live `serverClocks` on every request and
  emits `go wtime .. btime .. winc .. binc .. movetime ..`. Only the bot's own clock is
  adjusted (subtracting elapsed-since-server-update + `lagMarginMs`); the opponent's
  clock is left at what Lichess reported, because while the bot is thinking the
  opponent's clock isn't ticking. `lagMarginMs` (persisted, default 100 ms) is headroom
  for this app's own IPC + HTTP latency on the return trip. `movetimeMs` is always
  included as an upper cap so a runaway allocation on bullet games can't burn the
  clock. Human-vs-engine and engine-vs-engine leave `goBuilder` unset and use the
  default `{ movetimeMs }` path unchanged. Do not remove either half: without the
  builder the engine plays a fixed movetime and time-forfeits itself; without the cap
  the engine's own allocation can misbehave.
- **`ucinewgame` between bot games; full stop-and-start when the engine binary changes.**
  `handleGameStart` inspects the target-side engine store: if `status === "ready"` and
  `path === bot.enginePath`, it reuses the running process via `newGame()` (which
  sends `ucinewgame` + `isready` and clears per-search state). If the path differs,
  it stops the current engine and starts the new one. Reuse is materially faster on
  real engines (opening book / hash-table warmup) and avoids the "startEngine no-ops
  on status=ready" trap in CLAUDE.md's other design decisions. Do not "simplify" back
  to unconditional stop-then-start.
- **Server clocks commit to the Lichess store *before* the move loop runs, not after.**
  `attemptMove` fires `gameStore.subscribe` synchronously, and the engine store's
  subscriber reads `serverClocks` inside `buildBotGoOptions` to build the `go` line.
  If clocks were updated after, every second-and-subsequent `go` on the same update
  would see the *previous* update's stale values, and in bullet games that consistently
  over-allocates. The per-ply think-time annotation still uses the *captured* pre-update
  snapshot -- both invariants hold together (fresh clocks for the engine, correct
  diff for the move log).
- **`gameStore.annotateLastPly` populates `thinkTimeSeconds` on live plies now.** Called
  from both Lichess stores immediately after `attemptMove` returns true, using the
  captured pre-update clock snapshot. Multi-move catch-ups on reconnect and no-clock
  games (correspondence, unlimited) leave the ply un-annotated -- MoveLog shows "—"
  in those cases, honestly, rather than fabricating a value.
- **The Lichess account event stream is dispatched by a mode-aware bus, not by whichever
  store happens to be listening.** `src/lib/lichessEventBus.ts` installs the raw
  `lichess-event-stream` / `lichess-event-exit` listeners exactly once and routes each
  event to `useLichessStore.handleAccountEvent` when the current game-mode preset is
  `human-vs-lichess`, or `useLichessBotStore.handleAccountEvent` when it's
  `engine-vs-lichess`. The two modes never run at once (menu lock -- see the earlier
  "Live-session menu lock" bullet), so a single-slot Rust connection is enough. Do not
  reintroduce a per-store `installListenersOnce` for the account event stream -- that's
  what put PR 4's routing in a bad place: the second mode would silently miss its
  gameStart events.
- **Human mode derives the human's color from `gameFull`'s `white.id` / `black.id`
  compared against `verifiedAccount.id`, not from a picker.** Every human-mode
  initiator (`seek`, `challengeUser`, `challengeAi`, `joinGameById`) primes the board
  with a placeholder `{ w: "lichess", b: "lichess" }` first (so moves stay locked until
  the connection is confirmed, per CLAUDE.md's startNewGame ordering rule); when
  `gameFull` arrives, `applyDerivedControllers` calls `gameStore.setControllers` to
  promote the matching side to `"human"` and set POV. Spectator connections (neither id
  matches) leave the placeholder in place -- moves stay locked, and the reason is
  logged to `debug.log`.
- **`gameStore.setControllers(controllers, pov?)` is the *only* narrow way to change
  who controls a side mid-game.** Deliberately does not touch `plies`/`ply`/`mode` --
  it exists specifically so `applyDerivedControllers` can promote a placeholder-lichess
  side to `human` once `gameFull` arrives, without erasing any moves that came in
  the same update. Do not use `setControllers` for "start a new game" -- that's
  `startNewGame`'s job and mixing the two undoes the placeholder-first ordering.
- **Board API real-time limits live in Rust, mirrored to the UI.** `MAX_TIME_MINUTES`
  (180), `MAX_INCREMENT_SECONDS` (60), AI level 1-8. Every seek/challenge/AI command
  validates before hitting Lichess, so a bad UI value produces a clear error, not a
  400 the user has to interpret.
- **`ChallengeColor` is a serde enum, same shape as `TokenSlot` /
  `LichessDeclineReason`.** `"random" | "white" | "black"` -- anything else is
  rejected at deserialize time before it can reach a request URL. `AI` challenges
  are always casual (Lichess policy); every other new endpoint accepts `rated`.
- **`gameStore` knows nothing about the engine, Lichess, or which controller is active.**
  `attemptMove(from, to, promotion?)` is the single append path for a human's click, an
  applied engine `bestmove`, and an incoming Lichess move alike — it just validates via
  `chessRules.tryMove` and appends. Turn-taking orchestration (`engineStore.ts`'s
  `maybeRequestEngineMove`, `lichessStore.ts`'s `maybeSendHumanMove`,
  `lichessBotStore.ts`'s `maybeSendEngineMove`) lives entirely in those stores, each
  subscribed to `gameStore`; the dependency only ever points one way, and every one of
  them independently derives "is it my move" from `gameStore.controllers`.
- **`attemptMove` always validates against the live end (`plies.length`), never the
  currently-viewed ply.** Only the *view* respects the reviewer's position: if the user
  was already at the end, `ply` advances with the new ply; if they were reviewing an
  earlier position, `ply` stays put while the game keeps progressing behind them. Before
  this, validating against `fenAtPly(plies, state.ply)` would reject an incoming
  Lichess/engine move as "illegal" the moment the user stepped back to review — the game
  would then wedge on a stale error. Do not "simplify" `attemptMove` back into a single
  `fenAtPly(plies, state.ply)` call.
- **Loading a different game (paste PGN, Open PGN file, Load from Lichess) is disabled
  while any engine or Lichess session is live.** `GameLoader` reads all four stores'
  statuses and disables its own inputs; the game-mode menu (`useViewMenu`) is locked in
  the same conditions. "Live" here means `engine.status ∈ {starting, ready, thinking}`,
  `lichessStore.status ∈ {connecting, connected}`, or
  `lichessBotStore.status ∈ {listening, playing}`. Mid-session `loadGame([...])` would
  clobber `plies` while a still-connected Lichess stream keeps appending on top, exactly
  the desync `movesToApply` was designed around; disabling both surfaces prevents that
  entry vector. Do not gate on `mode === "play"` alone — that misses an engine
  "ready"/"starting" between two engine-vs-engine games, a bot "listening" for its next
  challenge, and a human seek waiting on an opponent.
- **`EngineOptions` and `AnalysisPanel` render only when some side is engine-controlled,
  and they read that side's store.** Previously they defaulted to the black engine store
  in every mode; in human-vs-Lichess (no engine at all), the panel showed the *stopped*
  black engine's stale options, and clicking one called `setOption` → `failEngine` →
  `exitPlayMode`, silently killing the live Lichess game. The gate is `controllers.w`/
  `controllers.b` === `"engine"`; when neither is, both components return `null`.
- **Late bestmoves are dropped, not applied.** After a game ends (Lichess terminal status
  arrives, a human's move delivers checkmate on-board, the user disconnects) an engine
  that was mid-search will still emit a `bestmove` — `engineStore.applyEngineBestMove`
  checks `gameStore.mode`, `sideToMove(liveFen)`, and `gameStatus(liveFen).over` and
  drops the move rather than appending it (which would rewrite the board past a finished
  game) or POSTing it (which would target a closed Lichess stream). To help the engine
  return to `ready` promptly instead of sitting on its search context, both Lichess
  stores' terminal-status paths call `engineStoreForSide(engineSide).stopSearch()` —
  sending UCI `stop` if and only if the engine is currently thinking, so the guarded
  bestmove arrives sooner. Do not remove either half of this pair; without `stopSearch`
  the engine holds its search and blocks the next game; without the guard the eventual
  bestmove lands on the wrong game.
- **Starting a new game resets `gameStore` *before* confirming the engine/connection is
  ready, never after.** Every mode's start flow (`EngineControls.start()`,
  `LichessControls.connect()`, `lichessBotStore`'s `handleGameStart`,
  `EngineVsEngineControls`) calls `startNewGame(controllers, pov?)` first, then starts
  whatever it needs. Reversing that order is the exact bug that shipped once already: a
  late-arriving ready/turn check can fire against the *previous* game's leftover position,
  and the resulting stale reply lands on the fresh game as a spurious "illegal move" error.
- **`startNewGame` resets the board but deliberately leaves moves locked** (`mode` stays
  `"replay"`) — only an explicit `enterPlayMode()` call, made by the *caller* once
  everything it started has actually confirmed ready, unlocks `selectSquare`.
  `engineStore.ts`'s `startEngine` deliberately does **not** call `enterPlayMode()`/
  `checkTurn()` itself on success — when two engines are starting at once (Engine vs.
  Engine), the first one ready must not unlock moves or ask itself to go before the *other*
  requested engine/connection is confirmed. Each mode's own control component/store owns
  that ordering instead (e.g. `EngineControls.start()` awaits `startEngine`, checks the
  resulting `status === "ready"` itself, then calls `enterPlayMode()` + `checkTurn()`;
  `lichessBotStore`'s `handleGameStart` waits on both the engine *and* the bot game stream
  before doing the same). This fixed a real bug: flipping `mode` to `"play"` optimistically
  before knowing whether the engine would start let a human move pieces on both sides with
  nothing backing the game. Every path that ends a side's ability to keep playing
  (`engine_start`/connect failure, `engine-exit`, an illegal `bestmove`/Lichess move, a
  failed write) goes through that mode's `failEngine()`/`failLichess()`/`failBot()`, which
  pairs setting an error status with `gameStore.exitPlayMode()` — do not set one without
  the other, or the "moves are locked without anything live" bug comes back in a new shape.
- **`startEngine` guards against re-entrancy.** A double-invocation while a start is
  already in flight would spawn a second process, whose Rust-side startup kills the first
  one mid-flight — surfacing as a misleading "engine process exited unexpectedly" that has
  nothing to do with the engine binary itself. See `NOT_RUNNING` check in `engineStore.ts`.
- **Each side's engine path and movetime persist independently** via `createEngineStore`'s
  own `persist` key (`chess-board-engine-w` / `chess-board-engine-b`), same pattern as
  `themeStore`. Only `path`/`movetimeMs` are persisted (`partialize`) — live
  `status`/`lastInfo`/`errorMessage` must not survive a reload, since they describe a
  process that no longer exists. `lichessBotStore`'s own `enginePath`/`movetimeMs` persist
  separately again (`chess-board-lichess-bot-engine`) — see its own doc comment for why it
  can't just reuse a per-side engine store's persisted values.
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
- **The engine's stderr is captured, not discarded.** `engine.rs` pipes stderr (not
  `Stdio::null()`) into a bounded 20-line tail (`STDERR_TAIL_LINES`) and includes it in the
  `engine-exit` payload. Discarding it is exactly what made "engine process exited
  unexpectedly" useless — the crash diagnostic the engine printed was being thrown away
  before anyone ever saw it. Do not go back to `Stdio::null()` for stderr.
- **`debug_log.rs` is a separate, deliberately simple on-disk log** — one file
  (`<app log dir>/debug.log`), cleared at app launch (`lib.rs`'s `.setup()` hook) and at
  every "Start game" (`engineStore.startEngine`), so it never grows unbounded across a long
  session. Rust logs what it directly observes (spawn attempts, exit code + stderr);
  the frontend logs the semantic events it already has the context for (moves sent/received,
  every `failEngine` call). Existing for one reason: giving a human or Claude enough of a
  timeline to debug a crash after the fact without needing to have had DevTools open at the
  time. Don't log every `info` line here — that's high-volume, low-diagnostic-value noise;
  log decisions and failures, not routine search chatter.
- **`stopEngine` clears `errorMessage`.** Before this, clicking Stop left a stale crash
  message on screen with no way to dismiss it short of restarting the app. Any future
  "terminal" transition (a new manual action that fully resets engine state) should clear
  `errorMessage` too, for the same reason.

## Non-goals (deferred, not accidental)

- **Custom starting positions on Lichess bot games.** Threading a start FEN through
  `Ply`/`gameStore.fenAtPly`, `uci.ts`'s `buildPositionCommand`, and the challenge
  decision flow is its own scope. Until it lands, `decideChallenge` refuses a
  challenge with a non-null `initialFen`. Not a bug -- an explicit boundary.
- **Concurrent bot games.** The Rust-side `LichessConnection` slot is a singleton
  (one active game stream at a time), and supporting multiple would mean a
  per-game map plus a routing layer inside `pump_ndjson_stream`. `decideChallenge`
  returns `decline("later")` if `activeGameId` is set. See design decision above.

## Editor/toolchain notes

- **`tsconfig.json` targets ES2022** (both `target` and `lib`). Bumped from ES2020 in PR 3
  so `Array.prototype.at` and other now-standard idioms typecheck. The Tauri webview
  (Chromium / WebView2 / webkit2gtk 4.1+ / WKWebView on macOS) and Node 22+ all support
  ES2022 natively; Vite's own build target is separate and unchanged.

## Testing conventions

- Framework: Vitest. Black-box per the user's testing rules — tests exercise each
  module's exported functions only, never `chess.js` internals or another module's
  private state.
- One test file per lib module: `chessRules.test.ts`, `time.test.ts`, `uci.test.ts`,
  `boardGeometry.test.ts`, `engineIdentifier.test.ts`, `boardPalettes.test.ts`,
  `pieceStyles.test.ts`, `pieceGlyphs.test.ts`, `woodTexture.test.ts`, `lichess.test.ts`.
- State modules with real logic get their own test file: `gameStore.test.ts`
  (controllers/pov gating, `attemptMove`, playback navigation, cosmetic setters).
  `engineStore.test.ts` and `lichessStore.test.ts` mock `@tauri-apps/api/core`'s `invoke`
  and `@tauri-apps/api/event`'s `listen` — Tauri's own IPC boundary is a genuine system
  edge (same carve-out as mocking a Stripe/S3 client), not a same-team collaborator, so
  this doesn't violate the black-box rule above. The `listen` mock captures each
  registered callback by event name in a `Map`, and tests "deliver" a fake
  `engine-stdout-{side}`/`engine-exit-{side}` (or `lichess-game-stream`/`lichess-game-exit`)
  event by invoking that captured callback directly — the same public seam a real Tauri
  event arrives through, not a reach into the store's private closures. That map is
  deliberately *not* cleared between tests: `installListenersOnce` in both modules only
  ever calls `listen()` once per store instance for the lifetime of the module (mirrors
  production — installed once per app lifetime), so clearing the map in `beforeEach`
  would desync the test double from what the store actually does after the first test in
  the file. Coverage went from ~12%/14% to >90% on both modules this way: re-entrancy
  guards, success/failure paths, the `stopRequested` latch, and every listener-driven
  state transition (bestmove applied/duplicate/illegal, `info`/`option` upserts, Lichess
  move-stream application, terminal-status handling) are now exercised through real
  `gameStore`/store state, not just asserted-present. State modules that are pure
  persisted UI preference (`gameModeStore.ts`, `boardThemeStore.ts`, `pieceStyleStore.ts`)
  or pure Tauri-invoke orchestration with no exported pure logic (`lichessBotStore.ts`)
  still have no test file — extending the same IPC-boundary-mock pattern to them is a
  reasonable future follow-up, not done yet since neither was part of the coverage push
  that motivated this section.
- `pieceGlyphs.ts`'s `createGlyphTexture` and `woodTexture.ts`'s `createWoodTexture` are
  wrapped in `/* v8 ignore start|stop */` with an inline reason: both call
  `document.createElement("canvas")`, which throws in Vitest's `node` test environment
  (see `vite.config.ts`) — supporting them would mean adding jsdom plus the native
  `canvas` npm package (a Cairo system dependency) for two small procedural-texture
  functions, disproportionate to the payoff. Their pure helpers (`getPieceGlyph`,
  `hexToRgb`, `clampByte` — the last exported specifically so it has a test, since it has
  no DOM dependency of its own) are still fully tested.
- Rust: `engine.rs` has unit tests for the pure state-transition helpers (`write_line_locked`,
  `stop_locked` with no process running, the `stderr_tail` cap, two-engine-slot
  independence) that don't need a real `AppHandle`. The path-validation and actual-
  process-lifecycle branches, and all of `lichess.rs`, are verified manually against the
  real `chess-engine` binary and a real Lichess account instead — see the PRs that
  introduced live play and the Lichess integration for the exact verification steps.

## Non-goals (for now)

- GLTF piece models (both camera modes currently use procedural geometry: composed
  primitives in 3D, a flat Unicode-glyph texture in 2D — no model-loading pipeline)
- Drag-and-drop move input (click-to-select-then-click-destination is what's built; only
  revisit this if it turns out to be a real usability problem, not preemptively)

Do not build these speculatively — each is real scope with its own design questions that
deserve their own planning pass, not a drive-by addition on top of an unrelated change.
Board palettes, piece styles, wood-grain board texture, and tweened move animation were
all in this list once and have since shipped — see Design decisions above.
