// Minimal column-major 4x4 matrix math, worker-safe (no THREE dependency).
// Used to compose a model's animation TransformOps into per-frame matrices the
// viewer can load directly via THREE.Matrix4.fromArray (which is column-major).
import type { Transform, TransformOp } from '../types';

export type Mat4 = number[]; // length 16, column-major

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// Column-major multiply: returns a * b (apply b first, then a).
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function rotationXYZ(rxDeg: number, ryDeg: number, rzDeg: number): Mat4 {
  const d2r = Math.PI / 180;
  const rx = rxDeg * d2r;
  const ry = ryDeg * d2r;
  const rz = rzDeg * d2r;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // R = Rz * Ry * Rx (apply X, then Y, then Z), column-major.
  const m = identity();
  const r00 = cy * cz;
  const r01 = -cy * sz;
  const r02 = sy;
  const r10 = sx * sy * cz + cx * sz;
  const r11 = -sx * sy * sz + cx * cz;
  const r12 = -sx * cy;
  const r20 = -cx * sy * cz + sx * sz;
  const r21 = cx * sy * sz + sx * cz;
  const r22 = cx * cy;
  m[0] = r00; m[1] = r10; m[2] = r20;
  m[4] = r01; m[5] = r11; m[6] = r21;
  m[8] = r02; m[9] = r12; m[10] = r22;
  return m;
}

function opToMatrix(op: TransformOp): Mat4 {
  const [px, py, pz] = op.pivot ?? [0, 0, 0];
  const [tx, ty, tz] = op.position ?? [0, 0, 0];
  const [rx, ry, rz] = op.rotation ?? [0, 0, 0];
  const s = op.scale ?? 1;
  const [sx, sy, sz] = typeof s === 'number' ? [s, s, s] : s;

  // T(position) * T(pivot) * R * S * T(-pivot)
  let m = translation(tx, ty, tz);
  m = multiply(m, translation(px, py, pz));
  m = multiply(m, rotationXYZ(rx, ry, rz));
  m = multiply(m, scaling(sx, sy, sz));
  m = multiply(m, translation(-px, -py, -pz));
  return m;
}

/** Compose a Transform (single op or ordered list) into one matrix. */
export function transformToMatrix(transform: Transform): Mat4 {
  if (Array.isArray(transform)) {
    // Array order = application order: later ops wrap earlier ones.
    let m = identity();
    for (const op of transform) {
      m = multiply(opToMatrix(op), m);
    }
    return m;
  }
  return opToMatrix(transform);
}
