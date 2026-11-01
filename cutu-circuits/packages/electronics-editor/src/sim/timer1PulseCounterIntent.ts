import { AVR_TIMER1_PULSE_COUNTER_INTENT_SHA256 } from './generated/avrTimer1PulseCounterIntent.ts';
import { isAvrTimer1PulseCounterStimulus, normalizeFixtureStimulus } from './fixtureStimulus.ts';
import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';

type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;
type TimerCounterReadEvent = Extract<PeripheralEvent, { kind: 'timer-counter-read' }>;

export const TIMER1_PULSE_START_CYCLE = 500;
export const TIMER1_PULSE_SPACING_CYCLES = 500;
export const TIMER1_PULSE_HIGH_CYCLES = 100;
export const TIMER1_PULSE_THRESHOLD = 4;
export const TIMER1_COUNTER_READ_CYCLE = 6160;
export const TIMER1_READ_COMPLETE_CYCLE_BELOW_THRESHOLD = 6164;
export const TIMER1_THRESHOLD_CYCLE = 6163;
export const TIMER1_READ_COMPLETE_CYCLE_AT_OR_ABOVE_THRESHOLD = 6165;

const TIMER1_PULSE_APPLIED_CYCLES = [
  500, 600, 1001, 1100, 1500, 1601, 2000, 2100,
  2501, 2600, 3000, 3101, 3500, 3600, 4001, 4100,
] as const;

export interface Timer1PulsePhase {
  level: 0 | 1;
  requestedCycle: number;
  appliedCycle: number;
}

export interface Timer1PulseCounterIntentEvidence {
  requestedPulseCount: number;
  countedPulseCount: number;
  readCycle: number;
  readCompleteCycle: number;
  thresholdReached: boolean;
  thresholdCycle?: number;
  inputPin: 'D5';
  completionPin: 'D6';
  thresholdPin: 'D7';
  controller: 'TIMER1';
  counter: 'TCNT1';
  edge: 'rising';
  risingEdges: Array<{ requestedCycle: number; appliedCycle: number; count: number }>;
}

export function timer1PulsePlan(count: number): Timer1PulsePhase[] {
  const phases: Timer1PulsePhase[] = [];
  for (let index = 0; index < count; index += 1) {
    const rising = TIMER1_PULSE_START_CYCLE + index * TIMER1_PULSE_SPACING_CYCLES;
    const phaseIndex = index * 2;
    phases.push({ level: 1, requestedCycle: rising, appliedCycle: TIMER1_PULSE_APPLIED_CYCLES[phaseIndex] });
    phases.push({
      level: 0,
      requestedCycle: rising + TIMER1_PULSE_HIGH_CYCLES,
      appliedCycle: TIMER1_PULSE_APPLIED_CYCLES[phaseIndex + 1],
    });
  }
  return phases;
}

function exactTrace(result: SimResult, name: 'D6' | 'D7', bit: 6 | 7): SimTrace | undefined {
  const matches = result.traces.filter((trace) => trace.name === name
    && trace.unit === 'digital'
    && trace.origin?.family === 'avr'
    && trace.origin.port === 'D'
    && trace.origin.bit === bit
    && trace.timing?.domain === 'emulator-cycles'
    && trace.timing.clockHz === 16_000_000
    && trace.t.length === trace.v.length
    && trace.timing.sampleCycles.length === trace.v.length
    && trace.v.every((value) => value === 0 || value === 1)
    && trace.timing.sampleCycles.every((cycle, index) => Number.isSafeInteger(cycle)
      && cycle >= 0 && (index === 0 || cycle > trace.timing!.sampleCycles[index - 1])));
  return matches.length === 1 ? matches[0] : undefined;
}

export function canonicalTimer1ExternalCount(
  evidence: Pick<Timer1PulseCounterIntentEvidence, 'risingEdges' | 'countedPulseCount' | 'readCycle'>,
): string {
  const edges = evidence.risingEdges
    .map((edge) => `${edge.requestedCycle}/${edge.appliedCycle}=${edge.count}`)
    .join(',');
  return `D5:rising@${edges} TIMER1:TCNT1=${evidence.countedPulseCount}@${evidence.readCycle} CS=7`;
}

