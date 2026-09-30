/** Formats a move's think-time as "12s" or "1:23" (m:ss), never negative. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Formats a Date as a local wall-clock HH:MM:SS string. */
export function formatClockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Formats a remaining game clock (in milliseconds) as `M:SS`, or
 * `H:MM:SS` when the clock exceeds an hour. Rounds *down* on seconds --
 * a reading of 999 ms shows "0:00" because the player has effectively
 * no time left, and showing "0:01" would misrepresent the state. */
export function formatClockMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = clamped % 60;
  const minutes = Math.floor(clamped / 60) % 60;
  const hours = Math.floor(clamped / 3600);
  const ss = seconds.toString().padStart(2, "0");
  const mm = minutes.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
