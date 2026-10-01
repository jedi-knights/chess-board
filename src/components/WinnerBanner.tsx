import { deriveEngineIdentifier } from "../lib/engineIdentifier";
import { fenAtPly, gameStatus, sideToMove } from "../lib/chessRules";
import { useBlackEngineStore, useWhiteEngineStore } from "../state/engineStore";
import { useGameStore, type Controller, type Controllers } from "../state/gameStore";
import { useLichessBotStore } from "../state/lichessBotStore";
import { useLichessStore } from "../state/lichessStore";

type Side = "w" | "b";

interface SideNames {
  w: string;
  b: string;
}

function nameForSide(
  side: Side,
  controllers: Controllers,
  whiteEngine: { engineName: string | null; path: string | null },
  blackEngine: { engineName: string | null; path: string | null },
  lichessPlayers: { white: { name: string } | null; black: { name: string } | null } | null,
  botPlayers: { white: { name: string } | null; black: { name: string } | null } | null,
): string {
  const ctrl: Controller = controllers[side];
  if (ctrl === "human") return "Human";
  if (ctrl === "engine") {
    const es = side === "w" ? whiteEngine : blackEngine;
    if (es.engineName) return es.engineName;
    if (es.path) return deriveEngineIdentifier(es.path);
    return "Engine";
  }
  // ctrl === "lichess": only one of lichessStore / lichessBotStore is active
  // at a time (menu lock -- see CLAUDE.md's live-session menu lock), so
  // reading both and taking the first match is safe.
  const key = side === "w" ? "white" : "black";
  return lichessPlayers?.[key]?.name ?? botPlayers?.[key]?.name ?? "Lichess";
}

/**
 * Small horizontal banner above the board that announces the outcome once
 * a game ends. Hides itself when:
 *   - no game has been played yet (plies.length === 0), or
 *   - the game is still in progress at the live end position, or
 *   - the user has scrubbed back during replay (ply < plies.length) --
 *     the banner reflects the live result, not a historical position.
 */
export function WinnerBanner() {
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const startFen = useGameStore((s) => s.startFen);
  const rules = useGameStore((s) => s.rules);
  const controllers = useGameStore((s) => s.controllers);
  // Selected as individual primitives, not a single object-literal selector
  // -- a selector returning a fresh object every call defeats zustand's
  // snapshot equality check and causes an infinite re-render loop (seen
  // live: "Maximum update depth exceeded" on every mount).
  const whiteEngineName = useWhiteEngineStore((s) => s.engineName);
  const whiteEnginePath = useWhiteEngineStore((s) => s.path);
  const blackEngineName = useBlackEngineStore((s) => s.engineName);
  const blackEnginePath = useBlackEngineStore((s) => s.path);
  const whiteEngine = { engineName: whiteEngineName, path: whiteEnginePath };
  const blackEngine = { engineName: blackEngineName, path: blackEnginePath };
  const lichessPlayers = useLichessStore((s) => s.players);
  const botPlayers = useLichessBotStore((s) => s.players);

  if (plies.length === 0) return null;
  if (ply !== plies.length) return null;

  const endFen = fenAtPly(plies, plies.length, startFen ?? undefined);
  const status = gameStatus(endFen, rules);
  if (!status.over) return null;

  const names: SideNames = {
    w: nameForSide("w", controllers, whiteEngine, blackEngine, lichessPlayers, botPlayers),
    b: nameForSide("b", controllers, whiteEngine, blackEngine, lichessPlayers, botPlayers),
  };

  let message: string;
  if (status.reason === "checkmate") {
    // The side TO MOVE at the final fen is the one in checkmate -- the
    // other side delivered the mate.
    const winner = sideToMove(endFen) === "w" ? "b" : "w";
    message = `${names[winner]} wins by checkmate`;
  } else if (status.reason === "variantEnd") {
    // Variant-specific terminal: the side NOT to move just delivered
    // the winning condition (KotH king-on-center, 3check 3rd check,
    // ...) and the mover's ply flipped side_to_move. Winner = NOT the
    // side to move at the final FEN.
    const winner = sideToMove(endFen) === "w" ? "b" : "w";
    const label = rules === "koth" ? "King of the Hill" :
                  rules === "3check" ? "three-check" :
                  "variant end";
    message = `${names[winner]} wins by ${label}`;
  } else if (status.reason === "stalemate") {
    message = `Draw by stalemate — ${names.w} vs ${names.b}`;
  } else {
    message = `Draw — ${names.w} vs ${names.b}`;
  }

  return (
    <div className="winner-banner" role="status" aria-live="polite">
      {message}
    </div>
  );
}
