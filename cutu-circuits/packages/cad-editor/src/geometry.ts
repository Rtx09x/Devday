import type { BoundingBox, ModelStats, ReplicadMesh } from './types';

const EMPTY_BOX: BoundingBox = { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };

function boundingBoxFromVertices(vertices: number[]): BoundingBox {
  if (vertices.length === 0) return EMPTY_BOX;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertices[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/**
 * Edge-manifold check: in a closed surface every undirected edge is shared by
 * exactly two triangles. We tolerate degenerate/duplicate vertices by hashing on
 * rounded position, which is what OCCT tessellation emits at face seams.
 */
function isWatertight(vertices: number[], triangles: number[]): boolean {
  if (triangles.length === 0) return false;
  const keyForVertex = (index: number): string => {
    const x = Math.round(vertices[index * 3] * 1e4);
    const y = Math.round(vertices[index * 3 + 1] * 1e4);
    const z = Math.round(vertices[index * 3 + 2] * 1e4);
    return `${x},${y},${z}`;
  };
  const ids = new Map<string, number>();
  const idFor = (index: number): number => {
    const key = keyForVertex(index);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const edgeCounts = new Map<string, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    const a = idFor(triangles[i]);
    const b = idFor(triangles[i + 1]);
    const c = idFor(triangles[i + 2]);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      if (p === q) return false; // degenerate edge
      const key = p < q ? `${p}:${q}` : `${q}:${p}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  for (const count of edgeCounts.values()) {
    if (count !== 2) return false;
  }
  return true;
}

/**
 * Mesh-derived volume/area, used as a fallback when the kernel measurements are
 * unavailable. Volume is the signed-tetrahedron sum (correct for closed meshes);
 * area is the triangle-area sum.
 */
export function meshDerivedVolumeAndArea(
  vertices: number[],
  triangles: number[]
): { volume: number; surfaceArea: number } {
  let signedVolume = 0;
  let surfaceArea = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i] * 3;
    const ib = triangles[i + 1] * 3;
    const ic = triangles[i + 2] * 3;
    const ax = vertices[ia];
    const ay = vertices[ia + 1];
    const az = vertices[ia + 2];
    const bx = vertices[ib];
    const by = vertices[ib + 1];
    const bz = vertices[ib + 2];
    const cx = vertices[ic];
    const cy = vertices[ic + 1];
    const cz = vertices[ic + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;

    surfaceArea += 0.5 * Math.hypot(crossX, crossY, crossZ);
    signedVolume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { volume: Math.abs(signedVolume), surfaceArea };
}

export function meshToStats(
  mesh: Pick<ReplicadMesh, 'vertices' | 'triangles'>,
  kernel?: { volume?: number; surfaceArea?: number }
): ModelStats {
  const { vertices, triangles } = mesh;
  const derived = meshDerivedVolumeAndArea(vertices, triangles);
  return {
    triangleCount: Math.floor(triangles.length / 3),
    volume: kernel?.volume ?? derived.volume,
    surfaceArea: kernel?.surfaceArea ?? derived.surfaceArea,
    boundingBox: boundingBoxFromVertices(vertices),
    watertight: isWatertight(vertices, triangles),
  };
}

/** Merge several shape meshes into a single vertex/triangle buffer (re-indexed). */
export function mergeMeshes(meshes: Array<Pick<ReplicadMesh, 'vertices' | 'triangles'>>): {
  vertices: number[];
  triangles: number[];
} {
  const vertices: number[] = [];
  const triangles: number[] = [];
  let offset = 0;
  for (const mesh of meshes) {
    vertices.push(...mesh.vertices);
    for (const index of mesh.triangles) triangles.push(index + offset);
    offset += mesh.vertices.length / 3;
  }
  return { vertices, triangles };
}
