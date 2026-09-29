import type { JSX } from "react";
import type { PieceOnSquare } from "../lib/chessRules";
import { useGameStore } from "../state/gameStore";

const WHITE_MATERIAL_COLOR = "#f5f0e6";
const BLACK_MATERIAL_COLOR = "#2b2b2b";

/**
 * Placeholder geometry, distinguishable by shape per piece type. GLTF piece
 * models are a later visual-polish milestone (see plan M4) — not needed to
 * prove move-by-move replay.
 */
function geometryFor(type: PieceOnSquare["type"]): JSX.Element {
  switch (type) {
    case "p":
      return <coneGeometry args={[0.16, 0.35, 12]} />;
    case "n":
      return <boxGeometry args={[0.22, 0.4, 0.32]} />;
    case "b":
      return <octahedronGeometry args={[0.24, 0]} />;
    case "r":
      return <cylinderGeometry args={[0.2, 0.22, 0.32, 12]} />;
    case "q":
      return <cylinderGeometry args={[0.1, 0.26, 0.5, 16]} />;
    case "k":
      return <cylinderGeometry args={[0.12, 0.24, 0.55, 16]} />;
  }
}

const HALF_HEIGHT: Record<PieceOnSquare["type"], number> = {
  p: 0.18,
  n: 0.2,
  b: 0.25,
  r: 0.16,
  q: 0.25,
  k: 0.28,
};

interface PieceProps {
  type: PieceOnSquare["type"];
  color: PieceOnSquare["color"];
  position: [number, number];
  square: string;
}

export function Piece({ type, color, position, square }: PieceProps) {
  const [x, z] = position;
  return (
    <mesh
      position={[x, HALF_HEIGHT[type], z]}
      castShadow
      onPointerDown={(e) => {
        e.stopPropagation();
        useGameStore.getState().selectSquare(square);
      }}
    >
      {geometryFor(type)}
      <meshStandardMaterial
        color={color === "w" ? WHITE_MATERIAL_COLOR : BLACK_MATERIAL_COLOR}
      />
    </mesh>
  );
}
