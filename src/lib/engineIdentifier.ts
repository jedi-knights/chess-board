/**
 * Derives a GitHub-style "owner/repo" label for an engine binary from its
 * local path, e.g. "/Users/you/src/github.com/jedi-knights/chess-engine/engine"
 * -> "jedi-knights/chess-engine". Falls back to the binary's parent
 * directory name (usually the repo root) when no forge segment is found,
 * and to the raw path as a last resort — never throws, since this only
 * feeds a UI label, not a decision.
 *
 * Recognizes the common git-clone-default layouts:
 *   - `~/src/github.com/<owner>/<repo>/...` (`git clone` default via tools
 *     like `ghq`)
 *   - `~/github/<owner>/<repo>/...` (manual flat layout)
 *   - `~/src/gitlab.com/<owner>/<repo>/...` / `bitbucket.org`
 *
 * Pre-fix only matched the bare `github` segment, so the canonical
 * `github.com` layout fell through to the parent-dir-name fallback
 * ("chess-engine" instead of "jedi-knights/chess-engine").
 */
const FORGE_SEGMENTS = new Set([
  "github.com",
  "github",
  "gitlab.com",
  "bitbucket.org",
]);

export function deriveEngineIdentifier(path: string): string {
  const parts = path.split("/").filter(Boolean);
  // Walk from the deepest segment outward -- the forge directory lives
  // near the project root, not near filesystem root, so the lookup is
  // cheaper and more robust against something like `/github/.../github.com/...`.
  for (let i = parts.length - 1; i >= 0; i--) {
    if (FORGE_SEGMENTS.has(parts[i]) && parts.length > i + 2) {
      return `${parts[i + 1]}/${parts[i + 2]}`;
    }
  }
  return parts.length >= 2 ? parts[parts.length - 2] : path;
}
