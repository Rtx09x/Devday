export type ShapeVisibility = Record<string, boolean>;

export function isShapeVisible(visibility: ShapeVisibility, shapeName: string): boolean {
  return visibility[shapeName] !== false;
}

export function reconcileShapeVisibility(
  current: ShapeVisibility,
  shapeNames: string[]
): ShapeVisibility {
  const next: ShapeVisibility = {};
  for (const shapeName of shapeNames) {
    next[shapeName] = current[shapeName] ?? true;
  }
  const currentNames = Object.keys(current);
  if (
    currentNames.length === shapeNames.length &&
    shapeNames.every((shapeName) => current[shapeName] === next[shapeName])
  ) {
    return current;
  }
  return next;
}

export function toggleShapeVisibility(
  current: ShapeVisibility,
  shapeName: string
): ShapeVisibility {
  return { ...current, [shapeName]: !isShapeVisible(current, shapeName) };
}

export function soloShapeVisibility(
  current: ShapeVisibility,
  shapeNames: string[],
  shapeName: string
): ShapeVisibility {
  const isOnlyVisible = shapeNames.every((candidate) =>
    candidate === shapeName
      ? isShapeVisible(current, candidate)
      : !isShapeVisible(current, candidate)
  );
  return Object.fromEntries(
    shapeNames.map((candidate) => [candidate, isOnlyVisible || candidate === shapeName])
  );
}
