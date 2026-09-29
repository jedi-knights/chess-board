import { describe, expect, it } from "vitest";
import { formatClockTime, formatDuration } from "./time";

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("formats minute-plus durations as m:ss", () => {
    expect(formatDuration(60)).toBe("1:00");
    expect(formatDuration(83)).toBe("1:23");
    expect(formatDuration(605)).toBe("10:05");
  });

  it("clamps negative input to zero instead of showing a negative duration", () => {
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("formatClockTime", () => {
  it("renders a two-digit hour:minute:second string", () => {
    const rendered = formatClockTime(new Date("2024-01-01T09:05:03"));
    expect(rendered).toMatch(/^\d{1,2}:\d{2}:\d{2}\s?(AM|PM)?$/i);
  });
});
