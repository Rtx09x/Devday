/**
 * Simulation orchestrator
 *
 * The single entry point the editor panel and the `electronics.simulate` AI tool
 * call. It resolves `auto` to a concrete engine, dispatches to the logical /
 * analog / MCU core, and returns the uniform SimResult. Every path is guarded so
 * a failing engine returns a result with `error` set rather than throwing.
 */

import { runLogicalSim } from './logicalSim.ts';
import { runAnalogSim } from './analogSim.ts';
import { runMcuSim } from './mcuSim.ts';
import { pickAutoMode } from './detect.ts';
import { emptyResult, type SimContext, type SimRequest, type SimResult } from './types.ts';

export async function simulate(ctx: SimContext, req: SimRequest = {}): Promise<SimResult> {
  let mode = req.mode ?? 'auto';
  if (mode === 'auto') mode = pickAutoMode(ctx.circuitJson);

  try {
    switch (mode) {
      case 'logical':
        return runLogicalSim(ctx.circuitJson, req.stimulus ?? {}, req.durationMs ?? 100);
      case 'analog':
        return await runAnalogSim(ctx.circuitJson, { durationMs: req.durationMs });
      case 'mcu':
        return await runMcuSim(ctx, {
          mcu: req.mcu,
          firmware: req.firmware,
          fixture: req.fixture,
          durationMs: req.durationMs,
          stimulus: req.stimulus,
        });
      default: {
        const r = emptyResult('logical', 'none');
        r.error = `Unknown simulation mode "${mode}".`;
        return r;
      }
    }
  } catch (err) {
    const r = emptyResult(mode as SimResult['mode'], 'error');
    r.error = err instanceof Error ? err.message : String(err);
    return r;
  }
}
