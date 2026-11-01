/// <reference lib="webworker" />

// Replicad kernel worker.
//
// Hosts OpenCascade.js (the OCCT CAD kernel compiled to wasm) plus Replicad's
// TypeScript API. The wasm payload is delivered at runtime as a base64 string
// via the `init` message (the client reads dist/replicad.wasm.b64 and posts it
// here), keeping the worker bundle small — same trick the OpenSCAD extension used.
//
// Per compile we transpile the user's `*.replicad.ts` to JS with Sucrase
// (pure-JS, no second wasm to hand off, so the live-edit loop stays tight) and
// run it against the kernel. We use the `with_exceptions` OCCT build so kernel
// failures throw catchable JS errors instead of aborting the wasm instance —
// essential for the agent's see-correct loop to recover and report.

// @ts-ignore -- emscripten glue, no type declarations
import initOpenCascade from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import * as replicad from 'replicad';
import { transform } from 'sucrase';
import { meshToStats, mergeMeshes } from '../geometry';
import { objFromMesh, threeMFFromMesh } from './serialize';
import { transformToMatrix } from './mat4';
import type {
  AnimationConfig,
  AnimationData,
  AnimationFrameTransforms,
  CompileMessage,
  ExportArtifact,
  ExportFormat,
  ParamDef,
  ParamValues,
  ReplicadMesh,
  ShapeResult,
  Transform,
} from '../types';
import {
  sourceLineCount,
  sourceLocationFromRuntimeError,
  sourceLocationFromSucraseError,
} from '../compileDiagnostics';
import type { SourceLocation } from '../compileDiagnostics';
import type {
  CompileWorkerRequest,
  CompileWorkerResponse,
  InitMessage,
  InspectStepRequest,
  InspectStepResponse,
  WorkerInbound,
} from './messages';

// Minimal structural view of the Replicad shapes we consume.
interface KernelShape {
  mesh(options?: { tolerance?: number; angularTolerance?: number }): {
    vertices: number[];
    triangles: number[];
    normals: number[];
    faceGroups?: Array<{ start: number; count: number; faceId: number }>;
  };
  readonly faces?: KernelFace[];
  meshEdges?(options?: { tolerance?: number; angularTolerance?: number }): { lines: number[] };
  blobSTL?(options?: { tolerance?: number; angularTolerance?: number; binary?: boolean }): Blob;
  blobSTEP?(): Blob;
  clone?(): KernelShape;
  delete?(): void;
}

interface KernelFace {
  readonly hashCode: number;
  readonly geomType?: string;
  _geomAdaptor?(): {
    Cylinder(): { Radius(): number; delete(): void };
    delete(): void;
  };
}

interface NamedShape {
  name: string;
  shape: KernelShape;
  color?: string;
  opacity?: number;
}

const DEFAULT_TOLERANCE = 0.1;
const DEFAULT_ANGULAR_TOLERANCE = 0.5;

let kernelReady: Promise<void> | null = null;
let wasmBinary: Uint8Array | null = null;
// Bundled default text font (Roboto Regular) bytes, decoded from the init
// payload. Registered as the 'default' family once the kernel is up so drawText()
// works without any project setup.
let fontBinary: Uint8Array | null = null;
let defaultFontLoaded = false;

type LoadFont = (font: ArrayBuffer, fontFamily?: string, force?: boolean) => Promise<unknown>;

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Register the bundled default font. Non-fatal: if it is missing or unparseable,
// compiles still succeed and only drawText() surfaces replicad's missing-font error.
async function loadDefaultFont(): Promise<void> {
  if (defaultFontLoaded || !fontBinary) return;
  const loadFont = (replicad as unknown as { loadFont?: LoadFont }).loadFont;
  if (!loadFont) return;
  try {
    await loadFont(bytesToArrayBuffer(fontBinary), 'default');
    defaultFontLoaded = true;
  } catch {
    // Leave the default unregistered; drawText() will report it if used.
  }
}

