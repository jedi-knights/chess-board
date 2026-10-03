import { useState } from "react";
import type { UciOption } from "../lib/uci";
import { engineStoreForSide, type EngineStoreHook } from "../state/engineStore";
import { useGameStore } from "../state/gameStore";

function OptionControl({ option, useEngine }: { option: UciOption; useEngine: EngineStoreHook }) {
  const value = useEngine((s) => s.optionValues[option.name] ?? option.default ?? "");
  const setOption = useEngine((s) => s.setOption);
  const [pendingText, setPendingText] = useState(value);

  switch (option.optionType) {
    case "check":
      return (
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => setOption(option.name, e.target.checked ? "true" : "false")}
        />
      );

    case "spin":
      return (
        <input
          type="number"
          min={option.min}
          max={option.max}
          value={value}
          onChange={(e) => setOption(option.name, e.target.value)}
        />
      );

    case "combo":
      return (
        <select value={value} onChange={(e) => setOption(option.name, e.target.value)}>
          {(option.vars ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );

    case "button":
      return <button onClick={() => setOption(option.name)}>{option.name}</button>;

    case "string":
      // Commit on blur, not per-keystroke -- a string option is often a
      // file path, and sending `setoption` on every character would spam
      // the engine's stdin with mostly-invalid intermediate paths.
      return (
        <input
          type="text"
          value={pendingText}
          onChange={(e) => setPendingText(e.target.value)}
          onBlur={() => setOption(option.name, pendingText)}
        />
      );
  }
}

/**
 * Renders one control per UCI option the connected engine advertised
 * after `uci` (e.g. chess-engine's `UseNNUE` checkbox, `EvalFile` path) --
 * these were previously invisible; every option line was silently ignored.
 *
 * When `side` is passed explicitly, the controller-based gate is bypassed --
 * used by the "Preview engine options" affordance in bot mode, where no
 * side has `controllers[side] === "engine"` yet but the operator still
 * wants to see the engine's option list before accepting a challenge.
 */
export function EngineOptions({ side }: { side?: "w" | "b" } = {}) {
  // Only meaningful when some side is engine-controlled. In human-vs-Lichess
  // and other engine-free modes, a fall-through default here rendered the
  // *stopped* black engine's stale options; setOption on that store then
  // called failEngine -> exitPlayMode, silently killing the live Lichess
  // game. No engine controller -> nothing to render.
  const controllers = useGameStore((s) => s.controllers);
  const resolvedSide: "w" | "b" | null =
    side ?? (controllers.w === "engine" ? "w" : controllers.b === "engine" ? "b" : null);
  // Hooks must be called unconditionally, so use whichever side (default "w"
  // when neither is engine); the null check below discards the result.
  const useEngine = engineStoreForSide(resolvedSide ?? "w");
  const options = useEngine((s) => s.options);

  if (resolvedSide === null || options.length === 0) {
    return null;
  }

  return (
    <div className="engine-options">
      <h2>Engine options</h2>
      {options.map((option) => (
        <label key={option.name} className="engine-field">
          {option.optionType === "button" ? null : option.name}
          <OptionControl option={option} useEngine={useEngine} />
        </label>
      ))}
    </div>
  );
}
