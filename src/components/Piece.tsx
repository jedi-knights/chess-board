import { useLayoutEffect, useMemo, useRef, type JSX } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Shape } from "three";
import type { PieceOnSquare } from "../lib/chessRules";
import { useGameStore } from "../state/gameStore";

const WHITE_MATERIAL_COLOR = "#f5f0e6";
const BLACK_MATERIAL_COLOR = "#2b2b2b";
const MOVE_ANIMATION_MS = 220;

interface PieceProps {
  type: PieceOnSquare["type"];
  color: PieceOnSquare["color"];
  position: [number, number];
  square: string;
  /**
   * World [x, z] this piece should slide in from, if it just arrived here
   * via a move. A piece's React key is its current square, so the piece
   * that just moved always mounts fresh (its key changed) -- there is no
   * "previous instance" to animate from prop changes on. This is why the
   * slide is driven entirely at mount time, not by reacting to `position`
   * changing on an already-mounted instance (which, for this component,
   * never actually happens for a piece that moved).
   */
  animateFrom?: [number, number];
}

export function Piece({ type, color, position, square, animateFrom }: PieceProps) {
  const groupRef = useRef<Group>(null);
  const animStartTime = useRef(0);
  const materialColor = color === "w" ? WHITE_MATERIAL_COLOR : BLACK_MATERIAL_COLOR;

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    if (animateFrom) {
      group.position.set(animateFrom[0], 0, animateFrom[1]);
      animStartTime.current = performance.now();
    } else {
      group.position.set(position[0], 0, position[1]);
    }
    // Empty deps is deliberate: mount-time only, see the doc comment above.
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group || !animateFrom) return;
    const t = Math.min(1, (performance.now() - animStartTime.current) / MOVE_ANIMATION_MS);
    group.position.x = animateFrom[0] + (position[0] - animateFrom[0]) * t;
    group.position.z = animateFrom[1] + (position[1] - animateFrom[1]) * t;
  });

  return (
    <group
      ref={groupRef}
      onPointerDown={(e) => {
        e.stopPropagation();
        useGameStore.getState().selectSquare(square);
      }}
    >
      <PieceBody type={type} color={materialColor} />
    </group>
  );
}

/**
 * Each piece is a small stack of primitives shaped to be recognizable by
 * silhouette, not a single primitive standing in for the whole piece
 * (that's what shipped in M1 and looked nothing like real pieces). GLTF
 * models are still a further-out polish item — this is the "actually
 * looks like chess" bar without adding a model-loading pipeline.
 */