// Apply a project font override (base64 sidecar) as the 'default' family for this
// compile, replacing the bundled font. Best-effort: a bad override falls back to
// the bundled default rather than failing the whole compile.
async function applyFontOverride(fontAssets: CompileWorkerRequest['fontAssets']): Promise<void> {
  if (!fontAssets || fontAssets.length === 0) return;
  const loadFont = (replicad as unknown as { loadFont?: LoadFont }).loadFont;
  if (!loadFont) return;
  const first = fontAssets[0];
  try {
    await loadFont(bytesToArrayBuffer(decodeBase64(first.base64)), 'default', true);
  } catch {
    // Keep the bundled default; the override was unusable.
  }
}

// Best-effort sandbox lockdown. User `*.replicad.ts` code runs in this worker via
// `new Function`, which is NOT a security boundary: the worker's global scope
// (fetch, WebSocket, importScripts, etc.) is otherwise reachable, so a model from
// an untrusted repo/template could exfiltrate data or pull in remote JS. Replicad
// models legitimately need none of these — geometry is pure compute and the OCCT
// wasm is handed in directly (no fetch). This is defense-in-depth, not a true
// sandbox; pair it with the client-side request timeout that bounds CPU.
//
// IMPORTANT: run this AFTER the kernel initializes. Emscripten's glue feature-detects
// these globals during init (e.g. `typeof fetch`), so installing throwing getters
// beforehand would break OCCT startup. By the time models run, the kernel is up and
// never touches the network, so locking the globals here is safe. `postMessage`,
// timers, and crypto are left intact because the worker itself needs them.
let globalsHardened = false;
function hardenWorkerGlobals(): void {
  if (globalsHardened) return;
  globalsHardened = true;
  const g = self as unknown as Record<string, unknown>;
  const blocked = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'importScripts',
    'Worker',
    'SharedWorker',
    'indexedDB',
    'caches',
    'Request',
    'Response',
  ];
  for (const name of blocked) {
    try {
      Object.defineProperty(g, name, {
        configurable: true,
        get() {
          throw new Error(
            `Replicad models cannot use '${name}'. Model code runs in a locked-down kernel worker with no network or storage access.`
          );
        },
      });
    } catch {
      // Some engines mark these non-configurable; skip what we can't redefine.
    }
  }
  try {
    const nav = g.navigator as { sendBeacon?: unknown } | undefined;
    if (nav && 'sendBeacon' in nav) nav.sendBeacon = undefined;
  } catch {
    // navigator may be read-only; ignore.
  }
}

