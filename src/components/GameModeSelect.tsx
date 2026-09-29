import { useGameModeStore, type GameModePreset } from "../state/gameModeStore";

const MODES: { value: GameModePreset; label: string }[] = [
  { value: "human-vs-engine", label: "Human vs Engine" },
  { value: "human-vs-lichess", label: "Human vs Lichess" },
  { value: "engine-vs-lichess", label: "Engine vs Lichess (Bot API)" },
  { value: "engine-vs-engine", label: "Engine vs Engine" },
];

/** Picks exactly one of the 4 game-mode panels to show. Disabled while a
 * game is actually in progress -- switching away mid-game would hide the
 * panel controlling whatever's running (an engine process, a Lichess
 * connection) with no way to see its status or stop it. */
export function GameModeSelect({ disabled }: { disabled: boolean }) {
  const preset = useGameModeStore((s) => s.preset);
  const setPreset = useGameModeStore((s) => s.setPreset);

  return (
    <div className="game-mode-select" role="radiogroup" aria-label="Game mode">
      {MODES.map((m) => (
        <label key={m.value} className="game-mode-option">
          <input
            type="radio"
            name="game-mode"
            value={m.value}
            checked={preset === m.value}
            disabled={disabled}
            onChange={() => setPreset(m.value)}
          />
          {m.label}
        </label>
      ))}
    </div>
  );
}
