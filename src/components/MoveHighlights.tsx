import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Mesh, MeshBasicMaterial } from "three";
import { checkStatus } from "../lib/chessRules";
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

/** A pulsing ring around the checked king -- redder and faster when it's checkmate. */
function CheckRing({ square, checkmate }: { square: string; checkmate: boolean }) {
  const [x, z] = squareToPosition(square);
  const meshRef = useRef<Mesh>(null);
  const color = checkmate ? "#ff2d2d" : "#ff9500";
  const pulseSpeed = checkmate ? 6 : 3.5;

  useFrame(({ clock }) => {
    const material = meshRef.current?.material as MeshBasicMaterial | undefined;
    if (!material) return;
    material.opacity = 0.5 + 0.4 * Math.sin(clock.elapsedTime * pulseSpeed);
  });

  return (
    <mesh ref={meshRef} position={[x, 0.02, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.3, 0.42, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.8} depthWrite={false} />
    </mesh>
  );
}

interface MoveHighlightsProps {
  fen: string;
}

/** Renders the selected square, its legal destinations, and a check/checkmate ring. */
export function MoveHighlights({ fen }: MoveHighlightsProps) {
  const selectedSquare = useGameStore((s) => s.selectedSquare);
  const legalDestinationSquares = useGameStore((s) => s.legalDestinationSquares);
  const check = checkStatus(fen);

  return (
    <>
      {selectedSquare && <HighlightSquare square={selectedSquare} color="#4d8dff" />}
      {legalDestinationSquares.map((square) => (
        <HighlightSquare key={square} square={square} color="#4dff88" />
      ))}
      {check.inCheck && check.kingSquare && (
        <CheckRing square={check.kingSquare} checkmate={check.checkmate} />
      )}
    </>
  );
}
