import type { ModelStats, PrintabilityReport } from './types';

export interface PrintabilityOptions {
  /** Overhang angle (from vertical) past which a surface is "unsupported". */
  overhangThresholdDeg?: number;
  /** Printer bed footprint [x, y] in mm. */
  bedMm?: [number, number] | null;
  /** Nozzle diameter in mm (drives the recommended minimum wall). */
  nozzleMm?: number | null;
  /** Recommended minimum wall as a multiple of the nozzle. */
  minWallNozzleMultiple?: number;
}

interface MergedMesh {
  vertices: number[];
  triangles: number[];
  normals?: number[];
}

const DEFAULT_OVERHANG_THRESHOLD = 45;
const DEFAULT_MIN_WALL_MULTIPLE = 2;
const WALL_SAMPLE_LIMIT = 2048;
const WALL_ANALYSIS_BUDGET_MS = 50;
const GRID_MAX_AXIS_CELLS = 32;
const GRID_TARGET_TRIANGLES_PER_CELL = 8;

interface WallTriangle {
  vertexIndices: [number, number, number];
  normal: [number, number, number];
  centroid: [number, number, number];
  area: number;
}

interface ThicknessSample {
  thicknessMm: number;
  position: [number, number, number];
}

interface WallAnalysis {
  samples: ThicknessSample[];
  timedOut: boolean;
}

interface RayCastResult {
  distance: number | null;
  timedOut: boolean;
}

interface TriangleGrid {
  min: [number, number, number];
  max: [number, number, number];
  dimensions: [number, number, number];
  cellSize: [number, number, number];
  cells: Map<number, number[]>;
}

function triangleNormalAndArea(
  vertices: number[],
  ia: number,
  ib: number,
  ic: number
): { nx: number; ny: number; nz: number; area: number; centroidZ: number } {
  const ax = vertices[ia * 3];
  const ay = vertices[ia * 3 + 1];
  const az = vertices[ia * 3 + 2];
  const bx = vertices[ib * 3];
  const by = vertices[ib * 3 + 1];
  const bz = vertices[ib * 3 + 2];
  const cx = vertices[ic * 3];
  const cy = vertices[ic * 3 + 1];
  const cz = vertices[ic * 3 + 2];

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  const length = Math.hypot(crossX, crossY, crossZ);
  const area = 0.5 * length;
  const inv = length > 1e-12 ? 1 / length : 0;
  return {
    nx: crossX * inv,
    ny: crossY * inv,
    nz: crossZ * inv,
    area,
    centroidZ: (az + bz + cz) / 3,
  };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gridCellKey(x: number, y: number, z: number, dimensions: [number, number, number]): number {
  return x + dimensions[0] * (y + dimensions[1] * z);
}

function buildTriangleGrid(
  vertices: number[],
  wallTriangles: WallTriangle[],
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
  deadlineMs: number
): { grid: TriangleGrid | null; timedOut: boolean } {
  const extent: [number, number, number] = [
    boundsMax[0] - boundsMin[0],
    boundsMax[1] - boundsMin[1],
    boundsMax[2] - boundsMin[2],
  ];
  const maxExtent = Math.max(...extent);
  if (!Number.isFinite(maxExtent) || maxExtent <= 1e-9) return { grid: null, timedOut: false };

  const targetCellCount = Math.max(1, wallTriangles.length / GRID_TARGET_TRIANGLES_PER_CELL);
  const volume = Math.max(extent[0] * extent[1] * extent[2], 1e-18);
  const idealCellSize = Math.cbrt(volume / targetCellCount);
  const dimensions: [number, number, number] = [0, 1, 2].map((axis) =>
    clamp(Math.ceil(extent[axis] / Math.max(idealCellSize, maxExtent / GRID_MAX_AXIS_CELLS)), 1, GRID_MAX_AXIS_CELLS)
  ) as [number, number, number];
  const cellSize: [number, number, number] = [0, 1, 2].map((axis) =>
    extent[axis] > 1e-12 ? extent[axis] / dimensions[axis] : 1
  ) as [number, number, number];
  const cells = new Map<number, number[]>();
  let insertionCount = 0;

  for (let triangleIndex = 0; triangleIndex < wallTriangles.length; triangleIndex += 1) {
    const triangle = wallTriangles[triangleIndex];
    const triMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const triMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const vertexIndex of triangle.vertexIndices) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = vertices[vertexIndex * 3 + axis];
        triMin[axis] = Math.min(triMin[axis], value);
        triMax[axis] = Math.max(triMax[axis], value);
      }
    }
    const cellMin: [number, number, number] = [0, 1, 2].map((axis) =>
      clamp(Math.floor((triMin[axis] - boundsMin[axis]) / cellSize[axis]), 0, dimensions[axis] - 1)
    ) as [number, number, number];
    const cellMax: [number, number, number] = [0, 1, 2].map((axis) =>
      clamp(Math.floor((triMax[axis] - boundsMin[axis]) / cellSize[axis]), 0, dimensions[axis] - 1)
    ) as [number, number, number];

    for (let z = cellMin[2]; z <= cellMax[2]; z += 1) {
      for (let y = cellMin[1]; y <= cellMax[1]; y += 1) {
        for (let x = cellMin[0]; x <= cellMax[0]; x += 1) {
          const key = gridCellKey(x, y, z, dimensions);
          const entries = cells.get(key);
          if (entries) entries.push(triangleIndex);
          else cells.set(key, [triangleIndex]);
          insertionCount += 1;
          if ((insertionCount & 255) === 0 && nowMs() >= deadlineMs) {
            return { grid: null, timedOut: true };
          }
        }
      }
    }
  }

  return {
    grid: { min: boundsMin, max: boundsMax, dimensions, cellSize, cells },
    timedOut: false,
  };
}

