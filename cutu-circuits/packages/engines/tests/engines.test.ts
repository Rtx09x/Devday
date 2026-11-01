import test from "node:test";
import assert from "node:assert/strict";
import {
  compileCad,
  compileCircuit,
  exportCad,
  exportCircuit,
  runEngine,
} from "../src/index.ts";

const circuitSource = `export default () => <board width="30mm" height="20mm"><resistor name="R1" resistance="1k" footprint="0402" /></board>`;
const cadSource = `import {drawRectangle} from 'replicad';
export const defaultParams = {width: 10, height: 3};
export default function main({width,height}) {
 return [drawRectangle(width, 5).sketchOnPlane().extrude(height),
 {name:'second',color:'#80cbc4',shape:drawRectangle(2,2).sketchOnPlane().extrude(2).translate([20,0,0])}];
}`;

test(
  "real offline circuit evaluator, exports and edited native source",
  { timeout: 90_000 },
  async () => {
    const first = await compileCircuit(circuitSource, "model.circuit.tsx");
    assert.ok(first.circuitJson.length > 0);
    assert.equal(first.components.find((c) => c.name === "R1")?.value, "1000");
    assert.match(first.schematicSvg, /<svg/);
    assert.match(first.pcbSvg, /<svg/);
    const edited = await compileCircuit(
      circuitSource.replace("1k", "2k"),
      "model.circuit.tsx",
    );
    assert.notEqual(first.sourceSha256, edited.sourceSha256);
    assert.notEqual(first.components[0].value, edited.components[0].value);
    const bom = await exportCircuit(circuitSource, "model.circuit.tsx", "bom");
    assert.match(bom.content, /R1/);
    assert.match(
      (await exportCircuit(circuitSource, "model.circuit.tsx", "svg")).content,
      /<svg/,
    );
  },
);

test(
  "real OCCT metrics, mixed descriptors, parameter overrides and manufacturing exports",
  { timeout: 90_000 },
  async () => {
    const model = await compileCad(cadSource, "model.replicad.ts", {
      width: 20,
    });
    assert.equal(model.shapes.length, 2);
    assert.equal(model.shapes[1].name, "second");
    assert.equal(model.parameters.width, 20);
    assert.ok(Math.abs(model.metrics.volume - 308) < 0.001);
    assert.ok(model.metrics.surfaceArea > 0);
    assert.ok(model.metrics.triangleCount > 0);
    const step = await exportCad(cadSource, "model.replicad.ts", "step");
    assert.match(step.content, /ISO-10303-21/);
    const stl = await exportCad(cadSource, "model.replicad.ts", "stl");
    assert.match(stl.content, /facet normal/);
    const obj = await exportCad(cadSource, "model.replicad.ts", "obj");
    assert.match(obj.content, /^v /m);
    assert.match(obj.content, /^f /m);
  },
);

test(
  "CPU-bound model is killed and the next compile recovers",
  { timeout: 60_000 },
  async () => {
    await assert.rejects(
      runEngine(
        {
          kind: "cad",
          source: "export default function main(){while(true){}}",
          path: "loop.replicad.ts",
        },
        2500,
      ),
      { code: "ENGINE_TIMEOUT" },
    );
    await assert.rejects(
      runEngine(
        {
          kind: "circuit",
          source: "while(true){}; export default () => null;",
          path: "loop.circuit.tsx",
        },
        2500,
      ),
      { code: "ENGINE_TIMEOUT" },
    );
    const model = await compileCad(cadSource, "recovered.replicad.ts");
    assert.ok(Math.abs(model.metrics.volume - 158) < 0.001);
    await assert.rejects(
      compileCad("export default () => null", "bad.replicad.ts"),
      /no shapes/,
    );
  },
);
