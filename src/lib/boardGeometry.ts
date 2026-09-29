/** Maps an algebraic square (e.g. "e4") to [x, z] world coordinates, centered on the board. */
export function squareToPosition(square: string): [number, number] {
  const file = square.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(square[1]) - 1;
  return [file - 3.5, rank - 3.5];
}

/** Inverse of squareToPosition's indexing: 0-indexed file/rank -> "e4"-style algebraic square. */
export function squareName(file: number, rank: number): string {
  return `${String.fromCharCode("a".charCodeAt(0) + file)}${rank + 1}`;
}