function rayTriangleDistance(
  origin: [number, number, number],
  direction: [number, number, number],
  vertices: number[],
  triangle: WallTriangle,
  epsilon: number
): number | null {
  const [ia, ib, ic] = triangle.vertexIndices;
  const ax = vertices[ia * 3];
  const ay = vertices[ia * 3 + 1];
  const az = vertices[ia * 3 + 2];
  const abx = vertices[ib * 3] - ax;
  const aby = vertices[ib * 3 + 1] - ay;
  const abz = vertices[ib * 3 + 2] - az;
  const acx = vertices[ic * 3] - ax;
  const acy = vertices[ic * 3 + 1] - ay;
  const acz = vertices[ic * 3 + 2] - az;

  const px = direction[1] * acz - direction[2] * acy;
  const py = direction[2] * acx - direction[0] * acz;
  const pz = direction[0] * acy - direction[1] * acx;
  const determinant = abx * px + aby * py + abz * pz;
  if (Math.abs(determinant) <= 1e-12) return null;
  const inverseDeterminant = 1 / determinant;
  const tx = origin[0] - ax;
  const ty = origin[1] - ay;
  const tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inverseDeterminant;
  if (u < -1e-9 || u > 1 + 1e-9) return null;

  const qx = ty * abz - tz * aby;
  const qy = tz * abx - tx * abz;
  const qz = tx * aby - ty * abx;
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverseDeterminant;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const distance = (acx * qx + acy * qy + acz * qz) * inverseDeterminant;
  return distance > epsilon ? distance : null;
}

function rayBoxInterval(
  origin: [number, number, number],
  direction: [number, number, number],
  min: [number, number, number],
  max: [number, number, number]
): [number, number] | null {
  let entry = 0;
  let exit = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]) <= 1e-15) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    const inverse = 1 / direction[axis];
    let t0 = (min[axis] - origin[axis]) * inverse;
    let t1 = (max[axis] - origin[axis]) * inverse;
    if (t0 > t1) [t0, t1] = [t1, t0];
    entry = Math.max(entry, t0);
    exit = Math.min(exit, t1);
    if (exit < entry) return null;
  }
  return [entry, exit];
}

