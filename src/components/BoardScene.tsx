import { useLayoutEffect, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { fenToPieces } from "../lib/chessRules";
import { squareName, squareToPosition } from "../lib/boardGeometry";
import { getBoardPalette, type BoardPalette } from "../lib/boardPalettes";
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
          <meshStandardMaterial color={isLight ? palette.light : palette.dark} />
        </mesh>,
      );
    }
  }
  return <>{squares}</>;
}

/**
 * Points the default camera at the board center on mount / camera-mode
 * change, and orients it so the human's own side renders at the bottom of
 * the view. In 2D mode the camera looks straight down (-Y), which is a
 * near-degenerate case for `lookAt`'s default up-vector disambiguation --
 * an explicit horizontal `up` is what actually decides which rank ends up
 * at the bottom of the screen, not the camera's position.
 */
function LookAtBoardCenter({
  cameraMode,
  humanColor,
}: {
  cameraMode: CameraMode;
  humanColor: "w" | "b";
}) {
  const { camera } = useThree();
  useLayoutEffect(() => {
    if (cameraMode === "2d") {
      camera.up.set(0, 0, humanColor === "w" ? 1 : -1);
    } else {
      camera.up.set(0, 1, 0);
    }
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, cameraMode, humanColor]);
  return null;
}

interface BoardSceneProps {
  fen: string;
  cameraMode: CameraMode;
  theme: ResolvedTheme;
}

export function BoardScene({ fen, cameraMode, theme }: BoardSceneProps) {
  const pieces = fenToPieces(fen);
  const humanColor = useGameStore((s) => s.humanColor);
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
  // Position the camera on the human's own side so their pieces render
  // closer to them, matching the 2D up-vector flip below.
  const cameraPosition: [number, number, number] =
    cameraMode === "2d" ? [0, 10, 0.001] : humanColor === "w" ? [0, 6, -7] : [0, 6, 7];

  return (
    <Canvas
      key={`${cameraMode}-${humanColor}`}
      shadows
      orthographic={cameraMode === "2d"}
      camera={
        cameraMode === "2d"
          ? { position: cameraPosition, zoom: 60, near: 0.1, far: 100 }
          : { position: cameraPosition, fov: 45 }
      }
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[SCENE_BACKGROUND[theme]]} />
      <ambientLight intensity={theme === "dark" ? 0.45 : 0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1} castShadow />
      <LookAtBoardCenter cameraMode={cameraMode} humanColor={humanColor} />
      {cameraMode === "3d" && <OrbitControls target={[0, 0, 0]} />}
      <BoardSquares palette={palette} />
      <MoveHighlights />
      {pieces.map((piece) => (
        <Piece
          key={piece.square}
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
