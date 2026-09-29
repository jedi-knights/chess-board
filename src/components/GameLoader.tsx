import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parsePgn, parseUciMoves } from "../lib/chessRules";
import { useGameStore } from "../state/gameStore";

// Heuristic: PGN games carry move numbers ("1. e4" / "1.e4") or tag pairs
// ("[Event ...]"); a bare UCI move list ("e2e4 e7e5 ...") has neither.
const LOOKS_LIKE_PGN = /^\s*(\[|\d+\.)/;

function loadFromText(source: string): ReturnType<typeof parsePgn> {
  return LOOKS_LIKE_PGN.test(source) ? parsePgn(source) : parseUciMoves(source);
}

export function GameLoader() {
  const [text, setText] = useState("");
  const loadGame = useGameStore((s) => s.loadGame);
  const loadError = useGameStore((s) => s.loadError);
  const setLoadError = useGameStore((s) => s.setLoadError);

  function load(source: string) {
    try {
      loadGame(loadFromText(source));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openFile() {
    const path = await open({
      multiple: false,
      filters: [{ name: "PGN", extensions: ["pgn", "txt"] }],
    });
    if (!path || Array.isArray(path)) return;
    const contents = await readTextFile(path);
    setText(contents);
    load(contents);
  }

  return (
    <div className="game-loader">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a PGN, or a UCI move list like 'e2e4 e7e5 g1f3 ...'"
        rows={6}
      />
      <div className="game-loader-actions">
        <button onClick={() => load(text)} disabled={!text.trim()}>
          Load
        </button>
        <button onClick={openFile}>Open PGN file…</button>
      </div>
      {loadError && <p className="load-error">{loadError}</p>}
    </div>
  );
}
