import { squareToPosition } from "../lib/boardGeometry";
import { useGameStore } from "../state/gameStore";

function HighlightSquare({ square, color }: { square: string; color: string }) {
  const [x, z] = squareToPosition(square);
  return (
    // y sits just above the board plane (0) and below every piece's lowest
    // point (>=0.16), so the highlight never z-fights with either.
    <mesh position={[x, 0.011, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[0.9, 0.9]} />
      <meshBasicMaterial color={color} transparent opacity={0.45} depthWrite={false} />
    </mesh>
  );
}

/** Renders the selected square and its legal destination squares during play mode. */
export function MoveHighlights() {
  const selectedSquare = useGameStore((s) => s.selectedSquare);
  const legalDestinationSquares = useGameStore((s) => s.legalDestinationSquares);

  return (
    <>
      {selectedSquare && <HighlightSquare square={selectedSquare} color="#4d8dff" />}
      {legalDestinationSquares.map((square) => (
        <HighlightSquare key={square} square={square} color="#4dff88" />
      ))}
    </>
  );
}
