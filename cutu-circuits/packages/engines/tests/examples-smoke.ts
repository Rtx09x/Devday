import { readFile } from "node:fs/promises";
import {
  compileCad,
  compileCircuit,
  exportCad,
  exportCircuit,
} from "../src/index.ts";
for (const name of ["sensor", "spidey"]) {
  const cad = await readFile(
    new URL(`../../../examples/${name}/model.replicad.ts`, import.meta.url),
    "utf8",
  );
  const circuit = await readFile(
    new URL(`../../../examples/${name}/circuit.circuit.tsx`, import.meta.url),
    "utf8",
  );
  const c = await compileCad(cad, "model.replicad.ts");
  console.log(name, "CAD", c.shapes.length, "volume", c.metrics.volume);
  for (const format of ["step", "stl", "obj"] as const)
    console.log(
      name,
      format,
      (await exportCad(cad, "model.replicad.ts", format)).content.length,
    );
  if (process.argv.includes("--cad-only")) continue;
  const e = await compileCircuit(circuit, "circuit.circuit.tsx");
  console.log(
    name,
    "circuit",
    e.components.length,
    "diagnostics",
    JSON.stringify(e.diagnostics),
  );
  for (const format of ["svg", "bom"] as const)
    console.log(
      name,
      format,
      (await exportCircuit(circuit, "circuit.circuit.tsx", format)).content
        .length,
    );
}
