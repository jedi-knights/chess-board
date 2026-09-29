import { useLayoutEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { fenToPieces } from "../lib/chessRules";
import { squareToPosition } from "../lib/boardGeometry";
import { Piece } from "./Piece";
import type { CameraMode } from "../state/gameStore";
import type { ResolvedTheme } from "../state/themeStore";

const LIGHT_SQUARE = "#EDD6B0";
const DARK_SQUARE = "#8B5A2B";
const SCENE_BACKGROUND: Record<ResolvedTheme, string> = {
  light: "#dfe3e8",
  dark: "#15171c",
};

function BoardSquares() {
  const squares = [];
  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const isLight = (file + rank) % 2 === 1;
      squares.push(
        <mesh
          key={`${file}-${rank}`}
          position={[file - 3.5, 0, rank - 3.5]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial color={isLight ? LIGHT_SQUARE : DARK_SQUARE} />
        </mesh>,
      );
    }
  }
  return <>{squares}</>;
}

/** Points the default camera at the board center on mount / camera-mode change. */
function LookAtBoardCenter() {
  const { camera } = useThree();
  useLayoutEffect(() => {
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

interface BoardSceneProps {
  fen: string;
  cameraMode: CameraMode;
  theme: ResolvedTheme;
}

export function BoardScene({ fen, cameraMode, theme }: BoardSceneProps) {
  const pieces = fenToPieces(fen);

  return (
    <Canvas
      key={cameraMode}
      shadows
      orthographic={cameraMode === "2d"}
      camera={
        cameraMode === "2d"
          ? { position: [0, 10, 0.001], zoom: 60, near: 0.1, far: 100 }
          : { position: [0, 6, 7], fov: 45 }
      }
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[SCENE_BACKGROUND[theme]]} />
      <ambientLight intensity={theme === "dark" ? 0.45 : 0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1} castShadow />
      <LookAtBoardCenter />
      {cameraMode === "3d" && <OrbitControls target={[0, 0, 0]} />}
      <BoardSquares />
      {pieces.map((piece) => (
        <Piece
          key={piece.square}
          type={piece.type}
          color={piece.color}
          position={squareToPosition(piece.square)}
        />
      ))}
    </Canvas>
  );
}