function castGridRay(
  sourceTriangleIndex: number,
  origin: [number, number, number],
  direction: [number, number, number],
  vertices: number[],
  wallTriangles: WallTriangle[],
  grid: TriangleGrid,
  epsilon: number,
  deadlineMs: number
): RayCastResult {
  const interval = rayBoxInterval(origin, direction, grid.min, grid.max);
  if (!interval) return { distance: null, timedOut: false };
  const [entry, exit] = interval;
  const startT = Math.min(exit, entry + epsilon);
  const point: [number, number, number] = [
    origin[0] + direction[0] * startT,
    origin[1] + direction[1] * startT,
    origin[2] + direction[2] * startT,
  ];
  const cell: [number, number, number] = [0, 1, 2].map((axis) =>
    clamp(Math.floor((point[axis] - grid.min[axis]) / grid.cellSize[axis]), 0, grid.dimensions[axis] - 1)
  ) as [number, number, number];
  const step: [number, number, number] = [0, 1, 2].map((axis) => Math.sign(direction[axis])) as [number, number, number];
  const tDelta: [number, number, number] = [0, 1, 2].map((axis) =>
    step[axis] === 0 ? Infinity : grid.cellSize[axis] / Math.abs(direction[axis])
  ) as [number, number, number];
  const tMax: [number, number, number] = [0, 1, 2].map((axis) => {
    if (step[axis] === 0) return Infinity;
    const boundary = grid.min[axis] + (cell[axis] + (step[axis] > 0 ? 1 : 0)) * grid.cellSize[axis];
    return (boundary - origin[axis]) / direction[axis];
  }) as [number, number, number];
  const tested = new Set<number>();
  let nearest = Infinity;
  let intersectionChecks = 0;

  while (
    cell[0] >= 0 && cell[0] < grid.dimensions[0] &&
    cell[1] >= 0 && cell[1] < grid.dimensions[1] &&
    cell[2] >= 0 && cell[2] < grid.dimensions[2]
  ) {
    const entries = grid.cells.get(gridCellKey(cell[0], cell[1], cell[2], grid.dimensions));
    if (entries) {
      for (const triangleIndex of entries) {
        if (triangleIndex === sourceTriangleIndex || tested.has(triangleIndex)) continue;
        tested.add(triangleIndex);
        intersectionChecks += 1;
        if ((intersectionChecks & 127) === 0 && nowMs() >= deadlineMs) {
          return { distance: null, timedOut: true };
        }
        const triangle = wallTriangles[triangleIndex];
        const opposingDot =
          triangle.normal[0] * direction[0] +
          triangle.normal[1] * direction[1] +
          triangle.normal[2] * direction[2];
        if (opposingDot <= 1e-6) continue;
        const distance = rayTriangleDistance(origin, direction, vertices, triangle, epsilon);
        if (distance != null && distance < nearest) nearest = distance;
      }
    }

    const nextBoundary = Math.min(tMax[0], tMax[1], tMax[2]);
    if (nearest <= nextBoundary + epsilon) return { distance: nearest, timedOut: false };
    if (nextBoundary > exit) break;
    for (let axis = 0; axis < 3; axis += 1) {
      if (tMax[axis] <= nextBoundary + 1e-12) {
        cell[axis] += step[axis];
        tMax[axis] += tDelta[axis];
      }
    }
  }
  return {
    distance: Number.isFinite(nearest) && nearest <= exit + epsilon ? nearest : null,
    timedOut: false,
  };
}

function selectSampleTriangles(
  wallTriangles: WallTriangle[],
  limit: number,
  deadlineMs: number
): { indices: number[]; timedOut: boolean } {
  if (wallTriangles.length <= limit) {
    return { indices: wallTriangles.map((_, index) => index), timedOut: false };
  }
  let totalArea = 0;
  for (let i = 0; i < wallTriangles.length; i += 1) {
    totalArea += wallTriangles[i].area;
    if ((i & 255) === 0 && nowMs() >= deadlineMs) return { indices: [], timedOut: true };
  }
  const selected = new Set<number>();
  let cumulativeArea = 0;
  let targetIndex = 0;
  for (let triangleIndex = 0; triangleIndex < wallTriangles.length && targetIndex < limit; triangleIndex += 1) {
    cumulativeArea += wallTriangles[triangleIndex].area;
    while (targetIndex < limit && cumulativeArea >= ((targetIndex + 0.5) * totalArea) / limit) {
      selected.add(triangleIndex);
      targetIndex += 1;
    }
    if ((triangleIndex & 255) === 0 && nowMs() >= deadlineMs) {
      return { indices: [], timedOut: true };
    }
  }
  // Very large triangles can cover several area strata. Fill any resulting
  // gaps evenly from the unsampled triangle order without losing determinism.
  if (selected.size < limit) {
    const stride = wallTriangles.length / (limit - selected.size);
    for (let i = 0; i < wallTriangles.length && selected.size < limit; i += 1) {
      selected.add(Math.min(wallTriangles.length - 1, Math.floor((i + 0.5) * stride)));
      if ((i & 255) === 0 && nowMs() >= deadlineMs) {
        return { indices: [], timedOut: true };
      }
    }
  }
  return { indices: [...selected].sort((a, b) => a - b).slice(0, limit), timedOut: false };
}

