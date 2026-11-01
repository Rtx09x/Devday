import InlineWorker from './autorouteWorker?worker&inline';
import type { AnyCircuitElement } from '../circuit/circuitJson';
import {
  normalizeAutorouteDiagnostics,
  normalizeSimplifiedPcbTraces,
  type NormalizedSimplifiedPcbTrace,
} from './autorouteContract';

export const DEFAULT_AUTOROUTE_TIMEOUT_MS = 60_000;
export const MIN_AUTOROUTE_TIMEOUT_MS = 5_000;
export const MAX_AUTOROUTE_TIMEOUT_MS = 180_000;
export const DEFAULT_AUTOROUTE_EFFORT = 1;
export const MIN_AUTOROUTE_EFFORT = 0.1;
export const MAX_AUTOROUTE_EFFORT = 10;
export const MIN_AUTOROUTE_TRACE_WIDTH_MM = 0.05;
export const MAX_AUTOROUTE_TRACE_WIDTH_MM = 5;
export const AUTOROUTE_STALL_TIMEOUT_MS = 15_000;
export const MAX_AUTOROUTE_INPUT_ELEMENTS = 50_000;
export const MAX_AUTOROUTE_INPUT_BYTES = 32_000_000;

export interface AutorouteRequestOptions {
  timeoutMs?: number;
  effort?: number;
  minTraceWidth?: number;
}

export interface ValidatedAutorouteOptions {
  timeoutMs: number;
  effort: number;
  minTraceWidth?: number;
}

export interface AutorouteRunResult {
  status: 'solved' | 'failed';
  inputHash: string;
  traces: NormalizedSimplifiedPcbTrace[];
  solverProgress: number;
  diagnostics: string[];
  durationMs: number;
}

export type AutorouteRunErrorReason = 'timed-out' | 'stalled' | 'cancelled' | 'worker-failed';

export class AutorouteRunError extends Error {
  constructor(
    message: string,
    public readonly reason: AutorouteRunErrorReason,
    public readonly inputHash: string,
    public readonly solverProgress: number,
  ) {
    super(message);
    this.name = 'AutorouteRunError';
  }
}

export function validateAutorouteOptions(options: AutorouteRequestOptions = {}): ValidatedAutorouteOptions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTOROUTE_TIMEOUT_MS;
  const effort = options.effort ?? DEFAULT_AUTOROUTE_EFFORT;
  const minTraceWidth = options.minTraceWidth;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_AUTOROUTE_TIMEOUT_MS || timeoutMs > MAX_AUTOROUTE_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between ${MIN_AUTOROUTE_TIMEOUT_MS} and ${MAX_AUTOROUTE_TIMEOUT_MS}.`);
  }
  if (!Number.isFinite(effort) || effort < MIN_AUTOROUTE_EFFORT || effort > MAX_AUTOROUTE_EFFORT) {
    throw new Error(`effort must be a finite number between ${MIN_AUTOROUTE_EFFORT} and ${MAX_AUTOROUTE_EFFORT}.`);
  }
  if (minTraceWidth != null && (!Number.isFinite(minTraceWidth)
    || minTraceWidth < MIN_AUTOROUTE_TRACE_WIDTH_MM || minTraceWidth > MAX_AUTOROUTE_TRACE_WIDTH_MM)) {
    throw new Error(`min_trace_width must be a finite millimetre value between ${MIN_AUTOROUTE_TRACE_WIDTH_MM} and ${MAX_AUTOROUTE_TRACE_WIDTH_MM}.`);
  }
  return { timeoutMs, effort, ...(minTraceWidth == null ? {} : { minTraceWidth }) };
}

export async function hashCircuitJson(circuitJson: AnyCircuitElement[]): Promise<string> {
  if (circuitJson.length > MAX_AUTOROUTE_INPUT_ELEMENTS) {
    throw new Error(`Autoroute input exceeded ${MAX_AUTOROUTE_INPUT_ELEMENTS} Circuit JSON elements.`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(circuitJson));
  if (bytes.byteLength > MAX_AUTOROUTE_INPUT_BYTES) {
    throw new Error(`Autoroute input exceeded ${MAX_AUTOROUTE_INPUT_BYTES} UTF-8 bytes.`);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function runPcbAutorouter(
  circuitJson: AnyCircuitElement[],
  rawOptions: AutorouteRequestOptions & { signal?: AbortSignal; onProgress?: (progress: number) => void } = {},
): Promise<AutorouteRunResult> {
  const options = validateAutorouteOptions(rawOptions);
  const inputHash = await hashCircuitJson(circuitJson);
  const worker = new InlineWorker();
  const started = performance.now();
  let latestProgress = 0;
  return new Promise<AutorouteRunResult>((resolve, reject) => {
    let finished = false;
    let stallWatchdog: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => finish(new AutorouteRunError(
      `PCB route proposal exceeded ${options.timeoutMs} ms.`, 'timed-out', inputHash, latestProgress,
    )), options.timeoutMs);
    const resetStallWatchdog = () => {
      clearTimeout(stallWatchdog);
      stallWatchdog = setTimeout(() => finish(new AutorouteRunError(
        `PCB route proposal made no observable progress for ${AUTOROUTE_STALL_TIMEOUT_MS} ms.`,
        'stalled', inputHash, latestProgress,
      )), Math.min(AUTOROUTE_STALL_TIMEOUT_MS, options.timeoutMs));
    };
    const abort = () => {
      worker.postMessage({ kind: 'cancel', id: 1 });
      finish(new AutorouteRunError('PCB route proposal was cancelled.', 'cancelled', inputHash, latestProgress));
    };
    const finish = (error?: Error, result?: AutorouteRunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(stallWatchdog);
      rawOptions.signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    resetStallWatchdog();
    rawOptions.signal?.addEventListener('abort', abort, { once: true });
    if (rawOptions.signal?.aborted) return abort();
    worker.onerror = (event) => finish(new AutorouteRunError(
      event.message || 'PCB route proposal worker failed.', 'worker-failed', inputHash, latestProgress,
    ));
    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const data = event.data;
      if (data.id !== 1 || data.inputHash !== inputHash) return;
      if (data.kind === 'progress') {
        latestProgress = typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : latestProgress;
        rawOptions.onProgress?.(latestProgress);
        resetStallWatchdog();
        return;
      }
      if (data.kind === 'error') {
        finish(new AutorouteRunError(
          typeof data.error === 'string' ? data.error : 'PCB route proposal worker failed.',
          'worker-failed', inputHash, latestProgress,
        ));
        return;
      }
      if (data.kind !== 'result') return;
      latestProgress = typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : latestProgress;
      if (data.status === 'cancelled') {
        finish(new AutorouteRunError('PCB route proposal was cancelled.', 'cancelled', inputHash, latestProgress));
        return;
      }
      const diagnostics = normalizeAutorouteDiagnostics(data.diagnostics);
      finish(undefined, {
        status: data.status === 'solved' ? 'solved' : 'failed',
        inputHash,
        traces: data.status === 'solved' ? normalizeSimplifiedPcbTraces(data.traces) : [],
        solverProgress: latestProgress,
        diagnostics,
        durationMs: Math.round(performance.now() - started),
      });
    };
    worker.postMessage({
      kind: 'run', id: 1, inputHash, circuitJson,
      options: { effort: options.effort, ...(options.minTraceWidth == null ? {} : { minTraceWidth: options.minTraceWidth }) },
    });
  });
}
