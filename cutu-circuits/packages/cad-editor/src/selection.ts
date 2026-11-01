import type {
  BoundingBox,
  ReplicadFaceGroup,
  ReplicadFaceSelection,
  ReplicadMesh,
  ReplicadSelection,
  ShapeResult,
} from './types';

type Vec3 = [number, number, number];

function emptyBounds(): { min: Vec3; max: Vec3 } {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
}

function includePoint(bounds: { min: Vec3; max: Vec3 }, point: Vec3): void {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function finishBounds(bounds: { min: Vec3; max: Vec3 }): BoundingBox {
  if (!Number.isFinite(bounds.min[0])) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }
  return {
    min: [...bounds.min],
    max: [...bounds.max],
    size: [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ],
  };
}

function vertexAt(mesh: ReplicadMesh, index: number): Vec3 | null {
  const offset = index * 3;
  if (offset < 0 || offset + 2 >= mesh.vertices.length) return null;
  return [mesh.vertices[offset], mesh.vertices[offset + 1], mesh.vertices[offset + 2]];
}

export function meshBoundingBox(mesh: ReplicadMesh): BoundingBox {
  const bounds = emptyBounds();
  for (let offset = 0; offset + 2 < mesh.vertices.length; offset += 3) {
    includePoint(bounds, [mesh.vertices[offset], mesh.vertices[offset + 1], mesh.vertices[offset + 2]]);
  }
  return finishBounds(bounds);
}

export function faceGroupForTriangle(
  mesh: ReplicadMesh,
  triangleIndex: number | null
): ReplicadFaceGroup | null {
  if (triangleIndex == null || triangleIndex < 0) return null;
  const triangleOffset = triangleIndex * 3;
  return (
    mesh.faceGroups?.find(
      (group) => triangleOffset >= group.start && triangleOffset < group.start + group.count
    ) ?? null
  );
}

function faceSelection(mesh: ReplicadMesh, group: ReplicadFaceGroup): ReplicadFaceSelection {
  const bounds = emptyBounds();
  const normalSum: Vec3 = [0, 0, 0];
  let areaMm2 = 0;
  let triangleCount = 0;
  const end = Math.min(group.start + group.count, mesh.triangles.length);

  for (let offset = group.start; offset + 2 < end; offset += 3) {
    const a = vertexAt(mesh, mesh.triangles[offset]);
    const b = vertexAt(mesh, mesh.triangles[offset + 1]);
    const c = vertexAt(mesh, mesh.triangles[offset + 2]);
    if (!a || !b || !c) continue;
    includePoint(bounds, a);
    includePoint(bounds, b);
    includePoint(bounds, c);

    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross: Vec3 = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const twiceArea = Math.hypot(cross[0], cross[1], cross[2]);
    areaMm2 += twiceArea / 2;
    normalSum[0] += cross[0];
    normalSum[1] += cross[1];
    normalSum[2] += cross[2];
    triangleCount += 1;
  }

  const normalLength = Math.hypot(normalSum[0], normalSum[1], normalSum[2]);
  const normal: Vec3 = normalLength > 1e-12
    ? [normalSum[0] / normalLength, normalSum[1] / normalLength, normalSum[2] / normalLength]
    : [0, 0, 0];

  return {
    id: group.faceId,
    areaMm2,
    normal,
    boundingBox: finishBounds(bounds),
    triangleCount,
    surfaceType: group.surfaceType,
    radiusMm: group.radiusMm,
  };
}

export function buildReplicadSelection(
  modelFilePath: string,
  shape: ShapeResult,
  triangleIndex: number | null,
  clickPoint: Vec3
): ReplicadSelection {
  const group = faceGroupForTriangle(shape.mesh, triangleIndex);
  return {
    modelFilePath,
    units: 'mm',
    coordinateSystem: 'model-z-up',
    shapeName: shape.name,
    shapeBoundingBox: meshBoundingBox(shape.mesh),
    clickPoint,
    face: group ? faceSelection(shape.mesh, group) : null,
  };
}

function number(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : 'unknown';
}

function boundedText(value: unknown, limit: number): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 14))}… [truncated]`;
}

function vector(value: Vec3): string {
  return `[${value.map(number).join(', ')}]`;
}

function bounds(value: BoundingBox): string {
  return `min ${vector(value.min)}, max ${vector(value.max)}, dimensions ${vector(value.size)} mm`;
}

export function selectionContextLabel(selection: ReplicadSelection): string {
  const shapeName = boundedText(selection.shapeName, 160);
  return selection.face
    ? `Selection: ${shapeName} / face ${selection.face.id}`
    : `Selection: ${shapeName}`;
}

export function selectionContextDescription(selection: ReplicadSelection): string {
  const modelFilePath = boundedText(selection.modelFilePath, 600);
  const shapeName = boundedText(selection.shapeName, 200);
  const parts = [
    `Selected geometry in model file "${modelFilePath}".`,
    `Shape "${shapeName}" has bounding box ${bounds(selection.shapeBoundingBox)} in model Z-up coordinates.`,
  ];
  if (selection.face) {
    const face = selection.face;
    const surface = face.surfaceType
      ? ` Its surface is ${face.surfaceType}${face.radiusMm !== undefined ? ` with radius ${number(face.radiusMm)} mm` : ''}.`
      : '';
    parts.push(
      `B-rep face ${face.id} has tessellated area ${number(face.areaMm2)} mm^2, area-weighted average normal ${vector(face.normal)}, and bounding box ${bounds(face.boundingBox)} in model Z-up coordinates.${surface}`
    );
  }
  parts.push(`The click point is ${vector(selection.clickPoint)} mm in model Z-up coordinates.`);
  return parts.join(' ');
}

export interface ReplicadSelectionContextItem {
  id: string;
  label: string;
  description: string;
  icon: string;
  groupLabel: string;
  data: ReplicadSelection;
  includeData: true;
}

/** Convert one live geometry selection into a removable, model-facing context chip. */
export function selectionContextItem(selection: ReplicadSelection): ReplicadSelectionContextItem {
  const safeSelection: ReplicadSelection = {
    ...selection,
    modelFilePath: boundedText(selection.modelFilePath, 600),
    shapeName: boundedText(selection.shapeName, 200),
  };
  return {
    id: safeSelection.face
      ? `shape:${safeSelection.shapeName}:face:${safeSelection.face.id}`
      : `shape:${safeSelection.shapeName}`,
    label: safeSelection.face
      ? `${safeSelection.shapeName} / face ${safeSelection.face.id}`
      : safeSelection.shapeName,
    description: selectionContextDescription(safeSelection),
    icon: safeSelection.face ? 'view_in_ar' : 'deployed_code',
    groupLabel: 'geometry',
    data: safeSelection,
    includeData: true,
  };
}

/**
 * Re-resolve a selected shape/face against a newly compiled result.
 * A missing shape or B-rep face clears the selection instead of publishing
 * measurements from an older compile.
 */
export function refreshReplicadSelection(
  selection: ReplicadSelection | null,
  shapes: ShapeResult[]
): ReplicadSelection | null {
  if (!selection) return null;
  const shape = shapes.find((candidate) => candidate.name === selection.shapeName);
  if (!shape) return null;
  if (!selection.face) {
    return buildReplicadSelection(selection.modelFilePath, shape, null, selection.clickPoint);
  }
  const faceGroup = shape.mesh.faceGroups?.find((group) => group.faceId === selection.face?.id);
  if (!faceGroup) return null;
  return buildReplicadSelection(
    selection.modelFilePath,
    shape,
    Math.floor(faceGroup.start / 3),
    selection.clickPoint
  );
}
