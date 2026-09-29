/**
 * Derives a GitHub-style "owner/repo" label for an engine binary from its
 * local path, e.g. "/Users/you/src/github/jedi-knights/chess-engine/engine"
 * -> "jedi-knights/chess-engine". Falls back to the binary's parent
 * directory name (usually the repo root) when no "github" segment is
 * found, and to the raw path as a last resort — never throws, since this
 * only feeds a UI label, not a decision.
 */
export function deriveEngineIdentifier(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const githubIndex = parts.lastIndexOf("github");
  if (githubIndex !== -1 && parts.length > githubIndex + 2) {
    return `${parts[githubIndex + 1]}/${parts[githubIndex + 2]}`;
  }
  return parts.length >= 2 ? parts[parts.length - 2] : path;
}
