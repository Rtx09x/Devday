import * as THREE from 'three';
import type { ReplicadMesh } from './types';

export type SectionAxis = 'x' | 'y' | 'z';

export interface ModelSectionPlane {
  axis: SectionAxis;
  offsetMm?: number;
  flip?: boolean;
}

export interface ResolvedModelSectionPlane {
  axis: SectionAxis;
  offsetMm: number;
  flip: boolean;
}

export interface AxisRange {
  min: number;
  max: number;
}

export type ModelAxisRanges = Record<SectionAxis, AxisRange>;

const AXIS_INDEX: Record<SectionAxis, number> = { x: 0, y: 1, z: 2 };
const MODEL_TO_WORLD = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

export function modelAxisRanges(meshes: ReplicadMesh[]): ModelAxisRanges {
  const ranges: ModelAxisRanges = {
    x: { min: Infinity, max: -Infinity },
    y: { min: Infinity, max: -Infinity },
    z: { min: Infinity, max: -Infinity },
  };

  for (const mesh of meshes) {
    for (let offset = 0; offset + 2 < mesh.vertices.length; offset += 3) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const value = mesh.vertices[offset + AXIS_INDEX[axis]];
        if (!Number.isFinite(value)) continue;
        ranges[axis].min = Math.min(ranges[axis].min, value);
        ranges[axis].max = Math.max(ranges[axis].max, value);
      }
    }
  }

  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(ranges[axis].min) || !Number.isFinite(ranges[axis].max)) {
      ranges[axis] = { min: 0, max: 0 };
    }
  }
  return ranges;
}

export function resolveModelSectionPlane(
  section: ModelSectionPlane,
  meshes: ReplicadMesh[]
): ResolvedModelSectionPlane {
  const range = modelAxisRanges(meshes)[section.axis];
  return {
    axis: section.axis,
    offsetMm: section.offsetMm ?? (range.min + range.max) / 2,
    flip: section.flip ?? false,
  };
}

/**
 * Convert a model-space Z-up section plane into the Three.js Y-up world used
 * by both preview renderers. Three clips the plane's negative half-space, so an
 * unflipped plane keeps model coordinates at or above offsetMm.
 */
export function createWorldSectionPlane(section: ResolvedModelSectionPlane): THREE.Plane {
  const direction = section.flip ? -1 : 1;
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  normal.setComponent(AXIS_INDEX[section.axis], direction);
  point.setComponent(AXIS_INDEX[section.axis], section.offsetMm);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point).applyMatrix4(MODEL_TO_WORLD);
}
