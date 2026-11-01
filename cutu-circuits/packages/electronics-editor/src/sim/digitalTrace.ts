import type { SimTrace } from './types.ts';

export interface DigitalTraceMeasurement {
  frequencyHz: number;
  dutyCycle: number;
  completePeriods: number;
  averagePeriod: number;
  averageHigh: number;
  timingDomain: 'emulator-cycles' | 'seconds';
  clockHz?: number;
}

/** Measure only complete rising-edge-to-rising-edge periods, excluding partial window edges. */
export function measureDigitalTrace(trace: SimTrace): DigitalTraceMeasurement | undefined {
  if (trace.unit !== 'digital' || trace.t.length !== trace.v.length || trace.t.length < 3) return undefined;
  const cycleTiming = trace.timing?.domain === 'emulator-cycles'
    && Number.isFinite(trace.timing.clockHz) && trace.timing.clockHz > 0
    && trace.timing.sampleCycles.length === trace.v.length
    ? trace.timing : undefined;
  const positions = cycleTiming?.sampleCycles ?? trace.t;
  if (positions.some((position, index) => !Number.isFinite(position) || (index > 0 && position <= positions[index - 1]))) return undefined;
  if (trace.v.some((value) => value !== 0 && value !== 1)) return undefined;
  const rising: number[] = [];
  for (let index = 1; index < trace.v.length; index++) {
    if (trace.v[index - 1] === 0 && trace.v[index] === 1) rising.push(index);
  }
  let totalPeriod = 0;
  let totalHigh = 0;
  let completePeriods = 0;
  for (let cycle = 0; cycle < rising.length - 1; cycle++) {
    const startIndex = rising[cycle];
    const endIndex = rising[cycle + 1];
    const fallingIndex = Array.from({ length: endIndex - startIndex - 1 }, (_, offset) => startIndex + offset + 1)
      .find((index) => trace.v[index - 1] === 1 && trace.v[index] === 0);
    if (fallingIndex == null) continue;
    const period = positions[endIndex] - positions[startIndex];
    const high = positions[fallingIndex] - positions[startIndex];
    if (!(period > 0) || high < 0 || high > period) continue;
    totalPeriod += period;
    totalHigh += high;
    completePeriods += 1;
  }
  if (!completePeriods || !(totalPeriod > 0)) return undefined;
  const averagePeriod = totalPeriod / completePeriods;
  const averageHigh = totalHigh / completePeriods;
  return {
    frequencyHz: cycleTiming ? cycleTiming.clockHz / averagePeriod : 1 / averagePeriod,
    dutyCycle: totalHigh / totalPeriod,
    completePeriods,
    averagePeriod,
    averageHigh,
    timingDomain: cycleTiming ? 'emulator-cycles' : 'seconds',
    ...(cycleTiming ? { clockHz: cycleTiming.clockHz } : {}),
  };
}
