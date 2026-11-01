import type { SimResult, SimTrace } from './types.ts';
import { AVR_SERVO_PULSE_INTENT_SHA256 } from './generated/avrServoPulseIntent.ts';

export const AVR_SERVO_PULSE_CLOCK_HZ = 16_000_000;
export const AVR_SERVO_PULSE_PERIOD_CYCLES = 320_000;
export const AVR_SERVO_PULSE_HIGH_CYCLES = 24_000;
export const AVR_SERVO_PULSE_FIRST_RISING_CYCLE = 320_020;

export interface ServoPulseIntentEvidence {
  traceName: 'D9';
  timer: 'Timer1';
  outputCompare: 'OC1A';
  clockHz: 16_000_000;
  firstRisingCycle: number;
  periodCycles: 320_000;
  highCycles: 24_000;
  frequencyHz: 50;
  dutyCycle: 0.075;
  highPulseMicroseconds: 1_500;
  completedPulses: number;
  completePeriods: number;
  transitionCycles: Array<{ cycle: number; level: 0 | 1 }>;
}

function exactD9Trace(result: SimResult): SimTrace | undefined {
  const matches = result.traces.filter((trace) => trace.name === 'D9');
  if (matches.length !== 1) return undefined;
  const trace = matches[0];
  return trace.unit === 'digital'
    && trace.origin?.family === 'avr'
    && trace.origin.port === 'B'
    && trace.origin.bit === 1
    && trace.origin.aliases.includes('D9')
    && trace.origin.aliases.includes('PB1')
    && trace.timing?.domain === 'emulator-cycles'
    && trace.timing.clockHz === AVR_SERVO_PULSE_CLOCK_HZ
    && trace.t.length === trace.v.length
    && trace.timing.sampleCycles.length === trace.v.length
    && trace.v.length >= 7
    && trace.v.every((value) => value === 0 || value === 1)
    && trace.t.every((value, index) => Number.isFinite(value) && value >= 0
      && (index === 0 || value > trace.t[index - 1]))
    && trace.timing.sampleCycles.every((cycle, index) => Number.isSafeInteger(cycle) && cycle >= 0
      && (index === 0 || cycle > trace.timing!.sampleCycles[index - 1]))
    ? trace : undefined;
}

/**
 * Derive only the exact Timer1/OC1A modeled-cycle evidence emitted by the
 * checked-in fixture. This does not infer servo motion or physical timing.
 */
export function deriveServoPulseIntentEvidence(result: SimResult | null | undefined): ServoPulseIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js'
    || result.firmwareFixture?.id !== 'avr-servo-pulse-intent'
    || result.firmwareFixture.sha256 !== AVR_SERVO_PULSE_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-servo-pulse-intent.asm') return undefined;
  const trace = exactD9Trace(result);
  if (!trace) return undefined;
  const cycles = trace.timing!.sampleCycles;
  const transitions: Array<{ cycle: number; level: 0 | 1 }> = [];
  for (let index = 0; index < trace.v.length; index += 1) {
    const level = trace.v[index] as 0 | 1;
    if (index === 0 || level !== trace.v[index - 1]) transitions.push({ cycle: cycles[index], level });
  }
  if (transitions.length < 6
    || transitions[0].cycle !== 0 || transitions[0].level !== 1
    || transitions[1].cycle !== 1 || transitions[1].level !== 0) return undefined;

  const pulseTransitions = transitions.slice(2);
  for (let index = 0; index < pulseTransitions.length; index += 1) {
    const pulseIndex = Math.floor(index / 2);
    const isRising = index % 2 === 0;
    const expectedCycle = AVR_SERVO_PULSE_FIRST_RISING_CYCLE
      + pulseIndex * AVR_SERVO_PULSE_PERIOD_CYCLES
      + (isRising ? 0 : AVR_SERVO_PULSE_HIGH_CYCLES);
    if (pulseTransitions[index].cycle !== expectedCycle || pulseTransitions[index].level !== (isRising ? 1 : 0)) return undefined;
  }
  const completedPulses = Math.floor(pulseTransitions.length / 2);
  const risingEdges = pulseTransitions.filter((_, index) => index % 2 === 0).length;
  if (completedPulses < 2 || risingEdges < 2) return undefined;
  return {
    traceName: 'D9', timer: 'Timer1', outputCompare: 'OC1A', clockHz: AVR_SERVO_PULSE_CLOCK_HZ,
    firstRisingCycle: AVR_SERVO_PULSE_FIRST_RISING_CYCLE,
    periodCycles: AVR_SERVO_PULSE_PERIOD_CYCLES,
    highCycles: AVR_SERVO_PULSE_HIGH_CYCLES,
    frequencyHz: 50,
    dutyCycle: 0.075,
    highPulseMicroseconds: 1_500,
    completedPulses,
    completePeriods: risingEdges - 1,
    transitionCycles: transitions,
  };
}

export function canonicalServoPulseTransitions(events: readonly { cycle: number; level: 0 | 1 }[]): string {
  return events.map((event) => `${event.cycle}:${event.level}`).join(' ');
}