export function deriveTimer1PulseCounterIntentEvidence(
  result: SimResult | null | undefined,
): Timer1PulseCounterIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.mode !== 'mcu'
    || result.firmwareFixture?.id !== 'avr-timer1-pulse-counter-intent'
    || result.firmwareFixture.sha256 !== AVR_TIMER1_PULSE_COUNTER_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-timer1-pulse-counter-intent.asm'
    || (result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  let normalized;
  try {
    normalized = normalizeFixtureStimulus('avr-timer1-pulse-counter-intent', result.modeledStimulus);
  } catch {
    return undefined;
  }
  if (!isAvrTimer1PulseCounterStimulus(normalized)) return undefined;
  const plan = timer1PulsePlan(normalized.timer1_pulse_count);
  const inputEvents = (result.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected');
  const counterReads = (result.peripheralEvents ?? []).filter((event): event is TimerCounterReadEvent => event.kind === 'timer-counter-read');
  if (inputEvents.length !== plan.length || counterReads.length !== 1
    || result.peripheralEvents?.length !== plan.length + 1) return undefined;
  for (let index = 0; index < plan.length; index += 1) {
    const event = inputEvents[index];
    const expected = plan[index];
    if (event.controller !== 'GPIOD' || event.port !== 'D' || event.bit !== 5 || event.pinAlias !== 'D5'
      || event.initialLevel !== 0 || event.previousLevel !== (index % 2 === 0 ? 0 : 1)
      || event.level !== expected.level || event.sequenceIndex !== index
      || event.detentIndex != null || event.phaseIndex != null
      || event.requestedCycle !== expected.requestedCycle || event.appliedCycle !== expected.appliedCycle
      || event.delivery !== 'avr8js-setPin-clock-event') return undefined;
  }
  const counterRead = counterReads[0];
  const lastAppliedCycle = inputEvents.at(-1)!.appliedCycle;
  if (counterRead.controller !== 'TIMER1' || counterRead.counter !== 'TCNT1'
    || counterRead.pinAlias !== 'D5' || counterRead.edge !== 'rising'
    || counterRead.counterValue !== normalized.timer1_pulse_count
    || counterRead.readCycle !== TIMER1_COUNTER_READ_CYCLE || counterRead.readCycle <= lastAppliedCycle
    || counterRead.clockSelect !== 7 || counterRead.delivery !== 'avr8js-timer1-tcnt-read-hook') return undefined;
  const completion = exactTrace(result, 'D6', 6);
  const threshold = exactTrace(result, 'D7', 7);
  if (!completion || !threshold) return undefined;
  const thresholdReached = normalized.timer1_pulse_count >= TIMER1_PULSE_THRESHOLD;
  const completionTransitions = completion.timing!.sampleCycles.slice(0, -1);
  const thresholdTransitions = threshold.timing!.sampleCycles.slice(0, -1);
  const completionValues = completion.v.slice(0, -1);
  const thresholdValues = threshold.v.slice(0, -1);
  if (completionTransitions.length !== 3 || completionTransitions[0] !== 0 || completionTransitions[1] !== 3
    || completionValues.join(',') !== '1,0,1'
    || thresholdTransitions[0] !== 0 || thresholdTransitions[1] !== 3
    || thresholdValues[0] !== 1 || thresholdValues[1] !== 0
    || completion.timing!.sampleCycles.at(-1) !== threshold.timing!.sampleCycles.at(-1)
    || completion.timing!.sampleCycles.at(-1)! < completionTransitions[2]) return undefined;
  const readCompleteCycle = completionTransitions[2];
  let thresholdCycle: number | undefined;
  if (thresholdReached) {
    if (thresholdTransitions.length !== 3 || thresholdValues.join(',') !== '1,0,1'
      || thresholdTransitions[2] !== TIMER1_THRESHOLD_CYCLE
      || readCompleteCycle !== TIMER1_READ_COMPLETE_CYCLE_AT_OR_ABOVE_THRESHOLD) return undefined;
    thresholdCycle = thresholdTransitions[2];
  } else if (thresholdTransitions.length !== 2 || thresholdValues.join(',') !== '1,0'
    || readCompleteCycle !== TIMER1_READ_COMPLETE_CYCLE_BELOW_THRESHOLD) return undefined;
  const risingEdges = inputEvents
    .filter((event) => event.level === 1)
    .map((event, index) => ({ requestedCycle: event.requestedCycle, appliedCycle: event.appliedCycle, count: index + 1 }));
  return {
    requestedPulseCount: normalized.timer1_pulse_count,
    countedPulseCount: counterRead.counterValue,
    readCycle: counterRead.readCycle,
    readCompleteCycle,
    thresholdReached,
    ...(thresholdCycle == null ? {} : { thresholdCycle }),
    inputPin: 'D5', completionPin: 'D6', thresholdPin: 'D7',
    controller: 'TIMER1', counter: 'TCNT1', edge: 'rising', risingEdges,
  };
}