function decodeBase64(b64: string): Uint8Array {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function ensureKernel(): Promise<void> {
  if (kernelReady) return kernelReady;
  if (!wasmBinary) {
    throw new Error('Replicad worker received a request before the wasm payload was initialized');
  }
  kernelReady = (async () => {
    const OC = await initOpenCascade({ wasmBinary });
    (replicad as unknown as { setOC: (oc: unknown) => void }).setOC(OC);
    // Register the bundled default font (uses opentype, no network). Must run
    // before hardening locks down the worker globals.
    await loadDefaultFont();
    // Kernel is up and won't touch the network again — safe to lock down now.
    hardenWorkerGlobals();
  })().catch((error) => {
    // Don't cache a rejected init promise — otherwise a transient failure (corrupt
    // wasm, OOM) would poison every later compile with the same stale error and the
    // worker would be permanently dead. Clearing it lets the next request retry.
    kernelReady = null;
    throw error;
  });
  return kernelReady;
}

// --- Transpile + run the user module -----------------------------------------

interface RunOutput {
  exportsObject: Record<string, unknown>;
  logs: string[];
}

function makeCaptureConsole(logs: string[]): Console {
  const record = (level: string) => (...args: unknown[]) => {
    logs.push(`${level}: ${args.map((arg) => stringifyArg(arg)).join(' ')}`);
  };
  return {
    ...console,
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  } as Console;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function runUserModule(
  source: string,
  filePath: string,
  importedShapes: Map<string, KernelShape>
): RunOutput {
  const { code } = transform(source, {
    transforms: ['typescript', 'imports'],
    filePath,
    production: true,
  });

  const logs: string[] = [];
  const moduleObject = { exports: {} as Record<string, unknown> };
  const requireShim = (name: string): unknown => {
    if (name === 'replicad') return replicad;
    throw new Error(
      `Cannot import '${name}'. A *.replicad.ts model may only import from 'replicad' (and use the injected imported(name) helper for STEP assets).`
    );
  };
  const importedHelper = (name: string): KernelShape => {
    const shape = importedShapes.get(name);
    if (!shape) {
      const available = [...importedShapes.keys()].join(', ') || '(none)';
      throw new Error(`No imported STEP asset named '${name}'. Available: ${available}`);
    }
    return shape.clone ? shape.clone() : shape;
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('require', 'exports', 'module', 'imported', 'console', code);
  fn(requireShim, moduleObject.exports, moduleObject, importedHelper, makeCaptureConsole(logs));
  return { exportsObject: moduleObject.exports, logs };
}

// --- Parameter resolution ----------------------------------------------------

function normalizeParamDef(raw: Record<string, unknown>, fallbackName?: string): ParamDef | null {
  const name = (raw.name as string) ?? fallbackName;
  if (!name) return null;
  const value = raw.default ?? raw.value;
  const inferred = inferKind(value);
  const kind = (raw.kind as ParamDef['kind']) ?? inferred ?? 'string';
  return {
    name,
    kind,
    default: (value ?? defaultForKind(kind)) as ParamDef['default'],
    label: raw.label as string | undefined,
    group: raw.group as string | undefined,
    min: raw.min as number | undefined,
    max: raw.max as number | undefined,
    step: raw.step as number | undefined,
    options: Array.isArray(raw.options) ? (raw.options as string[]) : undefined,
    description: raw.description as string | undefined,
  };
}

function inferKind(value: unknown): ParamDef['kind'] | null {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number')) {
    return 'vector';
  }
  if (typeof value === 'string') return 'string';
  return null;
}

function defaultForKind(kind: ParamDef['kind']): ParamDef['default'] {
  switch (kind) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'vector':
      return [0, 0, 0];
    default:
      return '';
  }
}

function resolveParamDefs(exportsObject: Record<string, unknown>): ParamDef[] {
  const descriptor =
    (exportsObject.parameterDefinitions as unknown) ?? (exportsObject.paramsDefinition as unknown);
  if (Array.isArray(descriptor)) {
    return descriptor
      .map((entry) => normalizeParamDef(entry as Record<string, unknown>))
      .filter((entry): entry is ParamDef => entry !== null);
  }
  if (descriptor && typeof descriptor === 'object') {
    return Object.entries(descriptor as Record<string, unknown>)
      .map(([name, entry]) =>
        normalizeParamDef(
          (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : { default: entry }),
          name
        )
      )
      .filter((entry): entry is ParamDef => entry !== null);
  }
  const defaults = exportsObject.defaultParams;
  if (defaults && typeof defaults === 'object') {
    return Object.entries(defaults as Record<string, unknown>)
      .map(([name, value]) => normalizeParamDef({ default: value }, name))
      .filter((entry): entry is ParamDef => entry !== null);
  }
  return [];
}

function effectiveParamValues(defs: ParamDef[], overrides?: ParamValues): ParamValues {
  const values: ParamValues = {};
  for (const def of defs) values[def.name] = def.default;
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) values[key] = value;
  }
  return values;
}

// --- Shape normalization -----------------------------------------------------

function isKernelShape(value: unknown): value is KernelShape {
  return !!value && typeof (value as KernelShape).mesh === 'function';
}

function normalizeShapes(output: unknown): NamedShape[] {
  const list = Array.isArray(output) ? output : [output];
  const result: NamedShape[] = [];
  list.forEach((item, index) => {
    if (isKernelShape(item)) {
      result.push({ name: `shape${index + 1}`, shape: item });
      return;
    }
    if (item && typeof item === 'object' && isKernelShape((item as { shape?: unknown }).shape)) {
      const wrapped = item as { shape: KernelShape; name?: string; color?: string; opacity?: number };
      result.push({
        name: wrapped.name ?? `shape${index + 1}`,
        shape: wrapped.shape,
        color: wrapped.color,
        opacity: wrapped.opacity,
      });
      return;
    }
    if (item == null) return;
    throw new Error(
      'Model output is not a shape. Return a Replicad 3D shape, an array of shapes, or {shape, name, color, opacity} descriptors.'
    );
  });
  if (result.length === 0) {
    throw new Error('Model produced no shapes. The default export (or main) must return at least one shape.');
  }
  return result;
}

