/// <reference lib="webworker" />
import * as CapacityAutorouter from '@tscircuit/capacity-autorouter';
import { AutoroutingPipelineSolver } from '@tscircuit/capacity-autorouter';
import { getSimpleRouteJsonFromCircuitJson } from '@tscircuit/core';
import {
  inspectCapacityAutorouterContract,
  normalizeAutorouteDiagnostics,
  normalizeSimplifiedPcbTraces,
} from './autorouteContract';

interface RunMessage {
  kind: 'run';
  id: number;
  inputHash: string;
  circuitJson: unknown[];
  options: { effort: number; minTraceWidth?: number };
}

interface CancelMessage { kind: 'cancel'; id: number }

const cancelled = new Set<number>();
const yieldToWorker = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run(message: RunMessage): Promise<void> {
  const { id, inputHash, circuitJson, options } = message;
  try {
    const contract = inspectCapacityAutorouterContract(CapacityAutorouter);
    if (!contract.usable) throw new Error(contract.reason);
    const { simpleRouteJson } = getSimpleRouteJsonFromCircuitJson({
      circuitJson: circuitJson as never[],
      ...(options.minTraceWidth == null ? {} : { minTraceWidth: options.minTraceWidth }),
    });
    // Core and the solver currently publish structurally equivalent SRJ types
    // from different dependency snapshots. This is the explicit adapter seam.
    const solver = new AutoroutingPipelineSolver(
      simpleRouteJson as ConstructorParameters<typeof AutoroutingPipelineSolver>[0],
      { effort: options.effort },
    );
    let steps = 0;
    let lastProgressAt = performance.now();
    while (!solver.solved && !solver.failed) {
      if (cancelled.has(id)) {
        self.postMessage({ kind: 'result', id, inputHash, status: 'cancelled', progress: solver.progress, diagnostics: [] });
        return;
      }
      solver.step();
      steps += 1;
      const now = performance.now();
      if (steps % 100 === 0 || now - lastProgressAt >= 250) {
        self.postMessage({ kind: 'progress', id, inputHash, progress: solver.progress, steps });
        lastProgressAt = now;
      }
      if (steps % 100 === 0) await yieldToWorker();
    }
    const diagnostics = normalizeAutorouteDiagnostics(solver.error ? [solver.error] : []);
    if (solver.failed) {
      self.postMessage({ kind: 'result', id, inputHash, status: 'failed', progress: solver.progress, diagnostics });
      return;
    }
    const traces = normalizeSimplifiedPcbTraces(solver.getOutputSimplifiedPcbTraces());
    self.postMessage({ kind: 'result', id, inputHash, status: 'solved', progress: 1, diagnostics, traces });
  } catch (error) {
    self.postMessage({
      kind: 'error', id, inputHash,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    cancelled.delete(id);
  }
}

self.onmessage = (event: MessageEvent<RunMessage | CancelMessage>) => {
  if (event.data.kind === 'cancel') {
    cancelled.add(event.data.id);
    return;
  }
  void run(event.data);
};
