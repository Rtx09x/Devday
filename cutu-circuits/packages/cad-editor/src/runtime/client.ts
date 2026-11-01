import KernelWorker from './worker?worker';
import wasmUrl from '../../assets/replicad.wasm.b64?url';
import fontUrl from '../../assets/replicad.font.b64?url';
import type { ExtensionFileSystemService } from '@cutucircuits/editor-host';
import { join } from '../pathUtils';
import { getErrorMessage } from '../utils';
import type { CompileRequest, CompileResult, ModelStats, ShapeResult } from '../types';
import type {
  CompileWorkerRequest,
  CompileWorkerResponse,
  InspectStepRequest,
  InspectStepResponse,
  WorkerOutbound,
} from './messages';

let workerPromise: Promise<Worker> | null = null;
let messageCounter = 0;
// Compiles are serialized: a single OCCT instance is reused across calls, and
// concurrent callMain-equivalent kernel work is not safe to interleave.
let requestQueue: Promise<void> = Promise.resolve();

// Hard ceiling on a single kernel request. Untrusted user model code can busy-loop
// (`while (true) {}`) or trigger a pathological OCCT operation that never returns;
// since `with_exceptions` only helps when the kernel re-enters JS, the only way to
// stop a runaway worker is to terminate it. Without this the serialized queue would
// deadlock forever behind the hung request and the only recovery would be reloading
// the extension.
const KERNEL_REQUEST_TIMEOUT_MS = 45_000;

export interface KernelEnvironment {
  filesystem: ExtensionFileSystemService;
  extensionPath: string;
}

function invalidateWorker(worker?: Worker): void {
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // Ignore termination failures while resetting worker state.
    }
  }
  workerPromise = null;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = requestQueue.then(task, task);
  requestQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function loadWorker(environment: KernelEnvironment): Promise<Worker> {
  if (workerPromise) return workerPromise;
  const { filesystem, extensionPath } = environment;
  const createdWorker = (async () => {
    // Worker module + the (separate) wasm payload load in parallel. The wasm
    // ships as base64 text because the Blob-URL worker can't fetch relative
    // assets and the SDK only exposes a text reader for bundled asset paths.
    const [wasmBase64,fontBase64] = await Promise.all([
      fetch(wasmUrl).then(r=>{if(!r.ok)throw new Error('Failed to load local CAD kernel');return r.text()}),
      fetch(fontUrl).then(r=>r.ok?r.text():'').catch(()=>''),
    ]);
    const worker = new KernelWorker();
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const cleanup = () => {
          worker.removeEventListener('message', onReady);
          worker.removeEventListener('error', onError);
          worker.removeEventListener('messageerror', onMessageError);
        };
        const onReady = (event: MessageEvent<WorkerOutbound>) => {
          if (event.data?.type === 'ready') {
            cleanup();
            resolveReady();
          }
        };
        const onError = (event: ErrorEvent) => {
          cleanup();
          invalidateWorker(worker);
          rejectReady(new Error(event.message || 'Replicad worker failed to load'));
        };
        const onMessageError = () => {
          cleanup();
          invalidateWorker(worker);
          rejectReady(new Error('Replicad worker sent an unreadable initialization message'));
        };
        worker.addEventListener('message', onReady);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
        worker.postMessage({ type: 'init', wasmBase64, fontBase64: fontBase64 || undefined });
      });
      return worker;
    } finally {
      // Vite owns the emitted worker module URL.
    }
  })();

  workerPromise = createdWorker;
  try {
    return await createdWorker;
  } catch (error) {
    if (workerPromise === createdWorker) workerPromise = null;
    throw error;
  }
}