function PieceBody({ type, color }: { type: PieceOnSquare["type"]; color: string }): JSX.Element {
  // A fresh element per call site -- reusing one JSX element object across
  // multiple mesh parents confuses react-three-fiber's attach reconciler.
  const mat = () => <meshStandardMaterial color={color} />;

  const base = (
    <mesh position={[0, 0.03, 0]} castShadow>
      <cylinderGeometry args={[0.2, 0.21, 0.06, 20]} />
      {mat()}
    </mesh>
  );

  switch (type) {
    case "p":
      return (
        <>
          {base}
          <mesh position={[0, 0.17, 0]} castShadow>
            <cylinderGeometry args={[0.09, 0.13, 0.22, 16]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.39, 0]} castShadow>
            <sphereGeometry args={[0.11, 16, 16]} />
            {mat()}
          </mesh>
        </>
      );

    case "r":
      return (
        <>
          {base}
          <mesh position={[0, 0.21, 0]} castShadow>
            <cylinderGeometry args={[0.16, 0.19, 0.3, 16]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.4, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.2, 0.08, 16]} />
            {mat()}
          </mesh>
          {Array.from({ length: 6 }, (_, i) => {
            const angle = (i / 6) * Math.PI * 2;
            const r = 0.15;
            return (
              <mesh
                key={i}
                position={[Math.cos(angle) * r, 0.47, Math.sin(angle) * r]}
                castShadow
              >
                <boxGeometry args={[0.07, 0.06, 0.07]} />
                {mat()}
              </mesh>
            );
          })}
        </>
      );

    case "n":
      return (
        <>
          {base}
          <mesh position={[0, 0.13, 0]} castShadow>
            <cylinderGeometry args={[0.12, 0.16, 0.14, 16]} />
            {mat()}
          </mesh>
          <KnightHead color={color} />
        </>
      );

    case "b":
      // Taller and much more slender than the pawn, topped with a sharp
      // mitre point (not a round head) -- both height and top shape read
      // as distinct from the pawn's short, round-headed silhouette.
      return (
        <>
          {base}
          <mesh position={[0, 0.27, 0]} castShadow>
            <coneGeometry args={[0.13, 0.42, 16]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.5, 0]} castShadow>
            <sphereGeometry args={[0.075, 16, 16]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.62, 0]} castShadow>
            <coneGeometry args={[0.035, 0.16, 12]} />
            {mat()}
          </mesh>
        </>
      );

    case "q":
      return (
        <>
          {base}
          <mesh position={[0, 0.24, 0]} castShadow>
            <cylinderGeometry args={[0.11, 0.17, 0.36, 16]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.48, 0]} castShadow>
            <sphereGeometry args={[0.13, 16, 16]} />
            {mat()}
          </mesh>
          {Array.from({ length: 5 }, (_, i) => {
            const angle = (i / 5) * Math.PI * 2;
            const r = 0.1;
            return (
              <mesh
                key={i}
                position={[Math.cos(angle) * r, 0.58, Math.sin(angle) * r]}
                castShadow
              >
                <coneGeometry args={[0.03, 0.1, 8]} />
                {mat()}
              </mesh>
            );
          })}
        </>
      );

    case "k":
      return (
        <>
          {base}
          <mesh position={[0, 0.24, 0]} castShadow>
            <cylinderGeometry args={[0.12, 0.18, 0.36, 16]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.46, 0]} castShadow>
            <sphereGeometry args={[0.1, 16, 16]} />
            {mat()}
          </mesh>
          {/* Cross topper -- the classic king/queen disambiguator. */}
          <mesh position={[0, 0.58, 0]} castShadow>
            <boxGeometry args={[0.05, 0.14, 0.05]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.6, 0]} castShadow>
            <boxGeometry args={[0.13, 0.05, 0.05]} />
            {mat()}
          </mesh>
        </>
      );
  }
}

/**
 * An actual horse-head profile (arched neck, poll, ear, forehead, nose,
 * mouth, jaw, throat), extruded to a thin slab -- not two rotated boxes.
 * A dedicated component so `useMemo` runs unconditionally per React's
 * rules of hooks (PieceBody's switch can't call it directly in one case).
 */
function KnightHead({ color }: { color: string }) {
  const shape = useMemo(() => {
    const s = new Shape();
    s.moveTo(-0.05, 0.0); // back of neck, base
    s.lineTo(-0.08, 0.12); // neck back, arching up
    s.quadraticCurveTo(-0.05, 0.22, 0.0, 0.25); // poll forming
    s.lineTo(0.02, 0.29); // toward ear base
    s.lineTo(0.03, 0.36); // ear tip
    s.lineTo(0.06, 0.3); // down the front of the ear
    s.quadraticCurveTo(0.09, 0.27, 0.14, 0.24); // forehead slope
    s.lineTo(0.2, 0.2); // nose bridge
    s.lineTo(0.25, 0.14); // nose tip
    s.lineTo(0.22, 0.1); // under the nose
    s.lineTo(0.18, 0.07); // chin
    s.quadraticCurveTo(0.12, 0.04, 0.06, 0.01); // jaw back to throat
    s.lineTo(-0.02, -0.02); // throat front
    s.closePath();
    return s;
  }, []);

  return (
    <mesh position={[0, 0.18, -0.045]} castShadow>
      <extrudeGeometry args={[shape, { depth: 0.09, bevelEnabled: false }]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
