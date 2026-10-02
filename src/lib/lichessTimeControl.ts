/** Lichess classifies a game's time control into one of five categories
 * based on an estimated duration: `clock.limit + 40 * clock.increment`
 * (in seconds). The category determines which rating pool the game
 * updates. Thresholds mirror Lichess's own classification exactly so
 * our UI label matches what Lichess will report back on the game.
 * Source: Lichess API docs, "Time Control" section. */
export type LichessTimeCategory =
  | "UltraBullet"
  | "Bullet"
  | "Blitz"
  | "Rapid"
  | "Classical";

/** Estimated duration in seconds for a given clock-limit (minutes) and
 * increment (seconds), using Lichess's own formula. Exported so the
 * caller can display it alongside the category label if desired. */
export function estimatedDurationSeconds(
  clockLimitMinutes: number,
  clockIncrementSeconds: number,
): number {
  return clockLimitMinutes * 60 + 40 * clockIncrementSeconds;
}

/** Maps a (limit, increment) pair to its Lichess rating category. */
export function categoryFor(
  clockLimitMinutes: number,
  clockIncrementSeconds: number,
): LichessTimeCategory {
  const estimate = estimatedDurationSeconds(clockLimitMinutes, clockIncrementSeconds);
  if (estimate < 30) return "UltraBullet";
  if (estimate < 180) return "Bullet";
  if (estimate < 480) return "Blitz";
  if (estimate < 1500) return "Rapid";
  return "Classical";
}

/** The named presets the challenge UI offers. Order matters -- the
 * dropdown renders in this order, grouped by category. These are the
 * common Lichess arena / seek time controls; a user who wants a
 * nonstandard clock can still edit the Minutes/Increment fields
 * directly, at which point `matchPreset` returns null and the
 * dropdown shows "Custom". */
export type TimeControlPreset = {
  label: string;
  clockLimitMinutes: number;
  clockIncrementSeconds: number;
};

export const TIME_CONTROL_PRESETS: readonly TimeControlPreset[] = [
  { label: "Bullet 1+0", clockLimitMinutes: 1, clockIncrementSeconds: 0 },
  { label: "Bullet 2+1", clockLimitMinutes: 2, clockIncrementSeconds: 1 },
  { label: "Blitz 3+0", clockLimitMinutes: 3, clockIncrementSeconds: 0 },
  { label: "Blitz 3+2", clockLimitMinutes: 3, clockIncrementSeconds: 2 },
  { label: "Blitz 5+0", clockLimitMinutes: 5, clockIncrementSeconds: 0 },
  { label: "Blitz 5+3", clockLimitMinutes: 5, clockIncrementSeconds: 3 },
  { label: "Rapid 10+0", clockLimitMinutes: 10, clockIncrementSeconds: 0 },
  { label: "Rapid 10+5", clockLimitMinutes: 10, clockIncrementSeconds: 5 },
  { label: "Rapid 15+10", clockLimitMinutes: 15, clockIncrementSeconds: 10 },
  { label: "Classical 30+0", clockLimitMinutes: 30, clockIncrementSeconds: 0 },
  { label: "Classical 30+20", clockLimitMinutes: 30, clockIncrementSeconds: 20 },
];

/** Finds the preset exactly matching a (limit, increment) pair, or
 * null if the pair is a custom value the dropdown should show as
 * "Custom". */
export function matchPreset(
  clockLimitMinutes: number,
  clockIncrementSeconds: number,
): TimeControlPreset | null {
  return (
    TIME_CONTROL_PRESETS.find(
      (p) =>
        p.clockLimitMinutes === clockLimitMinutes &&
        p.clockIncrementSeconds === clockIncrementSeconds,
    ) ?? null
  );
}
