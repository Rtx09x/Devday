/**
 * tscircuit code evaluation (Web Worker)
 *
 * The hybrid authoring model: a `.circuit.tsx` file holds tscircuit's native
 * React/TSX source, which we evaluate to Circuit JSON for rendering. The code is
 * the source of truth; Circuit JSON is the projection the canvas renders.
 *
 * We run evaluation in a tscircuit **Web Worker**, not on the renderer thread.
 * The worker isolates the CPU-heavy React-reconciler circuit build from the UI
 * and keeps one deterministic TSX-to-Circuit-JSON boundary. The
 * worker entrypoint is bundled by `@tscircuit/eval` and decoded to a local blob
 * URL on first use. This keeps evaluation available without a network request.
 *
 * Everything here is lazy and guarded: no network at load, and any failure
 * (worker startup, eval error) degrades to a clear status instead of breaking
 * the editor. `.circuit.json` documents never touch this path.
 */

import type { AnyCircuitElement } from './circuitJson';

export interface EvalResult {
  ok: boolean;
  circuitJson: AnyCircuitElement[];
  error?: string;
  durationMs?: number;
}

export interface EvalProjectInput {
  /** Project-relative entry source path, preserved for relative imports. */
  entrypoint: string;
  /** Bounded project-relative UTF-8 files, including the entrypoint. */
  files: Record<string, string>;
}

const MAX_EVAL_PROJECT_FILES = 64;
const MAX_EVAL_PROJECT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_EVAL_PROJECT_BYTES = 16 * 1024 * 1024;

interface CircuitWebWorker {
  executeWithFsMap(opts: {
    fsMap: Record<string, string>;
    entrypoint?: string;
  }): Promise<void>;
  renderUntilSettled(): Promise<void>;
  getCircuitJson(): Promise<AnyCircuitElement[]>;
  kill(): Promise<void>;
}

let bundledWorkerUrlPromise: Promise<string> | null = null;

async function getBundledWorkerUrl(): Promise<string> {
  if (!bundledWorkerUrlPromise) {
    bundledWorkerUrlPromise = import('@tscircuit/eval/blob-url')
      .then((mod) => mod.default)
      .catch((err) => {
        bundledWorkerUrlPromise = null;
        throw err;
      });
  }
  return bundledWorkerUrlPromise;
}

async function createWorker(): Promise<CircuitWebWorker> {
  const mod = await import('@tscircuit/eval/worker');
  const blobUrl = await getBundledWorkerUrl();
  const worker = (await mod.createCircuitWebWorker({
    webWorkerBlobUrl: blobUrl,
    snippetsApiBaseUrl: 'https://registry-api.tscircuit.com',
    cjsRegistryUrl: 'https://cjs.tscircuit.com',
    // The default browser parts engine POSTs directly to EasyEDA's private API
    // to infer supplier data from manufacturer part numbers. EasyEDA does not
    // permit CutuCircuits's localhost origin, so every evaluation otherwise emits
    // CORS failures. Our catalog and authored circuits use explicit footprints;
    // keep evaluation deterministic and require supplierPartNumbers to be
    // declared in source until a privileged/server-side parts proxy exists.
    platform: { partsEngineDisabled: true },
    disableCdnLoading: true,
  })) as unknown as CircuitWebWorker;
  return worker;
}

/** Evaluate tscircuit `.tsx` source into Circuit JSON in a worker. Never throws. */
export async function evalTscircuitCode(code: string): Promise<EvalResult> {
  return evalTscircuitProject({ entrypoint: 'user-code.tsx', files: { 'user-code.tsx': code } });
}

/** Evaluate one bounded virtual tscircuit project with real relative import paths. */
export async function evalTscircuitProject(project: EvalProjectInput): Promise<EvalResult> {
  const started = performance.now();
  let worker: CircuitWebWorker | null = null;
  try {
    const normalized = normalizeEvalProject(project);
    const entrySource = normalized.files[normalized.entrypoint];
    if (!entrySource || !entrySource.trim()) return { ok: true, circuitJson: [] };
    worker = await createWorker();
    // Mirror runTscircuitCode: hand the code in as a virtual file with NO
    // entrypoint set, so tscircuit auto-detects and renders the default-exported
    // component (an explicit entrypoint would require a `circuit.add(...)` call).
    await worker.executeWithFsMap({ fsMap: normalized.files });
    await worker.renderUntilSettled();
    const circuitJson = await worker.getCircuitJson();
    return {
      ok: true,
      circuitJson: Array.isArray(circuitJson) ? circuitJson : [],
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      circuitJson: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    // Fresh worker per eval keeps state clean; killing frees the realm.
    if (worker) {
      try {
        await worker.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

function normalizeEvalProject(project: EvalProjectInput): EvalProjectInput {
  const entries = Object.entries(project.files ?? {});
  if (entries.length < 1 || entries.length > MAX_EVAL_PROJECT_FILES) {
    throw new Error(`Evaluation projects require 1-${MAX_EVAL_PROJECT_FILES} files.`);
  }
  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const [rawPath, content] of entries) {
    const normalizedPath = normalizeProjectPath(rawPath);
    if (normalizedPath in files) throw new Error(`Duplicate evaluation project path: ${normalizedPath}`);
    if (typeof content !== 'string') throw new Error(`Evaluation project file must be UTF-8 text: ${normalizedPath}`);
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_EVAL_PROJECT_FILE_BYTES) throw new Error(`Evaluation project file is too large: ${normalizedPath}`);
    totalBytes += bytes;
    if (totalBytes > MAX_EVAL_PROJECT_BYTES) throw new Error('Evaluation project is too large.');
    files[normalizedPath] = content;
  }
  const entrypoint = normalizeProjectPath(project.entrypoint);
  if (!(entrypoint in files)) throw new Error(`Evaluation entrypoint is missing from the project: ${entrypoint}`);
  return { entrypoint, files };
}

function normalizeProjectPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw new Error('Evaluation project path is invalid.');
  }
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Evaluation project path must remain project-relative: ${rawPath}`);
  }
  return normalized;
}
