/// <reference lib="webworker" />
import { runAllChecks } from '@tscircuit/checks';

self.onmessage = async (event: MessageEvent<{ id: number; circuitJson: unknown[] }>) => {
  const { id, circuitJson } = event.data;
  try {
    const diagnostics = await runAllChecks(circuitJson as never);
    self.postMessage({ id, ok: true, diagnostics });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