function analyzeWallThickness(
  vertices: number[],
  triangles: number[],
  boundsMin: [number, number, number],
  boundsMax: [number, number, number]
): WallAnalysis {
  const startMs = nowMs();
  const deadlineMs = startMs + WALL_ANALYSIS_BUDGET_MS;
  const wallTriangles: WallTriangle[] = [];
  let signedVolume = 0;

  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i];
    const ib = triangles[i + 1];
    const ic = triangles[i + 2];
    if (
      !Number.isInteger(ia) || !Number.isInteger(ib) || !Number.isInteger(ic) ||
      ia < 0 || ib < 0 || ic < 0 ||
      ia * 3 + 2 >= vertices.length || ib * 3 + 2 >= vertices.length || ic * 3 + 2 >= vertices.length
    ) continue;
    const normal = triangleNormalAndArea(vertices, ia, ib, ic);
    if (!Number.isFinite(normal.area) || normal.area <= 1e-12) continue;
    const ax = vertices[ia * 3];
    const ay = vertices[ia * 3 + 1];
    const az = vertices[ia * 3 + 2];
    const bx = vertices[ib * 3];
    const by = vertices[ib * 3 + 1];
    const bz = vertices[ib * 3 + 2];
    const cx = vertices[ic * 3];
    const cy = vertices[ic * 3 + 1];
    const cz = vertices[ic * 3 + 2];
    signedVolume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    wallTriangles.push({
      vertexIndices: [ia, ib, ic],
      normal: [normal.nx, normal.ny, normal.nz],
      centroid: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
      area: normal.area,
    });
    if ((wallTriangles.length & 255) === 0 && nowMs() >= deadlineMs) {
      return { samples: [], timedOut: true };
    }
  }
  if (wallTriangles.length === 0) return { samples: [], timedOut: false };
  if (signedVolume < 0) {
    for (const triangle of wallTriangles) {
      triangle.normal = [-triangle.normal[0], -triangle.normal[1], -triangle.normal[2]];
    }
  }

  const gridResult = buildTriangleGrid(vertices, wallTriangles, boundsMin, boundsMax, deadlineMs);
  if (!gridResult.grid) return { samples: [], timedOut: gridResult.timedOut };
  const grid = gridResult.grid;
  const diagonal = Math.hypot(
    boundsMax[0] - boundsMin[0],
    boundsMax[1] - boundsMin[1],
    boundsMax[2] - boundsMin[2]
  );
  const epsilon = Math.max(diagonal * 1e-8, 1e-7);
  const selection = selectSampleTriangles(wallTriangles, WALL_SAMPLE_LIMIT, deadlineMs);
  if (selection.timedOut) return { samples: [], timedOut: true };
  const sampleTriangleIndices = selection.indices;
  const samples: ThicknessSample[] = [];

  for (let sampleIndex = 0; sampleIndex < sampleTriangleIndices.length; sampleIndex += 1) {
    if ((sampleIndex & 15) === 0 && nowMs() >= deadlineMs) {
      return { samples, timedOut: true };
    }
    const triangleIndex = sampleTriangleIndices[sampleIndex];
    const triangle = wallTriangles[triangleIndex];
    const direction: [number, number, number] = [
      -triangle.normal[0],
      -triangle.normal[1],
      -triangle.normal[2],
    ];
    const origin: [number, number, number] = [
      triangle.centroid[0] + direction[0] * epsilon,
      triangle.centroid[1] + direction[1] * epsilon,
      triangle.centroid[2] + direction[2] * epsilon,
    ];
    const ray = castGridRay(triangleIndex, origin, direction, vertices, wallTriangles, grid, epsilon, deadlineMs);
    if (ray.timedOut) return { samples, timedOut: true };
    if (ray.distance != null && Number.isFinite(ray.distance) && ray.distance > epsilon) {
      // The origin is nudged inward only to avoid a self-hit. Restore that tiny
      // offset so the reported distance is measured from the surface centroid.
      samples.push({ thicknessMm: ray.distance + epsilon, position: triangle.centroid });
    }
  }
  return { samples, timedOut: false };
}

