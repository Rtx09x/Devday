import type { SimResult, SimTrace } from './types.ts';

export interface StepDirIntentEvidence {
  stepTrace: 'D2';
  directionTrace: 'D3';
  enableTrace: 'D4';
  pulseCount: number;
  risingEdgeCycles: number[];
  fallingEdgeCycles: number[];
  highWidthsCycles: number[];
  periodsCycles: number[];
  directionLevel: 1;
  enableActiveLowLevel: 0;
  clockHz: 16_000_000;
}

function exactTrace(result: SimResult, name: string, bit: number): SimTrace | undefined {
  const matches = result.traces.filter((trace) => trace.name === name
    && trace.unit === 'digital'
    && trace.origin?.family === 'avr'
    && trace.origin.port === 'D'
    && trace.origin.bit === bit
    && trace.timing?.domain === 'emulator-cycles'
    && trace.timing.clockHz === 16_000_000
    && trace.t.length === trace.v.length
    && trace.timing.sampleCycles.length === trace.v.length
    && trace.v.length >= 2
    && trace.v.every((value) => value === 0 || value === 1)
    && trace.t.every((value, index) => Number.isFinite(value)
      && value >= 0
      && (index === 0 || value > trace.t[index - 1]))
    && trace.timing.sampleCycles.every((cycle, index) => Number.isSafeInteger(cycle)
      && cycle >= 0
      && (index === 0 || cycle > trace.timing!.sampleCycles[index - 1])));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Derive fixture-scoped STEP/DIR/ENABLE intent from exact AVR GPIO evidence.
 * The first output-enable transition (cycle <= 1) is initialization, not a
 * STEP pulse. Nothing here represents a motor-driver or motor response.
 */
export function deriveStepDirIntentEvidence(result: SimResult | null | undefined): StepDirIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.firmwareFixture?.id !== 'avr-step-dir-intent') return undefined;
  const step = exactTrace(result, 'D2', 2);
  const direction = exactTrace(result, 'D3', 3);
  const enable = exactTrace(result, 'D4', 4);
  if (!step || !direction || !enable) return undefined;
  if (direction.v.at(-1) !== 1 || enable.v.at(-1) !== 0 || step.v.at(-1) !== 0) return undefined;

  const cycles = step.timing!.sampleCycles;
  const risingEdgeCycles: number[] = [];
  const fallingEdgeCycles: number[] = [];
  for (let index = 1; index < step.v.length; index += 1) {
    const cycle = cycles[index];
    if (!Number.isSafeInteger(cycle) || cycle <= 1) continue;
    if (step.v[index - 1] === 0 && step.v[index] === 1) risingEdgeCycles.push(cycle);
    if (step.v[index - 1] === 1 && step.v[index] === 0) fallingEdgeCycles.push(cycle);
  }
  if (risingEdgeCycles.length !== 3 || fallingEdgeCycles.length !== 3) return undefined;
  if (risingEdgeCycles.some((rise, index) => rise >= fallingEdgeCycles[index]
    || (index > 0 && fallingEdgeCycles[index - 1] >= rise))) return undefined;
  const highWidthsCycles = risingEdgeCycles.map((rise, index) => fallingEdgeCycles[index] - rise);
  const periodsCycles = risingEdgeCycles.slice(1).map((rise, index) => rise - risingEdgeCycles[index]);
  if (highWidthsCycles.some((value) => value <= 0) || periodsCycles.some((value) => value <= 0)) return undefined;
  if (risingEdgeCycles.join(',') !== '6,8200,16394'
    || fallingEdgeCycles.join(',') !== '4103,12297,20491') return undefined;
  return {
    stepTrace: 'D2', directionTrace: 'D3', enableTrace: 'D4', pulseCount: 3,
    risingEdgeCycles, fallingEdgeCycles, highWidthsCycles, periodsCycles,
    directionLevel: 1, enableActiveLowLevel: 0, clockHz: 16_000_000,
  };
}
