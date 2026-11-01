import { CircuitRunner } from '@tscircuit/eval';
import type { AnyCircuitElement } from './circuitJson.ts';
import type { EvalResult } from './evalCode.ts';

/** Node/headless evaluator for explicit CI entrypoints. Never loads package code from a CDN. */
export async function evalTscircuitCodeHeadless(code: string): Promise<EvalResult> {
  if (!code || !code.trim()) return { ok: true, circuitJson: [] };
  const started = performance.now();
  let runner: CircuitRunner | undefined;
  try {
    runner = new CircuitRunner({
      snippetsApiBaseUrl: 'https://registry-api.tscircuit.com',
      cjsRegistryUrl: 'https://cjs.tscircuit.com',
      platform: { partsEngineDisabled: true },
    });
    await runner.setDisableCdnLoading(true);
    await runner.executeWithFsMap({ fsMap: { 'user-code.tsx': code } });
    await runner.renderUntilSettled();
    const result = await runner.getCircuitJson();
    if (!Array.isArray(result)) throw new Error('The headless evaluator returned a non-array Circuit JSON projection.');
    return {
      ok: true,
      circuitJson: result as AnyCircuitElement[],
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      ok: false,
      circuitJson: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    if (runner) {
      try { await runner.kill(); } catch { /* ignore cleanup failure */ }
    }
  }
}
