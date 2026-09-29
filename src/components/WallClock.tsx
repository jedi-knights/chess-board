import { useEffect, useState } from "react";
import { formatClockTime } from "../lib/time";

/** Live current-time display — ticks every second. Not a per-move timer. */
export function WallClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return <span className="wall-clock">{formatClockTime(now)}</span>;
}