function meshShape(
  shape: KernelShape,
  tolerance: number,
  angularTolerance: number
): ReplicadMesh {
  const mesh = shape.mesh({ tolerance, angularTolerance });
  const surfaceInfo = new Map<
    number,
    { surfaceType?: 'planar' | 'cylindrical'; radiusMm?: number }
  >();
  for (const face of shape.faces ?? []) {
    try {
      if (face.geomType === 'PLANE') {
        surfaceInfo.set(face.hashCode, { surfaceType: 'planar' });
      } else if (face.geomType === 'CYLINDRE') {
        let radiusMm: number | undefined;
        const adaptor = face._geomAdaptor?.();
        if (adaptor) {
          try {
            const cylinder = adaptor.Cylinder();
            try {
              radiusMm = cylinder.Radius();
            } finally {
              cylinder.delete();
            }
          } finally {
            adaptor.delete();
          }
        }
        surfaceInfo.set(face.hashCode, { surfaceType: 'cylindrical', radiusMm });
      }
    } catch {
      // Surface metadata is optional; face picking still works from faceGroups.
    }
  }
  let edges: number[] | undefined;
  try {
    edges = shape.meshEdges?.({ tolerance, angularTolerance }).lines;
  } catch {
    edges = undefined;
  }
  const faceGroups = mesh.faceGroups?.map((group) => ({
    ...group,
    ...surfaceInfo.get(group.faceId),
  }));
  return { vertices: mesh.vertices, triangles: mesh.triangles, normals: mesh.normals, faceGroups, edges };
}

function mergeNormals(shapeResults: ShapeResult[]): number[] {
  const normals: number[] = [];
  for (const shape of shapeResults) normals.push(...shape.mesh.normals);
  return normals;
}

function combineForExport(named: NamedShape[]): KernelShape {
  if (named.length === 1) return named[0].shape;
  const makeCompound = (replicad as unknown as { makeCompound?: (shapes: KernelShape[]) => KernelShape }).makeCompound;
  if (makeCompound) {
    try {
      return makeCompound(named.map((entry) => entry.shape));
    } catch {
      // Fall through to first shape if compounding fails.
    }
  }
  return named[0].shape;
}

// --- Stats -------------------------------------------------------------------

function computeStats(
  named: NamedShape[],
  shapeResults: ShapeResult[]
): ReturnType<typeof meshToStats> {
  const merged = mergeMeshes(shapeResults.map((shape) => shape.mesh));
  let kernelVolume: number | undefined;
  let kernelArea: number | undefined;
  const measureVolume = (replicad as unknown as { measureVolume?: (s: unknown) => number }).measureVolume;
  const measureArea = (replicad as unknown as { measureArea?: (s: unknown) => number }).measureArea;
  if (measureVolume) {
    try {
      kernelVolume = named.reduce((sum, entry) => sum + measureVolume(entry.shape), 0);
    } catch {
      kernelVolume = undefined;
    }
  }
  if (measureArea) {
    try {
      kernelArea = named.reduce((sum, entry) => sum + measureArea(entry.shape), 0);
    } catch {
      kernelArea = undefined;
    }
  }
  return meshToStats(merged, { volume: kernelVolume, surfaceArea: kernelArea });
}

