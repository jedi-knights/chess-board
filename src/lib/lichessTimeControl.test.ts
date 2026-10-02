import { describe, expect, it } from "vitest";
import {
  categoryFor,
  estimatedDurationSeconds,
  matchPreset,
  TIME_CONTROL_PRESETS,
} from "./lichessTimeControl";

describe("estimatedDurationSeconds", () => {
  it("uses the Lichess formula clock + 40 * increment", () => {
    expect(estimatedDurationSeconds(5, 3)).toBe(5 * 60 + 40 * 3);
    expect(estimatedDurationSeconds(10, 5)).toBe(10 * 60 + 40 * 5);
    expect(estimatedDurationSeconds(1, 0)).toBe(60);
  });
});

describe("categoryFor", () => {
  it("classifies classic examples at each Lichess threshold", () => {
    // UltraBullet: estimate < 30s. 0.25+0 = 15s.
    expect(categoryFor(0.25, 0)).toBe("UltraBullet");
    // Bullet: 30 <= estimate < 180. 1+0 = 60s; 2+1 = 160s.
    expect(categoryFor(1, 0)).toBe("Bullet");
    expect(categoryFor(2, 1)).toBe("Bullet");
    // Blitz: 180 <= estimate < 480. 3+0 = 180s; 5+3 = 420s.
    expect(categoryFor(3, 0)).toBe("Blitz");
    expect(categoryFor(5, 3)).toBe("Blitz");
    // Rapid: 480 <= estimate < 1500. 10+0 = 600s; 15+10 = 1300s.
    expect(categoryFor(10, 0)).toBe("Rapid");
    expect(categoryFor(15, 10)).toBe("Rapid");
    // Classical: estimate >= 1500. 30+0 = 1800s.
    expect(categoryFor(30, 0)).toBe("Classical");
    expect(categoryFor(60, 0)).toBe("Classical");
  });

  it("handles boundary values exactly at Lichess's cutoffs", () => {
    // Exactly 30s: Bullet (threshold is <30 for UltraBullet).
    expect(estimatedDurationSeconds(0.5, 0)).toBe(30);
    expect(categoryFor(0.5, 0)).toBe("Bullet");
    // Exactly 180s: Blitz. 3+0 = 180.
    expect(estimatedDurationSeconds(3, 0)).toBe(180);
    expect(categoryFor(3, 0)).toBe("Blitz");
    // Exactly 480s: Rapid. 8+0 = 480.
    expect(estimatedDurationSeconds(8, 0)).toBe(480);
    expect(categoryFor(8, 0)).toBe("Rapid");
    // Exactly 1500s: Classical. 25+0 = 1500.
    expect(estimatedDurationSeconds(25, 0)).toBe(1500);
    expect(categoryFor(25, 0)).toBe("Classical");
  });
});

describe("matchPreset", () => {
  it("returns the matching preset for a known (min, inc) pair", () => {
    const preset = matchPreset(5, 3);
    expect(preset).not.toBeNull();
    expect(preset?.label).toBe("Blitz 5+3");
  });

  it("returns null for a custom (min, inc) pair not in the preset list", () => {
    expect(matchPreset(7, 4)).toBeNull();
    expect(matchPreset(5, 2)).toBeNull();
  });
});

describe("TIME_CONTROL_PRESETS", () => {
  it("has every preset's label match its category", () => {
    for (const preset of TIME_CONTROL_PRESETS) {
      const category = categoryFor(preset.clockLimitMinutes, preset.clockIncrementSeconds);
      expect(preset.label.startsWith(category)).toBe(true);
    }
  });

  it("has unique (min, inc) pairs so matchPreset is deterministic", () => {
    const seen = new Set<string>();
    for (const preset of TIME_CONTROL_PRESETS) {
      const key = `${preset.clockLimitMinutes}+${preset.clockIncrementSeconds}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
