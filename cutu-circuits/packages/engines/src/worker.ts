import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  ArtifactResult,
  CadResult,
  CircuitResult,
  Diagnostic,
} from "@cutucircuits/core";
import type { EngineRequest } from "./index.ts";
import { sourceSha256 } from "./index.ts";
import type { AnyCircuitElement } from "../../electronics-editor/src/circuit/circuitJson.ts";
import type { CompileWorkerResponse } from "../../cad-editor/src/runtime/messages.ts";

const require = createRequire(import.meta.url);
const baseName = (path: string) =>
  path
    .split("/")
    .pop()!
    .replace(/\.(circuit\.(tsx|json)|replicad\.ts)$/, "");
const metadata = (request: EngineRequest) => ({
  path: request.path,
  sourceSha256: sourceSha256(request.source),
  compiledAt: new Date().toISOString(),
});

async function circuit(
  request: EngineRequest,
): Promise<CircuitResult | ArtifactResult> {
  const { listComponents, lintCircuit, parseCircuitJsonProjection } =
    await import("../../electronics-editor/src/circuit/circuitJson.ts");
  const { buildImageBundle } = await import(
    "../../electronics-editor/src/circuit/imageExport.ts"
  );
  let circuitJson: AnyCircuitElement[];
  if (request.path.endsWith(".json")) {
    const parsed = parseCircuitJsonProjection(request.source);
    if (parsed.error) throw new Error(parsed.error);
    circuitJson = parsed.circuitJson;
  } else {
    const { CircuitRunner } = await import("@tscircuit/eval");
    const runner = new CircuitRunner({
      platform: { partsEngineDisabled: true },
    });
    await runner.setDisableCdnLoading(true);
    try {
      await runner.executeWithFsMap({
        fsMap: { [request.path]: request.source },
      });
      await runner.renderUntilSettled();
      circuitJson = await runner.getCircuitJson();
    } finally {
      await runner.kill();
    }
  }
  const name = baseName(request.path);
  if (request.format === "bom") {
    const { buildBomBundle } = await import(
      "../../electronics-editor/src/circuit/bom.ts"
    );
    const bundle = await buildBomBundle(circuitJson, name, "generic");
    const content = bundle.files[`${name}-bom.csv`];
    if (!content)
      throw new Error(
        bundle.warnings.join("\n") || "BOM export produced no artifact",
      );
    return { name: `${name}-bom.csv`, mimeType: "text/csv", content };
  }
  const images = await buildImageBundle(circuitJson, name, [
    "schematic",
    "pcb",
  ]);
  const schematicSvg = images.files[`${name}-schematic.svg`] ?? "";
  if (request.format === "svg") {
    if (!schematicSvg)
      throw new Error(images.warnings.join("\n") || "No schematic available");
    return {
      name: `${name}-schematic.svg`,
      mimeType: "image/svg+xml",
      content: schematicSvg,
    };
  }
  const diagnostics: Diagnostic[] = lintCircuit(circuitJson).map((item) => ({
    level: item.severity,
    message: item.message,
  }));
  for (const item of circuitJson) {
    if (item.type.includes("error"))
      diagnostics.push({
        level: "error",
        message: String(item.message ?? item.error_type ?? item.type),
      });
  }
  diagnostics.push(
    ...images.warnings.map((message) => ({
      level: "warning" as const,
      message,
    })),
  );
  return {
    kind: "circuit",
    ...metadata(request),
    circuitJson,
    components: listComponents(circuitJson).map((component) => ({
      id: component.id,
      name: component.name,
      type: component.ftype ?? "component",
      value: component.value,
    })),
    schematicSvg,
    pcbSvg: images.files[`${name}-pcb.svg`] ?? "",
    diagnostics,
  };
}

/** Adapt the existing browser kernel protocol to IPC without replacing its model pipeline. */
async function cad(
  request: EngineRequest,
): Promise<CadResult | ArtifactResult> {
  const kernelPath = require.resolve(
    "replicad-opencascadejs/src/replicad_with_exceptions.js",
  );
  Object.assign(globalThis, {
    __dirname: dirname(kernelPath),
    __filename: kernelPath,
  });
  const fontBase64 = (
    await readFile(
      require.resolve(
        "@expo-google-fonts/roboto/400Regular/Roboto_400Regular.ttf",
      ),
    )
  ).toString("base64");
  const wasmBase64 = (
    await readFile(
      require.resolve(
        "replicad-opencascadejs/src/replicad_with_exceptions.wasm",
      ),
    )
  ).toString("base64");
  let dispatch: (event: { data: unknown }) => void = () => {};
  let receive: (message: any) => void = () => {};
  Object.assign(globalThis, {
    self: {
      addEventListener: (_type: string, listener: typeof dispatch) => {
        dispatch = listener;
      },
      postMessage: (message: unknown) => receive(message),
    },
  });
  await import("../../cad-editor/src/runtime/worker.ts");
  const result = await new Promise<CompileWorkerResponse>((resolve) => {
    receive = (message) => {
      if (message.type === "ready") {
        dispatch({
          data: {
            id: 1,
            type: "compile",
            source: request.source,
            filePath: request.path,
            params: request.parameters,
            exports: request.format ? [request.format] : [],
          },
        });
      } else resolve(message);
    };
    dispatch({ data: { type: "init", wasmBase64, fontBase64 } });
  });
  if (!result.success) throw new Error(result.errors.join("\n"));
  if (request.format) {
    const artifact = result.exports?.find(
      (item) => item.format === request.format,
    );
    if (!artifact)
      throw new Error(
        result.warnings.join("\n") || "CAD export produced no artifact",
      );
    return {
      name: `${baseName(request.path)}.${artifact.extension}`,
      mimeType:
        request.format === "step"
          ? "model/step"
          : request.format === "stl"
            ? "model/stl"
            : "model/obj",
      content: artifact.content,
    };
  }
  if (!result.stats)
    throw new Error("CAD kernel returned no model measurements");
  const diagnostics: Diagnostic[] = result.diagnostics.map((item) => ({
    level: item.level === "warn" ? "warning" : item.level,
    message: item.text,
    line: item.line,
  }));
  const { mergeMeshes } = await import("../../cad-editor/src/geometry.ts");
  const { analyzePrintability } = await import(
    "../../cad-editor/src/printability.ts"
  );
  const printability = analyzePrintability(
    mergeMeshes(result.shapes.map((shape) => shape.mesh)),
    result.stats,
  );
  diagnostics.push(
    ...printability.notes.map((message) => ({
      level: "info" as const,
      message: `Printability: ${message}`,
    })),
  );
  const parameters: CadResult["parameters"] = { ...request.parameters };
  for (const param of result.params) {
    const value = request.parameters?.[param.name] ?? param.default;
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      parameters[param.name] = value;
  }
  return {
    kind: "cad",
    ...metadata(request),
    shapes: result.shapes,
    parameters,
    metrics: {
      volume: result.stats.volume,
      surfaceArea: result.stats.surfaceArea,
      triangleCount: result.stats.triangleCount,
      bounds: result.stats.boundingBox,
    },
    diagnostics,
  };
}

process.once("message", async (request: EngineRequest) => {
  try {
    const result = await (request.kind === "cad"
      ? cad(request)
      : circuit(request));
    process.send?.({ result });
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
