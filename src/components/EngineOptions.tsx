import { useState } from "react";
import type { UciOption } from "../lib/uci";
import { engineStoreForSide, type Side } from "../state/engineStore";

function OptionControl({ side, option }: { side: Side; option: UciOption }) {
  const store = engineStoreForSide(side);
  const value = store((s) => s.optionValues[option.name] ?? option.default ?? "");
  const setOption = store((s) => s.setOption);
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
 */
export function EngineOptions({ side }: { side: Side }) {
  const options = engineStoreForSide(side)((s) => s.options);

  if (options.length === 0) {
    return null;
  }

  return (
    <div className="engine-options">
      <h2>Engine options ({side === "w" ? "White" : "Black"})</h2>
      {options.map((option) => (
        <label key={option.name} className="engine-field">
          {option.optionType === "button" ? null : option.name}
          <OptionControl side={side} option={option} />
        </label>
      ))}
    </div>
  );
}
