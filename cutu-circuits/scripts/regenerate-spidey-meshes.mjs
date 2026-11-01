// Run: node --import tsx scripts/regenerate-spidey-meshes.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { compileCad } from "../packages/engines/src/index.ts";

const root = new URL("../examples/spidey/", import.meta.url);
const source = await readFile(new URL("model.replicad.ts", root), "utf8");
const model = await compileCad(source, "model.replicad.ts");
const urdf = await readFile(new URL("spidey.urdf", root), "utf8");
const pivots = new Map([["body", [0, 0, 0]]]);
for (const [, child, xyz] of urdf.matchAll(
  /<joint\b[\s\S]*?<child link="([^"]+)"\/>\s*<origin xyz="([^"]+)"[\s\S]*?<\/joint>/g,
))
  pivots.set(child, xyz.split(" ").map(Number));
const frames = new Map();
for (const [, link, content] of urdf.matchAll(
  /<link name="([^"]+)">([\s\S]*?)<\/link>/g,
))
  for (const [, name] of content.matchAll(/<visual name="([^"]+)"/g))
    frames.set(name, pivots.get(link));
assert.equal(frames.size, model.shapes.length);
let triangles = 0;
let bytes = 0;
for (const shape of model.shapes) {
  const pivot = frames.get(shape.name);
  assert(pivot, `No URDF frame for ${shape.name}`);
  const { vertices, triangles: indices } = shape.mesh;
  const count = indices.length / 3;
  const data = Buffer.alloc(84 + count * 50);
  data.write(`Cutu Circuits: ${shape.name}`, 0, 80, "ascii");
  data.writeUInt32LE(count, 80);
  for (let i = 0; i < count; i++) {
    const points = indices
      .slice(i * 3, i * 3 + 3)
      .map((index) =>
        pivot.map((offset, axis) => vertices[index * 3 + axis] / 1000 - offset),
      );
    const a = points[1].map((n, axis) => n - points[0][axis]);
    const b = points[2].map((n, axis) => n - points[0][axis]);
    const normal = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const length = Math.hypot(...normal) || 1;
    [...normal.map((n) => n / length), ...points.flat()].forEach((n, j) =>
      data.writeFloatLE(n, 84 + i * 50 + j * 4),
    );
  }
  await writeFile(new URL(`meshes/${shape.name}.stl`, root), data);
  triangles += count;
  bytes += data.length;
}
await writeFile(
  new URL("meshes/README.md", root),
  `# Makada native visual meshes

These ${model.shapes.length} binary STL files contain ${triangles.toLocaleString("en-US")} triangles compiled by OpenCascade from the default parameters of \`../model.replicad.ts\`. Source SHA-256: \`${model.sourceSha256}\`. Total binary mesh size: ${bytes.toLocaleString("en-US")} bytes.

Regenerate from the application root with \`node --import tsx scripts/regenerate-spidey-meshes.mjs\`. Each vertex is converted from millimetres to metres and translated into its URDF link's local pivot frame. Update the authored URDF pivots and collision geometry when changing mechanical placement.

These are photo-informed CAD meshes, not scanned or measured parts. The URDF uses separate estimated collision primitives, masses, inertia and joint limits. Wire/glue compliance, transmission backlash, servo calibration and measured hardware feedback are not modeled.
`,
);
console.log(
  JSON.stringify({
    shapes: model.shapes.length,
    triangles,
    bytes,
    sourceSha256: model.sourceSha256,
  }),
);