function postRequest<TResponse extends WorkerOutbound>(
  worker: Worker,
  request: CompileWorkerRequest | InspectStepRequest,
  responseType: TResponse['type']
): Promise<TResponse> {
  return new Promise((resolveReply, rejectReply) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      worker.removeEventListener('message', handler);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };
    const handler = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      if (!message || message.type !== responseType) return;
      if ((message as { id?: number }).id !== request.id) return;
      cleanup();
      resolveReply(message as TResponse);
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      invalidateWorker(worker);
      rejectReply(new Error(event.message || 'Replicad worker failed during request'));
    };
    const onMessageError = () => {
      cleanup();
      invalidateWorker(worker);
      rejectReply(new Error('Replicad worker returned an unreadable response'));
    };
    // A hung request never posts a response and never fires `error`, so without a
    // timeout this promise (and the whole serialized queue behind it) would stall
    // forever. Terminate the worker to kill the runaway kernel; the next queued
    // request re-initializes a fresh worker via loadWorker().
    timer = setTimeout(() => {
      cleanup();
      invalidateWorker(worker);
      rejectReply(
        new Error(
          `Replicad kernel timed out after ${Math.round(
            KERNEL_REQUEST_TIMEOUT_MS / 1000
          )}s. The model may contain an infinite loop or an operation too expensive to evaluate.`
        )
      );
    }, KERNEL_REQUEST_TIMEOUT_MS);
    worker.addEventListener('message', handler);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.postMessage(request);
  });
}

function failureResult(request: CompileRequest, prefix: string, error: unknown): CompileResult {
  const message = `${prefix}: ${getErrorMessage(error)}`;
  return {
    success: false,
    filePath: request.filePath,
    shapes: [],
    params: [],
    diagnostics: [{ level: 'error', text: message }],
    warnings: [],
    errors: [message],
    renderTimeMs: 0,
  };
}

export async function compileReplicad(
  environment: KernelEnvironment,
  request: CompileRequest
): Promise<CompileResult> {
  try {
    const workerRequest: CompileWorkerRequest = {
      id: ++messageCounter,
      type: 'compile',
      source: request.source,
      filePath: request.filePath,
      params: request.params,
      stepAssets: request.stepAssets,
      fontAssets: request.fontAssets,
      exports: request.exports,
      tolerance: request.tolerance,
      angularTolerance: request.angularTolerance,
    };
    // Resolve the worker *inside* the queued task so each serialized request binds
    // to the currently-live worker. If a prior request crashed or timed out and
    // terminated the worker, loadWorker() transparently re-initializes a fresh one
    // here instead of posting to a dead worker and hanging.
    const response = await enqueue(async () => {
      const worker = await loadWorker(environment);
      return postRequest<CompileWorkerResponse>(worker, workerRequest, 'compile-result');
    });
    return {
      success: response.success,
      filePath: request.filePath,
      shapes: response.shapes,
      params: response.params,
      stats: response.stats,
      exports: response.exports,
      animation: response.animation,
      diagnostics: response.diagnostics,
      warnings: response.warnings,
      errors: response.errors,
      renderTimeMs: response.renderTimeMs,
    };
  } catch (error) {
    return failureResult(request, 'Replicad compile failed', error);
  }
}

export interface InspectStepResult {
  success: boolean;
  name: string;
  shapes: ShapeResult[];
  stats?: ModelStats;
  errors: string[];
  renderTimeMs: number;
}

export async function inspectStep(
  environment: KernelEnvironment,
  name: string,
  content: string
): Promise<InspectStepResult> {
  try {
    const request: InspectStepRequest = { id: ++messageCounter, type: 'inspect-step', name, content };
    const response = await enqueue(async () => {
      const worker = await loadWorker(environment);
      return postRequest<InspectStepResponse>(worker, request, 'inspect-step-result');
    });
    return {
      success: response.success,
      name: response.name,
      shapes: response.shapes,
      stats: response.stats,
      errors: response.errors,
      renderTimeMs: response.renderTimeMs,
    };
  } catch (error) {
    return { success: false, name, shapes: [], errors: [getErrorMessage(error)], renderTimeMs: 0 };
  }
}

export function disposeReplicadWorker(): void {
  const pending = workerPromise;
  if (!pending) return;
  // Detach synchronously so a concurrent loadWorker() creates a fresh worker
  // instead of racing this teardown (which would otherwise null out the new
  // worker promise in its .finally and leak the Blob URL + decoded wasm).
  workerPromise = null;
  requestQueue = Promise.resolve();
  pending
    .then((worker) => worker.terminate())
    .catch(() => {});
}
