import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { OrthographicCamera } from "three";
import { fenToPieces } from "../lib/chessRules";
import { squareName, squareToPosition } from "../lib/boardGeometry";
import { getBoardPalette, type BoardPalette } from "../lib/boardPalettes";
import {
  BORDER_WIDTH,
  createFileStripTexture,
  createRankStripTexture,
} from "../lib/boardCoordinates";
import { createWoodTexture } from "../lib/woodTexture";
import { Piece } from "./Piece";
import { MoveHighlights } from "./MoveHighlights";
import { useBoardThemeStore } from "../state/boardThemeStore";
import { useGameStore, type CameraMode } from "../state/gameStore";
import type { ResolvedTheme } from "../state/themeStore";

const SCENE_BACKGROUND: Record<ResolvedTheme, string> = {
  light: "#dfe3e8",
  dark: "#15171c",
};

function BoardSquares({ palette }: { palette: BoardPalette }) {
  // One texture per color, shared across all 32 squares of that color --
  // not one per square. Regenerated only when the palette's own colors
  // change, and disposed on the way out so switching palettes repeatedly
  // doesn't leak GPU texture memory.
  const lightTexture = useMemo(() => createWoodTexture(palette.light), [palette.light]);
  const darkTexture = useMemo(() => createWoodTexture(palette.dark), [palette.dark]);
  useEffect(() => {
    return () => {
      lightTexture.dispose();
      darkTexture.dispose();
    };
  }, [lightTexture, darkTexture]);

  const squares = [];
  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const isLight = (file + rank) % 2 === 1;
      const square = squareName(file, rank);
      squares.push(
        <mesh
          key={square}
          position={[file - 3.5, 0, rank - 3.5]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
          onPointerDown={(e) => {
            e.stopPropagation();
            useGameStore.getState().selectSquare(square);
          }}
        >
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial map={isLight ? lightTexture : darkTexture} roughness={0.75} />
        </mesh>,
      );
    }
  }
  return <>{squares}</>;
}

// The board's outer edge sits at world ±4 (see boardGeometry.ts's ±3.5
// square centers plus half a square) -- 8 world units per side. The
// labeled border adds BORDER_WIDTH on each side; a small extra margin
// keeps the outermost labels from pressing against the canvas edge.
const BOARD_VIEW_UNITS = 8 + BORDER_WIDTH * 2 + 0.4;

/** Full extent per side including the border. */
const BOARD_HALF_EXTENT = 4 + BORDER_WIDTH;
/** Border strip center offset from board center. */
const BORDER_CENTER = 4 + BORDER_WIDTH / 2;

/**
 * Opaque frame around the 8x8 playing area with coordinate labels baked
 * into canvas textures. Also owns the solid base plate under the whole
 * board -- without it, the squares' planes are back-face-culled when the
 * OrbitControls camera rotates below the board plane and you see straight
 * through to the scene background. The base plate's underside is what the
 * camera sees from below instead, matching a physical chess board's wood
 * backing.
 */
function BoardBorder({ palette, pov }: { palette: BoardPalette; pov: "w" | "b" }) {
  const fileTexture = useMemo(
    () => createFileStripTexture(palette.frame, palette.frameText, pov === "b"),
    [palette.frame, palette.frameText, pov],
  );
  const rankTexture = useMemo(
    () => createRankStripTexture(palette.frame, palette.frameText, pov === "b"),
    [palette.frame, palette.frameText, pov],
  );
  useEffect(() => {
    return () => {
      fileTexture.dispose();
      rankTexture.dispose();
    };
  }, [fileTexture, rankTexture]);

  const BASE_THICKNESS = 0.08;
  // Board squares sit at y=0; base top must sit strictly BELOW that or the
  // two surfaces z-fight (the "board flickers during replay" symptom), so
  // the box top lands at y=-BASE_TOP_INSET. Labels then sit strictly ABOVE
  // the base top at y=LABEL_Y so they're not clipped by it either; both
  // gaps need to be big enough to survive the perspective camera's depth
  // precision at the far end of its clip range, not just technically
  // nonzero.
  const BASE_TOP_INSET = 0.01;
  const LABEL_Y = 0.004;
  const baseSize = BOARD_HALF_EXTENT * 2;

  return (
    <>
      <mesh
        position={[0, -BASE_TOP_INSET - BASE_THICKNESS / 2, 0]}
        receiveShadow
        castShadow
      >
        <boxGeometry args={[baseSize, BASE_THICKNESS, baseSize]} />
        <meshStandardMaterial color={palette.frame} roughness={0.8} />
      </mesh>
      <mesh position={[0, LABEL_Y, -BORDER_CENTER]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[8, BORDER_WIDTH]} />
        <meshBasicMaterial map={fileTexture} />
      </mesh>
      <mesh position={[0, LABEL_Y, BORDER_CENTER]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[8, BORDER_WIDTH]} />
        <meshBasicMaterial map={fileTexture} />
      </mesh>
      <mesh position={[-BORDER_CENTER, LABEL_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BORDER_WIDTH, 8]} />
        <meshBasicMaterial map={rankTexture} />
      </mesh>
      <mesh position={[BORDER_CENTER, LABEL_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BORDER_WIDTH, 8]} />
        <meshBasicMaterial map={rankTexture} />
      </mesh>
    </>
  );
}