// OCCT failures can surface as a bare emscripten exception pointer (a number)
// rather than a JS Error with a message. Turn those into something the agent's
// see-correct loop can actually act on.
function describeKernelError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const raw = typeof error === 'number' ? String(error) : String(error);
  if (/^\d+$/.test(raw.trim())) {
    return (
      `OCCT raised an internal exception (${raw}). This usually means an ` +
      `operation produced invalid geometry — common causes: a shell/offset wall ` +
      `thicker than a corner radius, a fillet/chamfer larger than the adjacent ` +
      `edge, a boolean on self-intersecting shapes, or a zero/negative dimension. ` +
      `Try reducing the feature size or simplifying the operation.`
    );
  }
  return raw;
}

// --- Animation ---------------------------------------------------------------

const DEFAULT_ANIM_FRAMES = 120;
const DEFAULT_ANIM_DURATION_MS = 5000;

/**
 * Sample a model's `animate(t, params)` over the loop into per-shape matrix
 * tracks. t runs [0, 1) across `frames` samples. A shape omitted from a frame's
 * result keeps identity for that frame. Returns null (with a warning) on failure
 * — a broken animation must not fail an otherwise-valid compile.
 */
function sampleAnimation(
  animate: (t: number, params: ParamValues) => unknown,
  config: AnimationConfig | undefined,
  values: ParamValues,
  shapeNames: string[],
  warnings: string[]
): AnimationData | undefined {
  const frames = Math.max(2, Math.floor(config?.frames ?? DEFAULT_ANIM_FRAMES));
  const durationMs = Math.max(100, config?.durationMs ?? DEFAULT_ANIM_DURATION_MS);
  const loop = config?.loop ?? true;
  const tracks: Record<string, number[][]> = {};
  const known = new Set(shapeNames);
  let any = false;

  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const t = frame / frames;
      const result = animate(t, values) as AnimationFrameTransforms | undefined;
      if (!result || typeof result !== 'object') continue;
      for (const [name, transform] of Object.entries(result)) {
        if (!known.has(name) || transform == null) continue;
        const matrix = transformToMatrix(transform as Transform);
        if (!tracks[name]) {
          // Backfill earlier frames with identity if this shape appeared late.
          tracks[name] = Array.from({ length: frame }, () => transformToMatrix({}));
        }
        tracks[name].push(matrix);
        any = true;
      }
      // Pad shapes that were present before but skipped this frame.
      for (const name of Object.keys(tracks)) {
        if (tracks[name].length < frame + 1) tracks[name].push(transformToMatrix({}));
      }
    }
  } catch (error) {
    warnings.push(`animate() failed; animation disabled: ${describeKernelError(error)}`);
    return undefined;
  }

  if (!any) return undefined;
  const fps = Math.round((frames / durationMs) * 1000);
  return { fps, frames, durationMs, loop, tracks };
}

// --- Compile -----------------------------------------------------------------

