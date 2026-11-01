import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import type { ReplicadMesh } from './types';

/**
 * Build an indexed Three.js geometry directly from the worker's mesh. Replicad
 * already emits the Three-friendly layout (flat vertices, triangle indices,
 * per-vertex normals), so no STL re-parsing is needed.
 */
export function replicadMeshToGeometry(mesh: ReplicadMesh): BufferGeometry {
  if (mesh.vertices.length === 0) {
    throw new Error('Mesh has no vertices');
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(mesh.vertices, 3));
  if (mesh.normals && mesh.normals.length === mesh.vertices.length) {
    geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3));
  }
  if (mesh.triangles && mesh.triangles.length > 0) {
    geometry.setIndex(new Uint32BufferAttribute(mesh.triangles, 1));
  }
  if (!mesh.normals || mesh.normals.length !== mesh.vertices.length) {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
