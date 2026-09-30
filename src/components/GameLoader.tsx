import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parsePgn, parseUciMoves } from "../lib/chessRules";
import {
  useBlackEngineStore,
  useWhiteEngineStore,
  type EngineStatus,
} from "../state/engineStore";
import { useGameStore } from "../state/gameStore";
import { useLichessBotStore, type LichessBotStatus } from "../state/lichessBotStore";
import { useLichessStore, type LichessStatus } from "../state/lichessStore";

// Heuristic: PGN games carry move numbers ("1. e4" / "1.e4") or tag pairs
// ("[Event ...]"); a bare UCI move list ("e2e4 e7e5 ...") has neither.
const LOOKS_LIKE_PGN = /^\s*(\[|\d+\.)/;

// "Live" statuses. Loading a game while any of these are active would
// desync movesToApply (a Lichess stream would then keep appending on top
// of a freshly-loaded historical PGN's plies) or overwrite a game the
// engine is still committed to -- see CLAUDE.md's design decisions on
// startNewGame ordering.
const LIVE_ENGINE: Set<EngineStatus> = new Set(["starting", "ready", "thinking"]);
const LIVE_LICHESS: Set<LichessStatus> = new Set(["connecting", "connected"]);
const LIVE_LICHESS_BOT: Set<LichessBotStatus> = new Set(["listening", "playing"]);

function loadFromText(source: string): ReturnType<typeof parsePgn> {
  return LOOKS_LIKE_PGN.test(source) ? parsePgn(source) : parseUciMoves(source);
}

export function GameLoader() {
  const [text, setText] = useState("");
  const [lichessInput, setLichessInput] = useState("");
  const [lichessLoading, setLichessLoading] = useState(false);
  const loadGame = useGameStore((s) => s.loadGame);
  const loadError = useGameStore((s) => s.loadError);
  const setLoadError = useGameStore((s) => s.setLoadError);

  const wStatus = useWhiteEngineStore((s) => s.status);
  const bStatus = useBlackEngineStore((s) => s.status);
  const lichessStatus = useLichessStore((s) => s.status);
  const lichessBotStatus = useLichessBotStore((s) => s.status);
  const anyLive =
    LIVE_ENGINE.has(wStatus) ||
    LIVE_ENGINE.has(bStatus) ||
    LIVE_LICHESS.has(lichessStatus) ||
    LIVE_LICHESS_BOT.has(lichessBotStatus);

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

  async function loadFromLichess() {
    setLichessLoading(true);
    try {
      const pgn = await invoke<string>("lichess_export_pgn", {
        gameIdOrUrl: lichessInput,
      });
      setText(pgn);
      load(pgn);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLichessLoading(false);
    }
  }

  return (
    <div className="game-loader">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a PGN, or a UCI move list like 'e2e4 e7e5 g1f3 ...'"
        rows={6}
        disabled={anyLive}
      />
      <div className="game-loader-actions">
        <button onClick={() => load(text)} disabled={anyLive || !text.trim()}>
          Load
        </button>
        <button onClick={openFile} disabled={anyLive}>
          Open PGN file…
        </button>
      </div>
      <div className="game-loader-lichess">
        <input
          type="text"
          value={lichessInput}
          onChange={(e) => setLichessInput(e.target.value)}
          placeholder="Lichess game id or URL, e.g. https://lichess.org/abcd1234"
          disabled={anyLive}
        />
        <button
          onClick={loadFromLichess}
          disabled={anyLive || !lichessInput.trim() || lichessLoading}
        >
          {lichessLoading ? "Loading…" : "Load from Lichess"}
        </button>
      </div>
      {anyLive && (
        <p className="hint">Stop the running session before loading a different game.</p>
      )}
      {loadError && <p className="load-error">{loadError}</p>}
    </div>
  );
}