async function importStepAssets(
  assets: CompileWorkerRequest['stepAssets']
): Promise<Map<string, KernelShape>> {
  const map = new Map<string, KernelShape>();
  if (!assets || assets.length === 0) return map;
  const importSTEP = (replicad as unknown as { importSTEP?: (blob: Blob) => Promise<KernelShape> }).importSTEP;
  if (!importSTEP) return map;
  for (const asset of assets) {
    try {
      const shape = await importSTEP(new Blob([asset.content]));
      map.set(asset.name, shape);
    } catch (error) {
      throw new Error(`Failed to import STEP asset '${asset.name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return map;
}

async function blobToText(blob: Blob): Promise<string> {
  return blob.text();
}

async function serializeExports(
  named: NamedShape[],
  shapeResults: ShapeResult[],
  formats: ExportFormat[],
  tolerance: number,
  angularTolerance: number
): Promise<{ artifacts: ExportArtifact[]; warnings: string[] }> {
  const artifacts: ExportArtifact[] = [];
  const warnings: string[] = [];
  if (formats.length === 0) return { artifacts, warnings };

  const exportShape = combineForExport(named);
  const merged = mergeMeshes(shapeResults.map((shape) => shape.mesh));
  const mergedWithNormals = { ...merged, normals: mergeNormals(shapeResults) };

  for (const format of formats) {
    try {
      if (format === 'stl' && exportShape.blobSTL) {
        const text = await blobToText(exportShape.blobSTL({ tolerance, angularTolerance, binary: false }));
        artifacts.push({ format, extension: 'stl', content: text, encoding: 'utf8', byteLength: text.length });
      } else if (format === 'step' && exportShape.blobSTEP) {
        const text = await blobToText(exportShape.blobSTEP());
        artifacts.push({ format, extension: 'step', content: text, encoding: 'utf8', byteLength: text.length });
      } else if (format === 'obj') {
        const text = objFromMesh(mergedWithNormals);
        artifacts.push({ format, extension: 'obj', content: text, encoding: 'utf8', byteLength: text.length });
      } else if (format === '3mf') {
        const base64 = threeMFFromMesh(merged);
        artifacts.push({ format, extension: '3mf', content: base64, encoding: 'base64', byteLength: Math.floor((base64.length * 3) / 4) });
      }
    } catch (error) {
      warnings.push(`Failed to export ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { artifacts, warnings };
}

function disposeShapes(named: NamedShape[]): void {
  for (const entry of named) {
    try {
      entry.shape.delete?.();
    } catch {
      // best effort
    }
  }
}

async function handleCompile(request: CompileWorkerRequest): Promise<CompileWorkerResponse> {
  const start = performance.now();
  const diagnostics: CompileMessage[] = [];
  const tolerance = request.tolerance ?? DEFAULT_TOLERANCE;
  const angularTolerance = request.angularTolerance ?? DEFAULT_ANGULAR_TOLERANCE;

  await ensureKernel();
  // A project font sidecar, if present, overrides the bundled default for this run.
  await applyFontOverride(request.fontAssets);

  let importedShapes: Map<string, KernelShape>;
  try {
    importedShapes = await importStepAssets(request.stepAssets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(request.id, message, performance.now() - start);
  }

  let exportsObject: Record<string, unknown>;
  let logs: string[] = [];
  const lineCount = sourceLineCount(request.source);
  try {
    const run = runUserModule(request.source, request.filePath, importedShapes);
    exportsObject = run.exportsObject;
    logs = run.logs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const location =
      sourceLocationFromSucraseError(error, lineCount) ?? sourceLocationFromRuntimeError(error, lineCount);
    return failure(
      request.id,
      `Script error: ${message}`,
      performance.now() - start,
      logsToDiagnostics(logs),
      [],
      location ?? undefined
    );
  }

  const params = resolveParamDefs(exportsObject);
  const values = effectiveParamValues(params, request.params);

  let named: NamedShape[];
  try {
    const entry = (exportsObject.default ?? exportsObject.main) as unknown;
    const output = typeof entry === 'function' ? await (entry as (p: ParamValues) => unknown)(values) : entry;
    named = normalizeShapes(output);
  } catch (error) {
    return failure(
      request.id,
      `Kernel error: ${describeKernelError(error)}`,
      performance.now() - start,
      logsToDiagnostics(logs),
      params,
      sourceLocationFromRuntimeError(error, lineCount) ?? undefined
    );
  }

  let shapeResults: ShapeResult[];
  try {
    shapeResults = named.map((entry) => ({
      name: entry.name,
      color: entry.color,
      opacity: entry.opacity,
      mesh: meshShape(entry.shape, tolerance, angularTolerance),
    }));
  } catch (error) {
    disposeShapes(named);
    return failure(request.id, `Tessellation error: ${describeKernelError(error)}`, performance.now() - start, logsToDiagnostics(logs), params);
  }

  let stats;
  try {
    stats = computeStats(named, shapeResults);
  } catch (error) {
    diagnostics.push({ level: 'warn', text: `Could not compute model stats: ${error instanceof Error ? error.message : String(error)}` });
  }

  const { artifacts, warnings } = await serializeExports(
    named,
    shapeResults,
    request.exports ?? [],
    tolerance,
    angularTolerance
  );

  // Sample transform-track animation if the model exports `animate(t, params)`.
  let animation: AnimationData | undefined;
  const animate = exportsObject.animate;
  if (typeof animate === 'function') {
    animation = sampleAnimation(
      animate as (t: number, params: ParamValues) => unknown,
      exportsObject.animationConfig as AnimationConfig | undefined,
      values,
      shapeResults.map((shape) => shape.name),
      warnings
    );
  }

  disposeShapes(named);

  return {
    id: request.id,
    type: 'compile-result',
    success: true,
    shapes: shapeResults,
    params,
    stats,
    exports: artifacts.length ? artifacts : undefined,
    animation,
    diagnostics: [...logsToDiagnostics(logs), ...diagnostics, ...warnings.map((text) => ({ level: 'warn' as const, text }))],
    warnings,
    errors: [],
    renderTimeMs: performance.now() - start,
  };
}

function logsToDiagnostics(logs: string[]): CompileMessage[] {
  return logs.map((text) => ({ level: text.startsWith('error:') ? 'error' : text.startsWith('warn:') ? 'warn' : 'info', text }));
}

function failure(
  id: number,
  message: string,
  renderTimeMs: number,
  extraDiagnostics: CompileMessage[] = [],
  params: ParamDef[] = [],
  location?: SourceLocation
): CompileWorkerResponse {
  return {
    id,
    type: 'compile-result',
    success: false,
    shapes: [],
    params,
    diagnostics: [...extraDiagnostics, { level: 'error', text: message, ...location }],
    warnings: [],
    errors: [message],
    renderTimeMs,
  };
}

async function handleInspectStep(request: InspectStepRequest): Promise<InspectStepResponse> {
  const start = performance.now();
  const tolerance = request.tolerance ?? DEFAULT_TOLERANCE;
  const angularTolerance = request.angularTolerance ?? DEFAULT_ANGULAR_TOLERANCE;
  try {
    await ensureKernel();
    const importSTEP = (replicad as unknown as { importSTEP?: (blob: Blob) => Promise<KernelShape> }).importSTEP;
    if (!importSTEP) throw new Error('Replicad build does not expose importSTEP');
    const shape = await importSTEP(new Blob([request.content]));
    const mesh = meshShape(shape, tolerance, angularTolerance);
    const shapeResults: ShapeResult[] = [{ name: request.name, mesh }];
    const stats = computeStats([{ name: request.name, shape }], shapeResults);
    disposeShapes([{ name: request.name, shape }]);
    return {
      id: request.id,
      type: 'inspect-step-result',
      success: true,
      name: request.name,
      shapes: shapeResults,
      stats,
      errors: [],
      renderTimeMs: performance.now() - start,
    };
  } catch (error) {
    return {
      id: request.id,
      type: 'inspect-step-result',
      success: false,
      name: request.name,
      shapes: [],
      errors: [error instanceof Error ? error.message : String(error)],
      renderTimeMs: performance.now() - start,
    };
  }
}

function handleInit(message: InitMessage): void {
  // Guard against a stray second init replacing the payload mid-session; the
  // client only inits once per worker, but a fresh worker starts with wasmBinary
  // null so re-initialization after a terminate still works.
  if (!wasmBinary) {
    wasmBinary = decodeBase64(message.wasmBase64);
  }
  if (!fontBinary && message.fontBase64) {
    fontBinary = decodeBase64(message.fontBase64);
  }
  (self as unknown as Worker).postMessage({ type: 'ready' });
}

self.addEventListener('message', (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message?.type === 'init') {
    handleInit(message);
    return;
  }
  if (message?.type === 'compile') {
    handleCompile(message)
      .then((response) => (self as unknown as Worker).postMessage(response))
      .catch((error) => {
        (self as unknown as Worker).postMessage(
          failure(message.id, error instanceof Error ? error.message : String(error), 0)
        );
      });
    return;
  }
  if (message?.type === 'inspect-step') {
    handleInspectStep(message)
      .then((response) => (self as unknown as Worker).postMessage(response))
      .catch((error) => {
        const response: InspectStepResponse = {
          id: message.id,
          type: 'inspect-step-result',
          success: false,
          name: message.name,
          shapes: [],
          errors: [error instanceof Error ? error.message : String(error)],
          renderTimeMs: 0,
        };
        (self as unknown as Worker).postMessage(response);
      });
  }
});
