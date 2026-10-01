# Lichess integration — manual verification runbook

Six end-to-end scenarios that exercise every user-visible behavior added in
PRs 0–6. Each is independent — run them in any order; each names the PRs
whose invariants it exercises so a failure points at a specific commit range.

## Prerequisites

Set aside ~30 minutes and have on hand:

- Two Lichess accounts:
  - **Your regular (human) account.** Any account with no BOT title.
  - **A dedicated BOT account** — the Lichess terms of service require that
    engine play happen under a BOT-titled account. If you don't have one,
    scenario 4 walks through the upgrade; it's irreversible on Lichess's
    side, so pick an account you're OK dedicating to bot play forever.
- Personal access tokens for both accounts:
  - Human: `board:play` scope minimum.
  - Bot: `bot:play` + `challenge:write`.
  - Generate at <https://lichess.org/account/oauth/token/create>.
- A local UCI engine binary. `jedi-knights/chess-engine`'s `./engine`
  works; anything that speaks UCI is fine.
- The app open in dev mode: `pnpm tauri dev`.
- A terminal tailing the debug log — every scenario references it:
  - macOS: `tail -f ~/Library/Logs/com.jediknights.chessboard/debug.log`
  - Linux: `tail -f ~/.local/share/com.jediknights.chessboard/logs/debug.log`

If any scenario fails, capture the debug log and the app's error message
before moving on — the two together are almost always enough to pin the
regression to a specific PR.

## 1. Human vs. BOT end-to-end game

**Exercises:** PR 1 (per-slot credentials + fair-play guard), PR 2
(challenge decisions), PR 3 (clock-driven `go`, `ucinewgame`,
live-ply think-time), PR 5 (in-game actions).

**Setup:**

1. In the app, choose **View → Game Mode → Engine vs Lichess (Bot API)**.
2. Paste the bot token into the bot slot. Wait for the verified username
   to appear. If the account isn't a BOT yet, the "Upgrade to Bot account"
   panel is shown; go through it (see scenario 4).
3. Pick your engine binary. Leave movetime at 1000, lag margin at 100.
4. Click **Start listening for challenges**. Status should read `listening`.
5. Open a second app instance or use the human account on lichess.org
   to send a challenge:
   - Standard, casual, 5+3, random color, to the bot account's username.

**Expected:**

- Bot mode: `debug.log` shows the challenge being decided as `accept`
  (or `decline(rated)` if you sent it rated — resend casual to accept).
- Bot auto-accepts. Status flips to `playing`. A game id appears
  after "playing".
- Board loads with pieces on their squares; POV is set to whichever
  color the bot got.
