import { useEffect, useLayoutEffect, useMemo, useRef, type JSX } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Shape } from "three";
import type { PieceOnSquare } from "../lib/chessRules";
import { createGlyphTexture, getPieceGlyph } from "../lib/pieceGlyphs";
import { getPieceStyle, type PieceStyle } from "../lib/pieceStyles";
import { useGameStore } from "../state/gameStore";
import { usePieceStyleStore } from "../state/pieceStyleStore";

const WHITE_MATERIAL_COLOR = "#f5f0e6";
// Real "black" chess pieces are ebonized/dark-stained wood, not flat
// black paint -- and #2b2b2b was reflecting so little light that pieces
// read as nearly featureless silhouettes even with correct geometry.
// Lightened, paired with BoardScene's new fill light.
const BLACK_MATERIAL_COLOR = "#3a3a3a";
// Real wooden sets glue a colored felt disc to the base's underside --
// a cheap, authentic detail, and reference photos consistently show
// green as the traditional felt color.
const FELT_COLOR = "#1f3d2b";
const MOVE_ANIMATION_MS = 220;

/**
 * Base bottom-radius per piece type, in the same [top, bottom] shape as
 * the cylinderGeometry args below. Real Staunton sets scale base width
 * with a piece's height/importance for stability and visual hierarchy --
 * the king has the widest, most substantial base and the pawn the
 * narrowest (a king's base is typically ~75-80% of a square's width; a
 * pawn's is much less). Previously every piece shared one hardcoded
 * 0.2/0.21 base, which is what made the king/queen/rook look under-based
 * relative to real sets -- this is the fix, not a cosmetic tweak.
 */
const BASE_RADIUS: Record<PieceOnSquare["type"], [top: number, bottom: number]> = {
  p: [0.2, 0.21],
  n: [0.23, 0.24],
  b: [0.23, 0.24],
  r: [0.25, 0.26],
  q: [0.28, 0.29],
  k: [0.29, 0.3],
};

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
  const style = getPieceStyle(usePieceStyleStore((s) => s.style));
  const cameraMode = useGameStore((s) => s.cameraMode);

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
      {cameraMode === "2d" ? (
        <PieceGlyph type={type} color={color} />
      ) : (
        <PieceBody type={type} color={materialColor} style={style} />
      )}
    </group>
  );
}

/**
 * The 2D-mode piece representation: a flat, camera-facing icon instead of
 * the 3D geometry. A top-down photo of a 3D piece is a fundamentally
 * different (and much weaker) representation than the universal 2D chess
 * convention -- every reference image, every icon set, and every real
 * chess UI draws pieces as a colored, outlined side-profile silhouette.
 * From directly above, this app's 3D pieces used to read as nearly
 * identical discs; this reads correctly regardless of viewing angle
 * because it's a flat plane with a texture, not a 3D silhouette.
 */
function PieceGlyph({ type, color }: { type: PieceOnSquare["type"]; color: PieceOnSquare["color"] }) {
  const texture = useMemo(() => {
    const glyph = getPieceGlyph(type);
    const fill = color === "w" ? WHITE_MATERIAL_COLOR : BLACK_MATERIAL_COLOR;
    const stroke = color === "w" ? BLACK_MATERIAL_COLOR : WHITE_MATERIAL_COLOR;
    return createGlyphTexture(glyph, fill, stroke);
  }, [type, color]);

  useEffect(() => {
    return () => texture.dispose();
  }, [texture]);

  return (
    // rotation=[-PI/2,0,0] tips the plane from its default XY orientation
    // (facing +Z) to lie flat in the XZ plane facing +Y -- i.e. straight up
    // at the fixed top-down 2D camera (see BoardScene's cameraPosition for
    // cameraMode "2d"). This must hold for every piece, both colors, both
    // POV settings -- the camera flips its `up` vector between white/black
    // POV, but this plane's world-space rotation never does, and it must
    // not start doing so (e.g. via billboarding). Do not change this
    // rotation without re-verifying every piece still renders face-up, not
    // edge-on or upside-down, in both POV settings.
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <planeGeometry args={[0.75, 0.75]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.05} />
    </mesh>
  );
}

/**
 * Each piece is a small stack of primitives shaped to be recognizable by
 * silhouette, not a single primitive standing in for the whole piece
 * (that's what shipped in M1 and looked nothing like real pieces). GLTF
 * models are still a further-out polish item — this is the "actually
 * looks like chess" bar without adding a model-loading pipeline.
 *
 * Positions/proportions are identical across every `PieceStyle` -- only
 * `style.segments`/`style.baseSegments` (round vs. faceted geometry) vary,
 * per real chess-set design research: classic Staunton sets are smooth
 * and round-turned, modern minimalist sets are deliberately faceted with
 * an octagonal base. Same silhouette, different finish.
 */