function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  const position = clamp(fraction, 0, 1) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Heuristic printability analysis from the tessellated mesh. Z is the build
 * direction (Replicad's vertical axis). Overhang severity is measured per
 * triangle as the angle of its downward-facing surface from a vertical wall:
 * a flat ceiling reads 90 deg (worst), a vertical wall reads 0 deg.
 */
export function analyzePrintability(
  mesh: MergedMesh,
  stats: ModelStats,
  options: PrintabilityOptions = {}
): PrintabilityReport {
  const threshold = options.overhangThresholdDeg ?? DEFAULT_OVERHANG_THRESHOLD;
  const minWallMultiple = options.minWallNozzleMultiple ?? DEFAULT_MIN_WALL_MULTIPLE;
  const bedMm = options.bedMm ?? null;
  const nozzleMm = options.nozzleMm ?? null;

  const { vertices, triangles } = mesh;
  const size = stats.boundingBox.size;
  const minZ = stats.boundingBox.min[2];

  let totalArea = 0;
  let unsupportedArea = 0;
  let worstOverhang = 0;
  let flatBaseArea = 0;
  // Severity buckets: 45-60, 60-75, 75-90 degrees from vertical.
  const buckets = [
    { lo: threshold, hi: 60, area: 0 },
    { lo: 60, hi: 75, area: 0 },
    { lo: 75, hi: 90.01, area: 0 },
  ];

  const baseEps = Math.max(size[2] * 0.01, 0.05);

  for (let i = 0; i < triangles.length; i += 3) {
    const { nz, area, centroidZ } = triangleNormalAndArea(
      vertices,
      triangles[i],
      triangles[i + 1],
      triangles[i + 2]
    );
    if (area <= 0) continue;
    totalArea += area;

    // Downward-facing surfaces only (nz < 0). Angle of the normal from straight
    // down: beta = acos(-nz). Overhang from vertical = 90 - beta. Faces resting
    // on the build plate (at the model floor) are supported, not overhangs.
    if (nz < 0) {
      const onBuildPlate = centroidZ <= minZ + baseEps;
      // Flat base: near-horizontal downward face sitting on the model's floor.
      if (-nz > 0.99 && onBuildPlate) {
        flatBaseArea += area;
      }
      // Overhang: a downward face elevated above the plate is unsupported. Faces
      // resting on the build plate are supported, so they never count.
      if (!onBuildPlate) {
        const beta = Math.acos(Math.min(1, -nz)) * (180 / Math.PI);
        const overhangFromVertical = 90 - beta;
        if (overhangFromVertical > worstOverhang) worstOverhang = overhangFromVertical;
        if (overhangFromVertical > threshold) {
          unsupportedArea += area;
          for (const bucket of buckets) {
            if (overhangFromVertical >= bucket.lo && overhangFromVertical < bucket.hi) {
              bucket.area += area;
              break;
            }
          }
        }
      }
    }
  }

  const safeTotal = totalArea > 0 ? totalArea : 1;
  const footprint = Math.max(size[0] * size[1], 1e-6);

  const findings = buckets
    .filter((bucket) => bucket.area > 0)
    .map((bucket) => ({
      angleFromVerticalDeg: bucket.hi >= 90 ? 90 : bucket.hi,
      areaFraction: bucket.area / safeTotal,
    }));

  const bedFits =
    bedMm == null
      ? null
      : (size[0] <= bedMm[0] && size[1] <= bedMm[1]) || (size[1] <= bedMm[0] && size[0] <= bedMm[1]);

  const flatBaseAreaFraction = flatBaseArea / footprint;
  const hasFlatBase = flatBaseAreaFraction > 0.05;
  const wallAnalysis = analyzeWallThickness(vertices, triangles, stats.boundingBox.min, stats.boundingBox.max);
  const sortedWallSamples = [...wallAnalysis.samples].sort((a, b) => a.thicknessMm - b.thicknessMm);
  const wallValues = sortedWallSamples.map((sample) => sample.thicknessMm);
  const minWallMm = wallValues[0] ?? null;
  const p5WallMm = percentile(wallValues, 0.05);
  const wallThresholdMm = nozzleMm == null ? null : nozzleMm * minWallMultiple;
  const belowThresholdFraction =
    wallThresholdMm == null || wallValues.length === 0
      ? null
      : wallValues.filter((value) => value < wallThresholdMm).length / wallValues.length;
  const worstSpots = sortedWallSamples.slice(0, 5).map((sample) => sample.position);
  const thinWallFailure = wallThresholdMm != null && p5WallMm != null && p5WallMm < wallThresholdMm;

  const notes: string[] = [];
  if (!stats.watertight) {
    notes.push('Mesh is not watertight — slicers may produce gaps or fail. Check for non-manifold geometry or self-intersections.');
  }
  if (worstOverhang > threshold) {
    notes.push(
      `Steepest overhang is ${worstOverhang.toFixed(0)} deg from vertical (threshold ${threshold} deg). Consider supports or reorienting.`
    );
  }
  if (bedFits === false) {
    notes.push(`Footprint ${size[0].toFixed(0)} x ${size[1].toFixed(0)} mm exceeds the bed ${bedMm?.[0]} x ${bedMm?.[1]} mm.`);
  }
  if (!hasFlatBase) {
    notes.push('No substantial flat base detected at the model floor — the part may be unstable or need a brim/raft.');
  }
  if (nozzleMm == null) {
    notes.push('No nozzle diameter configured; minimum-wall guidance is unavailable. Set printerNozzle in .cutucircuits/replicad.yml.');
  }
  if (wallAnalysis.timedOut) {
    notes.push(
      `Wall-thickness analysis reached its ${WALL_ANALYSIS_BUDGET_MS} ms time budget; results use ${wallValues.length} completed sample${wallValues.length === 1 ? '' : 's'}.`
    );
  } else if (wallValues.length === 0) {
    notes.push('Wall thickness could not be estimated from valid opposing-surface samples.');
  }
  if (thinWallFailure && wallThresholdMm != null && p5WallMm != null && minWallMm != null) {
    const spot = worstSpots[0];
    notes.push(
      `Thin wall detected: robust minimum ${p5WallMm.toFixed(2)} mm (thinnest sample ${minWallMm.toFixed(2)} mm at [${spot[0].toFixed(2)}, ${spot[1].toFixed(2)}, ${spot[2].toFixed(2)}] mm) is below the ${wallThresholdMm.toFixed(2)} mm target (${minWallMultiple} x ${nozzleMm?.toFixed(2)} mm nozzle).`
    );
  }

  const ok =
    stats.watertight &&
    worstOverhang <= threshold + 1 &&
    bedFits !== false &&
    hasFlatBase &&
    !thinWallFailure;

  return {
    ok,
    bed: { sizeMm: size, bedMm, fits: bedFits },
    overhang: {
      thresholdDeg: threshold,
      worstAngleDeg: worstOverhang,
      unsupportedAreaFraction: unsupportedArea / safeTotal,
      findings,
    },
    wall: {
      minNozzleMultiple: minWallMultiple,
      estimatedMinWallMm: p5WallMm,
      nozzleMm,
      thinWalls: {
        sampleCount: wallValues.length,
        minMm: minWallMm,
        p5Mm: p5WallMm,
        belowThresholdFraction,
        worstSpots,
      },
    },
    base: { hasFlatBase, flatBaseAreaFraction },
    notes,
  };
}