- If the bot plays white, the engine sends a `bestmove` within the
  configured movetime (or sooner in the opening). `debug.log` shows
  the engine's `position startpos` + `go wtime ... btime ... winc ...
  binc ... movetime ...` line.
- Play a few moves each side. `debug.log` shows `sending engine move:
  ...` and matching `bestmove` lines. The move log's think-time column
  shows real seconds, not "—".
- Try **Offer/agree draw** in the bot's game window — Lichess shows the
  draw offer to the human account. Decline it there.
- Try **Resign** — game ends immediately, status flips back to
  `listening`, board resets clean.

**Bonus:** Send a second casual challenge right after the first game
ends. `debug.log` should show `reusing ready engine via ucinewgame +
isready` — not `engine_start`. Confirms PR 3's between-games reuse.

**Fails if:**

- Engine plays fixed movetime regardless of clock (PR 3 regression).
- Between-games shows `engine_start` (PR 3 regression).
- Draw button doesn't produce a Lichess-side offer (PR 5 regression
  or slot mismatch).

## 2. Reviewing an earlier ply mid-game

**Exercises:** PR 0 (`attemptMove` validates against live end, not
viewed ply). This is the single biggest bug in the pre-PR-0 code.

**Setup:**

1. Continue from scenario 1's setup (or start any live game — human
   mode or bot mode both work).
2. Play at least three moves each side (so there's history to review).

**Expected:**

- Click a move in the move log or hit `<` a few times to step back.
- The board updates to that historical position. Your viewer is now
  at ply N < plies.length.
- Wait for the opponent to make a move (or move the engine along).
- **The opponent's move lands correctly on the live position** — the
  board you're looking at stays put (still showing your reviewed
  position), but `plies.length` in the move log grows.
- Step forward with `>|` or **End** — the new position now includes
  the opponent's move.

**Fails if:**

- The opponent's move is rejected as "illegal" (`errorMessage` appears
  in the sidebar). This is the PR 0 pre-fix bug: `attemptMove` was
  validating the incoming move against the FEN at the *viewed* ply,
  not the live end.
- The view jumps forward on the incoming move without you asking.
  (View should stay at the reviewed ply; only the tail grows.)

## 3. Mid-game network drop and silent resync

**Exercises:** PR 6 (byte-buffered NDJSON + keep-alive dead-stream
detection + exponential-backoff reconnect).

**Setup:**

1. Start a game — human vs. AI is fastest (**View → Game Mode → Human
   vs Lichess**, then **Play the Lichess AI, level 1, 10+0**). AI moves
   instantly so the stream sees regular traffic.
2. Play a few moves.

**Expected:**

- Turn wifi off (or block the network with your OS's firewall).
- Wait 20–30 seconds. `debug.log` shows either:
  - `[lichess] stream ended: no data for 20s -- assumed dead; reconnecting`
    (the keep-alive-timeout path), or
  - `[lichess] stream ended: stream error: ...; reconnecting`
    (the raw-error path).
- Turn wifi back on. Within a few seconds, the app is playing again:
  - The board resyncs from `gameFull` (silently — no user-facing error).
  - Any moves that arrived during the drop are applied.
  - The reconnect count in the debug log resets on the first
    successful line.
- The move log's timeline is intact; think-times for the moves that
  arrived during reconnect show "—" (multi-move catch-up can't
  attribute per-move think-times; documented behavior).

**Bonus — multi-byte UTF-8:** Have someone send you a challenge with
a username containing a non-ASCII character (e.g. `José_bot` if you
have such an account, or set your Lichess profile bio to include one
so `debug.log` echoes it). The name should render correctly in the
sidebar, not as `?` or `� `. Confirms PR 6's per-line UTF-8 decoding.

**Fails if:**

- The app shows an error and refuses to keep playing after wifi
  returns. `debug.log` should show retry attempts; if it doesn't, the
  reconnect loop isn't running. Check that `stream_with_reconnect`
  isn't emitting `exit_event` on transient errors (PR 6 regression).

## 4. Variant + self-challenge decline

**Exercises:** PR 2 (`decideChallenge` decline reasons + self-challenge
drop). Also touches PR 5 (`challengeDeclined` event handling).

**Setup:**

1. Bot mode listening (as in scenario 1).
2. Second Lichess account (or lichess.org) ready to send challenges to
   the bot.

**Variant decline:**

- From the human account, send a **Chess960** challenge to the bot.
- Expected: the challenge is *declined* with reason `variant` on the
  human's inbox. `debug.log` on the bot side shows:
  `challenge <id> from <you>: variant=chess960 ... -> decline(variant)`

**Self-challenge drop:**

- On the bot account itself (via Lichess web UI), issue an outgoing
  challenge to your human account. This produces a `challenge` event
  on the bot's own event stream (because the challenger is the bot).
- Expected: the bot **does not** try to accept it and **does not** call
  the Lichess decline endpoint (Lichess 400s a self-decline).
  `debug.log` shows: `-> drop(self-challenge)`.
- The challenge lives on Lichess's side until it times out naturally.

**Rated decline (extra):**

- From the human account, send a **standard rated** 5+3 challenge.
- Expected: `-> decline(rated)`. Toggle **Accept rated challenges** on
  in the sidebar and resend — expected: `-> accept`.

**Fails if:**

- Bot accepts a variant challenge (PR 2 regression).
- Bot POSTs to `/api/challenge/{id}/decline` for a self-challenge
  (Lichess returns 400; the guard exists to prevent this).

## 5. Clock-pressure game (bullet)

**Exercises:** PR 3 (clock-aware `go` with lag margin).

**Setup:**

1. Human account challenges the bot to a **1+0 bullet** game
   (via lichess.org or the human-mode challenge-user UI in a second
   app instance).
2. Bot accepts (assuming casual or acceptRated is on).

**Expected:**

- `debug.log` on every bot move shows a `go` line with `wtime`, `btime`,
  `winc 0`, `binc 0`, and `movetime` (the movetime cap). Only the bot's
  own-side clock is decremented by `elapsed + lagMarginMs`; the
  opponent's clock is passed through.
- Bot moves faster in bullet than in blitz — the engine's own-clock
  allocation kicks in.
- Bot does not time-forfeit before its bestmove lands. If it does
  consistently, raise the lag margin (Bot mode sidebar) to 200–300 ms
  and retry.

**Fails if:**

- `go` line has only `movetime` (PR 3 clock-driven path never installed).
- Bot loses on time repeatedly even at wide lag margins — that's likely
  an actual engine performance issue, not a chess-board bug.

## 6. Fair-play cross-slot refusal

**Exercises:** PR 1 (`enforce_slot_matches` — the fair-play guard).

**Setup:**

Two variations of the same test — Rust must refuse each, twice:

**6a. Human token in bot slot.**

1. In bot mode, clear the bot slot's token (if set).
2. Paste your *human* account's PAT into the bot-slot input.
3. Click **Start listening for challenges**.

Expected: refusal with a message like
`the bot slot's token belongs to a non-BOT account ("<your-username>")
-- either use the human slot or upgrade this account to BOT`.
No engine spawns, no event stream opens.

**6b. Bot token in human slot.**

1. In human mode, clear the human slot's token.
2. Paste the *BOT* account's token into the human-slot input.
3. Try to seek an opponent, challenge a user, or challenge AI.

Expected: refusal with
`the human slot's token belongs to a BOT account ("<bot-username>") --
put it in the bot slot instead`. No POST goes out.

**Fails if:**

- Either operation proceeds. The fair-play guard is code-enforced in
  Rust (`enforce_slot_matches`) and the frontend duplicates the check
  for a fast error; both should refuse.

**Bonus:** after fixing the slot mismatch (moving each token to its
correct slot), verify play still works. Confirms the cache-invalidate
paths in `lichess_token_set`/`_clear`.

## 7. OAuth 2.0 + PKCE sign-in

**Exercises:** PR 7 (`lichess_oauth_login`, loopback listener, PKCE
verifier + challenge + state, token exchange).

**Setup:**

1. Clear the human-slot token if one is set (Clear token button).
2. In **Human vs Lichess** mode (the sidebar panel is titled "Play on
   Lichess"), click **Sign in with Lichess**.

**Expected:**

- The button label flips to "Waiting for browser…".
- Your default browser opens to `https://lichess.org/oauth?...` with
  `client_id=com.jediknights.chessboard`, `scope=board%3Aplay`, a
  `code_challenge`, and a `state`.
