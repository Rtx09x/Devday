import InlineCheckWorker from './checkWorker?worker&inline';
import type { AnyCircuitElement } from '../circuit/circuitJson';
import { normalizeUpstreamCheckDiagnostics, type UpstreamCheckDiagnostic } from './checkContract';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface CircuitCheckResult {
  inputHash: string;
  diagnostics: UpstreamCheckDiagnostic[];
  durationMs: number;
}

export async function runUpstreamCircuitChecks(
  circuitJson: AnyCircuitElement[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CircuitCheckResult> {
  const serialized = JSON.stringify(circuitJson);
  const inputHash = await sha256(serialized);
  const worker = new InlineCheckWorker();
  const started = performance.now();
  return new Promise<CircuitCheckResult>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Upstream circuit checks exceeded ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`)), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const abort = () => finish(new DOMException('Upstream circuit checks were cancelled.', 'AbortError'));
    const finish = (error?: Error, diagnostics?: unknown) => {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve({ inputHash, diagnostics: normalizeUpstreamCheckDiagnostics(diagnostics), durationMs: Math.round(performance.now() - started) });
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) return abort();
    worker.onerror = (event) => finish(new Error(event.message || 'Upstream circuit check worker failed.'));
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; diagnostics?: unknown; error?: string }>) => {
      if (event.data.id !== 1) return;
      if (!event.data.ok) finish(new Error(event.data.error || 'Upstream circuit checks failed.'));
      else finish(undefined, event.data.diagnostics);
    };
    worker.postMessage({ id: 1, circuitJson });
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

