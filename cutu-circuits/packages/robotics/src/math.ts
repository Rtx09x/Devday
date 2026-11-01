import type { Quat, Transform, Vec3 } from "./types.js";
export const identity = (): Transform => ({
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
});
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const mul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const inverse = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const rotate = (q: Quat, v: Vec3): Vec3 => {
  const r = mul(mul(q, [...v, 0]), inverse(q));
  return [r[0], r[1], r[2]];
};
export const compose = (a: Transform, b: Transform): Transform => ({
  position: add(a.position, rotate(a.quaternion, b.position)),
  quaternion: mul(a.quaternion, b.quaternion),
});
export function rpy([r, p, y]: Vec3): Quat {
  const a = r / 2,
    b = p / 2,
    c = y / 2;
  return [
    Math.sin(a) * Math.cos(b) * Math.cos(c) -
      Math.cos(a) * Math.sin(b) * Math.sin(c),
    Math.cos(a) * Math.sin(b) * Math.cos(c) +
      Math.sin(a) * Math.cos(b) * Math.sin(c),
    Math.cos(a) * Math.cos(b) * Math.sin(c) -
      Math.sin(a) * Math.sin(b) * Math.cos(c),
    Math.cos(a) * Math.cos(b) * Math.cos(c) +
      Math.sin(a) * Math.sin(b) * Math.sin(c),
  ];
}
/** Jacobi eigensolver: symmetric URDF tensor -> positive principal moments and principal frame. */
export function principalInertia([xx, xy, xz, yy, yz, zz]: number[]): {
  moments: Vec3;
  quaternion: Quat;
} {
  const a = [
      [xx, xy, xz],
      [xy, yy, yz],
      [xz, yz, zz],
    ],
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let k = 0; k < 32; k++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ])
      if (Math.abs(a[i][j]) > Math.abs(a[p][q])) {
        p = i;
        q = j;
      }
    if (Math.abs(a[p][q]) < 1e-15) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]),
      c = Math.cos(angle),
      s = Math.sin(angle);
    const app = a[p][p],
      aqq = a[q][q],
      apq = a[p][q];
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const x = a[i][p],
          y = a[i][q];
        a[i][p] = a[p][i] = c * x - s * y;
        a[i][q] = a[q][i] = s * x + c * y;
      }
      const x = v[i][p],
        y = v[i][q];
      v[i][p] = c * x - s * y;
      v[i][q] = s * x + c * y;
    }
  }
  const moments: Vec3 = [a[0][0], a[1][1], a[2][2]];
  const max = Math.max(...moments);
  if (
    moments.some((x) => !Number.isFinite(x) || x <= 0) ||
    max > moments.reduce((s, x) => s + x, 0) - max + Math.max(1e-12, max * 1e-8)
  )
    throw new Error(
      "Inertia must be positive definite and satisfy the rigid-body triangle inequalities",
    );
  const trace = v[0][0] + v[1][1] + v[2][2];
  let quaternion: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    quaternion = [
      (v[2][1] - v[1][2]) / s,
      (v[0][2] - v[2][0]) / s,
      (v[1][0] - v[0][1]) / s,
      s / 4,
    ];
  } else {
    const i =
        v[0][0] > v[1][1]
          ? v[0][0] > v[2][2]
            ? 0
            : 2
          : v[1][1] > v[2][2]
            ? 1
            : 2,
      j = (i + 1) % 3,
      k = (i + 2) % 3,
      s = Math.sqrt(1 + v[i][i] - v[j][j] - v[k][k]) * 2;
    quaternion = [0, 0, 0, (v[k][j] - v[j][k]) / s];
    quaternion[i] = s / 4;
    quaternion[j] = (v[j][i] + v[i][j]) / s;
    quaternion[k] = (v[k][i] + v[i][k]) / s;
  }
  return { moments, quaternion };
}
