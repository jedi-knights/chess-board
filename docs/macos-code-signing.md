# macOS Code Signing & Notarization

This document explains why the release pipeline signs and notarizes the macOS build, exactly
which secrets that requires, and the full step-by-step process to (re)create them — so you (or
anyone else who ends up maintaining this) can rotate a credential or set this up again from
scratch without having to rediscover any of this. Adapted from `jedi-knights/sun-qa-harness`'s
own copy of this doc, which solved the identical problem for a sibling Tauri app.

## Why this exists

Without a real Apple Developer ID signature, Tauri's bundler falls back to an **ad-hoc**
signature — a signature that doesn't actually cover the app bundle's resources, only the raw
executable. This isn't just a "click through a warning" problem: macOS Gatekeeper rejects an
ad-hoc-signed app outright as **"app is damaged, move to Trash."**

Signing with a real **Developer ID Application** certificate and notarizing the build with Apple
fixes this: a signed, notarized, stapled build installs and opens with zero prompts — no
"unidentified developer" warning, no admin password, nothing. Notarization is required for *any*
distribution outside the Mac App Store — it applies exactly the same whether you're distributing
via the App Store, a direct download, or (as here) GitHub Releases and a Homebrew Cask.

## The six secrets

All six live as GitHub Actions repository secrets on `jedi-knights/chess-board`, consumed by the
`tauri-apps/tauri-action` step in `.github/workflows/release.yml`. `tauri-action` passes them
straight through to the underlying `tauri build`, which reads them directly — see
[Tauri's own macOS signing docs](https://v2.tauri.app/distribute/sign/macos/).

| Secret | What it actually is | Validated by |
|---|---|---|
| `APPLE_CERTIFICATE` | The Developer ID Application certificate + private key, exported as a `.p12` and base64-encoded | Only used locally during the build to unlock/install the cert |
| `APPLE_CERTIFICATE_PASSWORD` | An **arbitrary password you invent** when exporting the `.p12` from Keychain Access. Nothing to do with your Apple ID. | Only used locally to decrypt that `.p12` file |
| `APPLE_SIGNING_IDENTITY` | The exact certificate identity string, e.g. `Developer ID Application: Jane Smith (ABCDE12345)` | Matched against the imported certificate at build time |
| `APPLE_ID` | Your Apple ID email address | Apple's notarization servers |
| `APPLE_PASSWORD` | An **app-specific password** Apple generates for you (format `xxxx-xxxx-xxxx-xxxx`) — **not** your Apple ID's real password, and **not** the same as `APPLE_CERTIFICATE_PASSWORD` | Apple's notarization servers |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID | Apple's notarization servers |

`APPLE_CERTIFICATE_PASSWORD` and `APPLE_PASSWORD` are the two easiest to mix up — one is a
password *you* invent for a local file, the other is a password *Apple* generates and verifies
against its own servers. They must not be set to the same value unless that value happens to
genuinely be the Apple-issued app-specific password.

## Prerequisites

- An **active** (not pending) Apple Developer Program enrollment. Apple gates the "Developer ID
  Application" certificate type behind a paid, approved membership — you cannot create one while
  enrollment shows as pending. You'll get a confirmation email once approved, or check status by
  signing in at [developer.apple.com](https://developer.apple.com). Apple's stated turnaround is
  24–48 hours, but has been running to weeks in 2026 per multiple Apple Developer Forum threads —
  don't assume something's wrong if it takes longer than a couple of days.

## Step-by-step setup (or rotating an expired certificate)

Run all of this on a Mac. Developer ID Application certificates are typically valid for around 5
years; when one expires, redo steps 1–5 and update `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY`. Team ID, Apple ID, and the
app-specific password don't change on cert rotation.

### 1. Generate a CSR (Certificate Signing Request)

Keychain Access → menu bar **Keychain Access → Certificate Assistant → Request a Certificate from
a Certificate Authority**:

- Email: your Apple ID email
- Common Name: anything descriptive, e.g. `chess-board signing`
- Select **"Saved to disk"**
- Save as `CertificateSigningRequest.certSigningRequest`

This must be run on the same Mac you'll later export the `.p12` from — the CSR's private key
stays in that Mac's keychain, and the certificate you get back only has a usable identity when
paired with that same key.

### 2. Create the certificate on the Apple Developer portal

- developer.apple.com → **Certificates, Identifiers & Profiles** → **Certificates** → **+**
- Choose **Developer ID Application** (under "Software")
- Profile type: **G2 Sub-CA** (the current CA generation; "Previous Sub-CA" is only for
  pre-2020/Xcode-11.4.1 compatibility — there's no reason to pick it for a new certificate)
- Upload the `.certSigningRequest` from step 1
- Download the resulting `.cer`, double-click it — installs into your login Keychain

### 3. Fix a "not trusted" certificate, if you hit it

If Keychain Access shows a red X / "not trusted" on the new certificate, you're missing an
intermediate certificate in the trust chain:

- Double-click the certificate → **Issuer Name** → note the **Organizational Unit** value under
  "Apple Worldwide Developer Relations Certification Authority" (should say G2, matching step 2)
- Download the matching intermediate from <https://www.apple.com/certificateauthority/> —
  **"Developer ID - G2"**
- Double-click to install it

If that doesn't clear it, check for a custom trust override: double-click the cert (and the
intermediate/root), expand **Trust**, confirm "When using this certificate" is **Use System
Defaults**.

### 4. Fix "0 valid identities found", if you hit it

Running `security find-identity -v -p codesigning` and getting `0 valid identities found` means
either the certificate isn't actually imported, or (more likely) **the certificate exists but its
private key doesn't** — usually because the CSR in step 1 was generated on a different Mac than
this one. Open Keychain Access → **My Certificates** → find the cert → expand its disclosure
triangle. No nested private key underneath means: redo step 1 (fresh CSR, same Mac) and step 2
(new certificate from that CSR).

### 5. Export the certificate as `.p12`

Once `security find-identity -v -p codesigning` shows your identity:

- Keychain Access → **My Certificates** → right-click the cert → **Export**
- Format: **Personal Information Exchange (.p12)**
- Set a password — this is `APPLE_CERTIFICATE_PASSWORD`, an arbitrary value you choose right now.
  Generate a random one: `openssl rand -base64 24`

Then base64-encode it for CI:

```bash
openssl base64 -A -in /path/to/exported.p12 -out cert-base64.txt
```

### 6. Get the exact signing identity string

```bash
security find-identity -v -p codesigning
```

Copy the string exactly, e.g. `Developer ID Application: Jane Smith (ABCDE12345)` — this is
`APPLE_SIGNING_IDENTITY`.

### 7. Get your Team ID

developer.apple.com → **Account** → **Membership Details** → copy the Team ID. This is
`APPLE_TEAM_ID`. (Not the same thing as your Program "Enrollment ID," which isn't used anywhere
in this process.)

### 8. Generate an app-specific password

appleid.apple.com → **Sign-In and Security** → **App-Specific Passwords** → generate one, label
it something like `chess-board-ci`. Copy it immediately — Apple only shows it once. This is
`APPLE_PASSWORD`.

### 9. Set all six GitHub secrets

```bash
gh secret set APPLE_CERTIFICATE --repo jedi-knights/chess-board < cert-base64.txt
gh secret set APPLE_CERTIFICATE_PASSWORD --repo jedi-knights/chess-board
gh secret set APPLE_SIGNING_IDENTITY --repo jedi-knights/chess-board
gh secret set APPLE_TEAM_ID --repo jedi-knights/chess-board
gh secret set APPLE_ID --repo jedi-knights/chess-board
gh secret set APPLE_PASSWORD --repo jedi-knights/chess-board
```

(Omitting the value after the secret name makes `gh` prompt interactively, so nothing sensitive
lands in shell history.)

## Verifying it worked

After a release run completes, download the resulting DMG and check:

```bash
codesign -dv --verbose=4 /Volumes/chess-board/chess-board.app
# Should show: Authority=Developer ID Application: ...
#              TeamIdentifier=<your Team ID>
# (NOT "Signature=adhoc")

spctl -a -vv /Volumes/chess-board/chess-board.app
# Should show: accepted
#              source=Notarized Developer ID
```

If both show that, dragging the app to `/Applications` and double-clicking it should launch with
no Gatekeeper prompt at all.

## Diagnosing a hung "Notarizing..." step

The `release` job in `.github/workflows/release.yml` carries a 30-minute `timeout-minutes` so a
hung notarization attempt fails within 30 minutes instead of running for hours. If you hit that
timeout, the CI log itself won't tell you why: `xcrun notarytool submit --wait` (what `tauri build`
runs under the hood) prints nothing while it polls Apple's servers, so a genuinely slow-but-working
submission and a silently-failing-auth submission look identical in the log — both are silence
followed by a timeout.

**Run this first, locally, to tell the two apart:**

```bash
xcrun notarytool history \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

`history` authenticates the same way `submit` does but doesn't submit anything, so it returns in
seconds. It's the fastest way to isolate credentials from everything downstream:

- **Returns immediately with an auth error** (`HTTP status code: 401`, `Invalid credentials`,
  `No Team ID matching...`) → the credentials really are wrong. See the checklist below.
- **Returns a history list, but past submissions are stuck at `status: In Progress` for far
  longer than they should be** → credentials are fine — this is a genuine Apple Notary service
  backlog, not a config problem. A `history` call that succeeds *at all* proves auth passed;
  an invalid password or Team ID fails that call outright rather than returning stale-looking
  results.

If you're in the stuck-in-queue case:

- **Waiting longer is the only direct lever** — there's no client-side action that speeds up
  Apple's own processing queue.
- **File a request with Apple Developer Support** if a submission has been `In Progress` for
  several hours, referencing the specific submission `id` from `history`'s output — Apple support
  can look up and unstick a specific queue entry.
- **The 30-minute CI timeout is still correct to keep** even though it isn't a credentials bug —
  without it, a queue backlog burns a macOS runner for up to 6 hours (GitHub's default job
  timeout) per release attempt instead of failing fast and freeing the runner.

If instead `history` fails outright with an auth error, work through this checklist:

- **Team ID / cert mismatch** — `APPLE_TEAM_ID` must be the team the `APPLE_SIGNING_IDENTITY`
  certificate was actually issued under. If the Apple ID belongs to more than one team, it's easy
  to copy the wrong one from Membership Details.
- **Unaccepted Apple agreement** — sign in at developer.apple.com/account and check for a pending
  Program License Agreement update. Apple blocks Notary API auth on this with no clear error
  surfaced through `notarytool`.
- **App-specific password / Apple ID mismatch** — the password must have been generated for the
  exact `APPLE_ID` value being used, at appleid.apple.com → Sign-In and Security →
  App-Specific Passwords. It must be the Apple-generated `xxxx-xxxx-xxxx-xxxx` password, not
  `APPLE_CERTIFICATE_PASSWORD` (which is a value you invent yourself for the local `.p12`
  export and which Apple's servers never see).

## Reference

- [Tauri v2 — Signing macOS Applications](https://v2.tauri.app/distribute/sign/macos/) — the
  canonical source for which env vars Tauri reads and what each does.
- [Apple PKI — Certificate Authority page](https://www.apple.com/certificateauthority/) — where
  to download intermediate certificates.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — where these secrets are
  actually consumed, in the `release` job's `tauri-apps/tauri-action` step.
