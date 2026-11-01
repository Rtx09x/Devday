import type { EvalProjectInput, EvalResult } from './evalCode';

// This identity must change whenever the bundled worker or evaluation options change.
const EVALUATOR_ID = 'tscircuit-eval-worker-v1';
export function createEvaluationCache(evaluate: (input: EvalProjectInput) => Promise<EvalResult>, limit = 8) {
  const entries = new Map<string, EvalResult>();
  return async (context: string, input: EvalProjectInput, options: { bypass?: boolean; active?: () => boolean } = {}): Promise<EvalResult & { cached?: boolean }> => {
    const files = Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([EVALUATOR_ID, context, input.entrypoint, files]);
    // A failed explicit refresh must not revive the prior successful projection.
    if (options.bypass) entries.delete(key);
    if (!options.bypass) {
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key); entries.set(key, cached);
        return { ...structuredClone(cached), durationMs: undefined, cached: true };
      }
    }
    const result = await evaluate(input);
    if (result.ok && (options.active?.() ?? true)) {
      entries.delete(key);
      entries.set(key, structuredClone(result));
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    }
    return structuredClone(result);
  };
}