function PieceBody({
  type,
  color,
  style,
}: {
  type: PieceOnSquare["type"];
  color: string;
  style: PieceStyle;
}): JSX.Element {
  // A fresh element per call site -- reusing one JSX element object across
  // multiple mesh parents confuses react-three-fiber's attach reconciler.
  const mat = () => <meshStandardMaterial color={color} />;
  const seg = style.segments;
  const [baseTop, baseBottom] = BASE_RADIUS[type];

  const base = (
    <>
      <mesh position={[0, 0.03, 0]} castShadow>
        <cylinderGeometry args={[baseTop, baseBottom, 0.06, style.baseSegments]} />
        {mat()}
      </mesh>
      <mesh position={[0, 0.006, 0]}>
        <cylinderGeometry args={[baseBottom, baseBottom, 0.012, style.baseSegments]} />
        <meshStandardMaterial color={FELT_COLOR} />
      </mesh>
    </>
  );

  switch (type) {
    case "p":
      return (
        <>
          {base}
          <mesh position={[0, 0.17, 0]} castShadow>
            <cylinderGeometry args={[0.09, 0.13, 0.22, seg]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.39, 0]} castShadow>
            <sphereGeometry args={[0.11, seg, seg]} />
            {mat()}
          </mesh>
        </>
      );

    case "r":
      return (
        <>
          {base}
          <mesh position={[0, 0.21, 0]} castShadow>
            <cylinderGeometry args={[0.16, 0.19, 0.3, seg]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.4, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.2, 0.08, seg]} />
            {mat()}
          </mesh>
          {/* Merlons sit right at the rim's own outer radius (0.2) and are
              wide enough that adjacent ones nearly touch -- real Staunton
              crenellations are notches cut into one solid turret rim, not
              separate blocks floating with visible gaps above it. */}
          {Array.from({ length: 8 }, (_, i) => {
            const angle = (i / 8) * Math.PI * 2;
            const r = 0.19;
            return (
              <mesh
                key={i}
                position={[Math.cos(angle) * r, 0.48, Math.sin(angle) * r]}
                castShadow
              >
                <boxGeometry args={[0.1, 0.08, 0.1]} />
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
            <cylinderGeometry args={[0.12, 0.16, 0.14, seg]} />
            {mat()}
          </mesh>
          <KnightHead color={color} segments={seg} />
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
            <coneGeometry args={[0.13, 0.42, seg]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.5, 0]} castShadow>
            <sphereGeometry args={[0.075, seg, seg]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.62, 0]} castShadow>
            <coneGeometry args={[0.035, 0.16, seg]} />
            {mat()}
          </mesh>
        </>
      );

    case "q":
      return (
        <>
          {base}
          <mesh position={[0, 0.24, 0]} castShadow>
            <cylinderGeometry args={[0.11, 0.17, 0.36, seg]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.48, 0]} castShadow>
            <sphereGeometry args={[0.13, seg, seg]} />
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
                <coneGeometry args={[0.03, 0.1, seg]} />
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
            <cylinderGeometry args={[0.12, 0.18, 0.36, seg]} />
            {mat()}
          </mesh>
          <mesh position={[0, 0.46, 0]} castShadow>
            <sphereGeometry args={[0.1, seg, seg]} />
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
 * mouth, jaw, throat), extruded with real depth -- not two rotated boxes,
 * and not a thin flat cutout either. Real carved knight heads have
 * noticeable volume (see reference photos); a thin slab (the original
 * 0.09 depth) reads as a recognizable horse only from a narrow range of
 * viewing angles and looks like a blank blob from others, since a nearly
 * edge-on view of a thin panel loses the silhouette entirely. Depth 0.16
 * roughly matches the neck cylinder's own diameter, so the head reads as
 * a solid form rather than a plane from more of the board's viewing angles.
 * A dedicated component so `useMemo` runs unconditionally per React's
 * rules of hooks (PieceBody's switch can't call it directly in one case).
 * `segments` controls how many facets approximate the shape's curves
 * (`extrudeGeometry`'s `curveSegments`) -- low for the faceted modern
 * style, high for the classic style's smooth profile.
 */
function KnightHead({ color, segments }: { color: string; segments: number }) {
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
    <mesh position={[0, 0.18, -0.08]} castShadow>
      <extrudeGeometry
        args={[shape, { depth: 0.16, bevelEnabled: false, curveSegments: segments }]}
      />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