- Log in / approve. The tab redirects to `http://127.0.0.1:<port>/callback?code=...&state=...`
  and shows "Signed in to Lichess — you can close this window".
- Back in the app: the button snaps back to normal, the "Token saved
  in the OS keychain — verified as `<username>`" line appears.
- `debug.log` shows the flow end-to-end:
  - `[lichess-oauth] authorize on :<port> for Human`
  - `[lichess-oauth] signed in as <username> (isBot=false) in slot Human`
- Now start a seek or AI challenge — plays as normal (the OAuth token
  is functionally identical to a PAT with the same scope).

**Repeat for the bot slot** in Engine-vs-Lichess mode with a BOT
account. Same shape; the scope should be `bot:play` + `challenge:write`.

**Fails if:**

- The browser tab doesn't open (opener plugin failure).
- The browser tab shows a 400 (state mismatch — should never happen
  on a legitimate flow; suggests a browser extension or middlebox
  interfered).
- `debug.log` shows `OAuth flow timed out after 300s` — you took too
  long. Just click Sign in again.
- The success HTML shows in the browser but the app's UI never
  updates. Check that the loopback port matched between the
  authorize URL and the callback (in `debug.log`).

**Fair-play spot-check:** Sign in with a BOT account into the human
slot. The verify call should immediately show the "BOT account" refusal
banner (same as scenario 6b's paste-token case). Confirms the OAuth
path funnels into the same slot-matches guard.

## Cross-cutting checks

Any time a scenario finishes cleanly, glance at:

- **The debug log for surprises.** Anything that isn't a `sending:` /
  `received:` / `challenge:` / `game:` line is worth reading. Reconnect
  attempts are fine; unhandled exceptions are not.
- **The GameLoader.** In the sidebar's Configuration tab, verify that
  paste-Load, Open PGN file, and Load-from-Lichess are all *disabled*
  while any of the six scenarios above is live (PR 0's 0b fix). Also
  verify the native View → Game Mode menu is greyed out (PR 0's 0c fix).
- **The Move log's live game clocks.** The LiveGameClocks panel above
  the move log should tick down for whichever side is to move; the
  other side's clock stays frozen (PR 3).