/**
 * Points the default camera at the board center on mount / camera-mode
 * change, and orients it so `pov`'s side renders at the bottom of the
 * view. In 2D mode the camera looks straight down (-Y), which is a
 * near-degenerate case for `lookAt`'s default up-vector disambiguation --
 * an explicit horizontal `up` is what actually decides which rank ends up
 * at the bottom of the screen, not the camera's position.
 *
 * Also keeps the 2D orthographic camera's `zoom` fitted to the *current*
 * canvas size rather than a fixed constant. r3f's default orthographic
 * frustum is sized directly in canvas pixels (1 world unit = 1 pixel at
 * zoom 1), so a fixed zoom tuned for one window size leaves an
 * ever-larger unused background margin as the window (and therefore the
 * canvas) grows -- this recomputes zoom on every canvas resize so the
 * board always fills the smaller of the canvas's two dimensions.
 */
function LookAtBoardCenter({
  cameraMode,
  pov,
}: {
  cameraMode: CameraMode;
  pov: "w" | "b";
}) {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    if (cameraMode === "2d") {
      camera.up.set(0, 0, pov === "w" ? 1 : -1);
      if (camera instanceof OrthographicCamera) {
        camera.zoom = Math.min(size.width, size.height) / BOARD_VIEW_UNITS;
      }
    } else {
      camera.up.set(0, 1, 0);
    }
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, cameraMode, pov, size]);
  return null;
}

interface BoardSceneProps {
  fen: string;
  cameraMode: CameraMode;
  theme: ResolvedTheme;
}

export function BoardScene({ fen, cameraMode, theme }: BoardSceneProps) {
  const pieces = fenToPieces(fen);
  const pov = useGameStore((s) => s.pov);
  const plies = useGameStore((s) => s.plies);
  const ply = useGameStore((s) => s.ply);
  const palette = getBoardPalette(useBoardThemeStore((s) => s.palette));

  // Animate exactly one square's worth of movement: a single step forward
  // (human/engine move, autoplay tick, or the ">" button) or backward (the
  // "<" button). Any bigger jump (|<, >|, clicking a distant move, loading
  // a new game) snaps instantly instead -- diffing an arbitrary jump into
  // "which piece moved where" isn't well-defined the way a single ply is.
  const prevPlyRef = useRef(ply);
  let animatedToSquare: string | null = null;
  let animateFromPosition: [number, number] | null = null;
  if (ply === prevPlyRef.current + 1 && ply <= plies.length) {
    const moved = plies[ply - 1];
    animatedToSquare = moved.uci.slice(2, 4);
    animateFromPosition = squareToPosition(moved.uci.slice(0, 2));
  } else if (ply === prevPlyRef.current - 1 && ply < plies.length) {
    const moved = plies[ply];
    animatedToSquare = moved.uci.slice(0, 2);
    animateFromPosition = squareToPosition(moved.uci.slice(2, 4));
  }
  useLayoutEffect(() => {
    prevPlyRef.current = ply;
  }, [ply]);

  // White's home ranks sit at world -Z, Black's at +Z (see boardGeometry.ts).
  // Position the camera on pov's side so that side's pieces render closer
  // to the viewer, matching the 2D up-vector flip below.
  const cameraPosition: [number, number, number] =
    cameraMode === "2d" ? [0, 10, 0.001] : pov === "w" ? [0, 6, -7] : [0, 6, 7];

  return (
    <Canvas
      key={`${cameraMode}-${pov}`}
      shadows
      orthographic={cameraMode === "2d"}
      camera={
        cameraMode === "2d"
          // zoom here is just an initial value -- LookAtBoardCenter
          // overrides it on the very next layout effect, fitted to the
          // actual canvas size, before first paint.
          ? { position: cameraPosition, zoom: 60, near: 0.1, far: 100 }
          : { position: cameraPosition, fov: 45 }
      }
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[SCENE_BACKGROUND[theme]]} />
      <ambientLight intensity={theme === "dark" ? 0.45 : 0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1} castShadow />
      {/* Fill light from the opposite side, no shadow -- with only the
          key light above, the side of a piece facing away from it gets
          ambient light alone, which reads as a nearly featureless flat
          silhouette on the dark piece material. A soft fill is the
          standard fix for revealing shape on dark materials without
          washing out the key light's contrast on the light pieces. */}
      <directionalLight position={[-6, 6, -4]} intensity={0.35} />
      <LookAtBoardCenter cameraMode={cameraMode} pov={pov} />
      {cameraMode === "3d" && <OrbitControls target={[0, 0, 0]} />}
      <BoardBorder palette={palette} pov={pov} />
      <BoardSquares palette={palette} />
      <MoveHighlights fen={fen} />
      {pieces.map((piece) => (
        // Key includes type+color so a square whose contents change
        // identity (capture, promotion, or a big ply jump landing on a
        // different piece than was at that square before) forces a fresh
        // Piece mount rather than reusing a stale instance -- Piece.tsx's
        // useLayoutEffect runs at mount only, so a reused instance would
        // keep its old animation-driven position even though its props
        // now describe a different piece.
        <Piece
          key={`${piece.square}-${piece.type}-${piece.color}`}
          type={piece.type}
          color={piece.color}
          position={squareToPosition(piece.square)}
          square={piece.square}
          animateFrom={piece.square === animatedToSquare ? animateFromPosition ?? undefined : undefined}
        />
      ))}
    </Canvas>
  );
}
