import * as THREE from 'three';
import { replicadMeshToGeometry } from './previewGeometry';
import {
  createWorldSectionPlane,
  resolveModelSectionPlane,
} from './sectionPlane';
import type { ModelSectionPlane } from './sectionPlane';
import type { ReplicadMesh, ViewName } from './types';

// Geometry is baked into Three's Y-up world (model Z-up rotated by -90 deg X).
// View directions are in that rotated world space.
const VIEW_DIRECTIONS: Record<ViewName, [number, number, number]> = {
  iso: [1, 1, 1],
  top: [0, 1, 0],
  front: [0, 0, 1],
  right: [1, 0, 0],
};

export interface RenderViewsOptions {
  size?: number;
  background?: string;
  meshColor?: string;
  views?: ViewName[];
  section?: ModelSectionPlane;
}

/**
 * Render a set of fixed camera angles of the given meshes to PNG data URLs.
 * Used by inspect_model to give the agent actual images of geometry it cannot
 * otherwise see. Runs in the renderer (DOM/WebGL available); the caller is
 * responsible for not invoking this in a non-DOM context.
 */
export function renderMeshViews(
  meshes: ReplicadMesh[],
  options: RenderViewsOptions = {}
): Partial<Record<ViewName, string>> {
  const size = options.size ?? 768;
  const views = options.views ?? (['iso', 'top', 'front', 'right'] as ViewName[]);
  const background = options.background ?? '#f3f4f6';
  const meshColor = options.meshColor ?? '#3b82f6';

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);

  // Replicad/OCCT is Z-up; bake the rotation into Three's Y-up world per geometry
  // so bounding boxes are already in world space (no group-matrix lag).
  const built: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const boundingBox = new THREE.Box3();
  const clippingPlanes = options.section
    ? [createWorldSectionPlane(resolveModelSectionPlane(options.section, meshes))]
    : [];

  for (const mesh of meshes) {
    if (!mesh.vertices.length) continue;
    const geometry = replicadMeshToGeometry(mesh);
    geometry.rotateX(-Math.PI / 2);
    built.push(geometry);
    const material = new THREE.MeshStandardMaterial({
      color: meshColor,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide,
      clippingPlanes,
    });
    materials.push(material);
    const object = new THREE.Mesh(geometry, material);
    object.frustumCulled = false;
    scene.add(object);
    geometry.computeBoundingBox();
    if (geometry.boundingBox) boundingBox.union(geometry.boundingBox);
  }

  scene.add(new THREE.AmbientLight('#ffffff', 0.8));
  const keyLight = new THREE.DirectionalLight('#ffffff', 1.1);
  keyLight.position.set(1, 2, 1.5);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight('#9bb5ff', 0.4);
  fillLight.position.set(-1.5, -1, -1.5);
  scene.add(fillLight);

  const center = new THREE.Vector3();
  boundingBox.getCenter(center);
  const sphere = new THREE.Sphere();
  boundingBox.getBoundingSphere(sphere);
  const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 50;

  const camera = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 40);
  const distance = radius * 3;

  const results: Partial<Record<ViewName, string>> = {};
  try {
    for (const view of views) {
      const dir = VIEW_DIRECTIONS[view];
      const direction = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.up.set(0, 1, 0);
      if (view === 'top') camera.up.set(0, 0, -1);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      results[view] = renderer.domElement.toDataURL('image/png');
    }
  } finally {
    for (const geometry of built) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return results;
}

async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  return new Promise((resolveImage, rejectImage) => {
    const img = new Image();
    img.onload = () => resolveImage(img);
    img.onerror = () => rejectImage(new Error('Failed to decode view image'));
    img.src = dataUrl;
  });
}

/**
 * Render the model as a single labeled 2x2 montage (iso / top / front / right).
 * Returns one PNG data URL — bounded in size so it can ride along in an AI tool
 * result without flooding the agent's context with four separate images.
 */
export async function renderMeshMontage(
  meshes: ReplicadMesh[],
  options: RenderViewsOptions = {}
): Promise<string | null> {
  const cell = options.size ?? 320;
  const order: ViewName[] = ['iso', 'top', 'front', 'right'];
  const views = renderMeshViews(meshes, { ...options, size: cell, views: order });

  const canvas = document.createElement('canvas');
  canvas.width = cell * 2;
  canvas.height = cell * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return views.iso ?? null;

  ctx.fillStyle = options.background ?? '#f3f4f6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const positions: Record<ViewName, [number, number]> = {
    iso: [0, 0],
    top: [cell, 0],
    front: [0, cell],
    right: [cell, cell],
  };

  for (const view of order) {
    const dataUrl = views[view];
    if (!dataUrl) continue;
    const [x, y] = positions[view];
    try {
      const bitmap = await dataUrlToBitmap(dataUrl);
      ctx.drawImage(bitmap as CanvasImageSource, x, y, cell, cell);
      if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
        (bitmap as ImageBitmap).close();
      }
    } catch {
      // Skip a view that failed to decode.
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x + 4, y + 4, 56, 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.fillText(view.toUpperCase(), x + 10, y + 17);
  }

  return canvas.toDataURL('image/png');
}
