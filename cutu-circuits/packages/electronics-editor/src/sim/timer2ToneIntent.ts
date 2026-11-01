import type { SimResult, SimTrace } from './types.ts';
import { AVR_TIMER2_TONE_INTENT_SHA256 } from './generated/avrTimer2ToneIntent.ts';

export const AVR_TIMER2_TONE_CLOCK_HZ = 16_000_000;
export const AVR_TIMER2_TONE_HALF_PERIOD_CYCLES = 8_000;
export const AVR_TIMER2_TONE_PERIOD_CYCLES = 16_000;
export const AVR_TIMER2_TONE_FIRST_RISING_CYCLE = 7_949;

export interface Timer2ToneIntentEvidence {
  traceName: 'D3';
  timer: 'Timer2';
  outputCompare: 'OC2B';
  clockHz: 16_000_000;
  firstRisingCycle: number;
  halfPeriodCycles: 8_000;
  periodCycles: 16_000;
  frequencyHz: 1_000;
  dutyCycle: 0.5;
  completePeriods: number;
  transitionCycles: Array<{ cycle: number; level: 0 | 1 }>;
}

function exactD3Trace(result: SimResult): SimTrace | undefined {
  const matches = result.traces.filter((trace) => trace.name === 'D3');
  if (matches.length !== 1) return undefined;
  const trace = matches[0];
  return trace.unit === 'digital'
    && trace.origin?.family === 'avr'
    && trace.origin.port === 'D'
    && trace.origin.bit === 3
    && trace.origin.aliases.includes('D3')
    && trace.origin.aliases.includes('PD3')
    && trace.timing?.domain === 'emulator-cycles'
    && trace.timing.clockHz === AVR_TIMER2_TONE_CLOCK_HZ
    && trace.t.length === trace.v.length
    && trace.timing.sampleCycles.length === trace.v.length
    && trace.v.length >= 8
    && trace.v.every((value) => value === 0 || value === 1)
    && trace.timing.sampleCycles.every((cycle, index) => Number.isSafeInteger(cycle) && cycle >= 0
      && (index === 0 || cycle > trace.timing!.sampleCycles[index - 1]))
    ? trace : undefined;
}

/** Derive only exact avr8js Timer2/OC2B modeled-cycle evidence. */
export function deriveTimer2ToneIntentEvidence(result: SimResult | null | undefined): Timer2ToneIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js'
    || result.firmwareFixture?.id !== 'avr-timer2-tone-intent'
    || result.firmwareFixture.sha256 !== AVR_TIMER2_TONE_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-timer2-tone-intent.asm') return undefined;
  const trace = exactD3Trace(result);
  if (!trace) return undefined;
  const cycles = trace.timing!.sampleCycles;
  const transitions: Array<{ cycle: number; level: 0 | 1 }> = [];
  for (let index = 0; index < trace.v.length; index += 1) {
    const level = trace.v[index] as 0 | 1;
    if (index === 0 || level !== trace.v[index - 1]) transitions.push({ cycle: cycles[index], level });
  }
  if (transitions[0].cycle !== 0 || transitions[0].level !== 1
    || transitions[1].cycle !== 1 || transitions[1].level !== 0) return undefined;
  const toneTransitions = transitions.slice(2);
  if (toneTransitions.length < 5) return undefined;
  for (let index = 0; index < toneTransitions.length; index += 1) {
    if (toneTransitions[index].cycle !== AVR_TIMER2_TONE_FIRST_RISING_CYCLE + index * AVR_TIMER2_TONE_HALF_PERIOD_CYCLES
      || toneTransitions[index].level !== (index % 2 === 0 ? 1 : 0)) return undefined;
  }
  return {
    traceName: 'D3', timer: 'Timer2', outputCompare: 'OC2B', clockHz: AVR_TIMER2_TONE_CLOCK_HZ,
    firstRisingCycle: AVR_TIMER2_TONE_FIRST_RISING_CYCLE,
    halfPeriodCycles: AVR_TIMER2_TONE_HALF_PERIOD_CYCLES,
    periodCycles: AVR_TIMER2_TONE_PERIOD_CYCLES,
    frequencyHz: 1_000, dutyCycle: 0.5,
    completePeriods: Math.floor((toneTransitions.length - 1) / 2),
    transitionCycles: transitions,
  };
}

export function canonicalTimer2ToneTransitions(events: readonly { cycle: number; level: 0 | 1 }[]): string {
  return events.map((event) => `${event.cycle}:${event.level}`).join(' ');
}
