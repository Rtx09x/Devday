import {
  AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  isAvrQuadratureDetentStimulus,
  normalizeFixtureStimulus,
} from './fixtureStimulus.ts';
import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';

type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;

export const AVR_QUADRATURE_PHASE_CYCLES = [800, 1600, 2400, 3200] as const;

export interface QuadraturePhasePlan {
  pinAlias: 'D2' | 'D3';
  bit: 2 | 3;
  previousLevel: 0 | 1;
  level: 0 | 1;
  requestedCycle: number;
  detentIndex: 0;
  phaseIndex: number;
}

export interface QuadratureDetentEvidence {
  direction: 'CW' | 'CCW';
  directionValue: 1 | -1;
  inputStateSequence: '11→10→00→01→11' | '11→01→00→10→11';
  inputEvents: GpioInputEvent[];
  directionLatchTrace: 'D5';
  completionLatchTrace: 'D6';
  directionLatchLevel: 0 | 1;
  completionLatchLevel: 1;
  directionTransitions: Array<{ cycle: number; level: 0 | 1 }>;
  completionTransitions: Array<{ cycle: number; level: 0 | 1 }>;
  completionCycle: number;
  clockHz: 16_000_000;
}

export function quadraturePhasePlan(direction: 1 | -1): QuadraturePhasePlan[] {
  const cw = direction === 1;
  const aliases: Array<'D2' | 'D3'> = cw ? ['D2', 'D3', 'D2', 'D3'] : ['D3', 'D2', 'D3', 'D2'];
  return aliases.map((pinAlias, phaseIndex) => ({
    pinAlias,
    bit: pinAlias === 'D2' ? 2 : 3,
    previousLevel: phaseIndex < 2 ? 1 : 0,
    level: phaseIndex < 2 ? 0 : 1,
    requestedCycle: AVR_QUADRATURE_PHASE_CYCLES[phaseIndex],
    detentIndex: 0,
    phaseIndex,
  }));
}

function exactDigitalTrace(result: SimResult, name: 'D5' | 'D6', bit: 5 | 6): SimTrace | undefined {
  const matches = result.traces.filter((trace) => trace.name === name
    && trace.unit === 'digital'
    && trace.origin?.family === 'avr'
    && trace.origin.port === 'D'
    && trace.origin.bit === bit
    && trace.timing?.domain === 'emulator-cycles'
    && trace.timing.clockHz === AVR_LIMIT_INTERLOCK_CLOCK_HZ
    && trace.t.length === trace.v.length
    && trace.timing.sampleCycles.length === trace.v.length
    && trace.v.length >= 2
    && trace.v.every((value) => value === 0 || value === 1)
    && trace.t.every((value, index) => Number.isFinite(value) && value >= 0
      && (index === 0 || value > trace.t[index - 1]))
    && trace.timing.sampleCycles.every((cycle, index) => Number.isSafeInteger(cycle) && cycle >= 0
      && (index === 0 || cycle > trace.timing!.sampleCycles[index - 1])));
  return matches.length === 1 ? matches[0] : undefined;
}

function traceTransitions(trace: SimTrace): Array<{ cycle: number; level: 0 | 1 }> {
  const output: Array<{ cycle: number; level: 0 | 1 }> = [];
  for (let index = 1; index < trace.v.length; index += 1) {
    if (trace.v[index] === trace.v[index - 1]) continue;
    output.push({ cycle: trace.timing!.sampleCycles[index], level: trace.v[index] as 0 | 1 });
  }
  return output;
}

function sameTransitions(
  actual: readonly { cycle: number; level: 0 | 1 }[],
  expected: readonly { cycle: number; level: 0 | 1 }[],
): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry.cycle === expected[index].cycle && entry.level === expected[index].level);
}

/**
 * Derive one exact fixture-scoped clean quadrature phase sequence and the two
 * firmware latches. This is not a general encoder or physical-motion claim.
 */
export function deriveQuadratureDetentEvidence(result: SimResult | null | undefined): QuadratureDetentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.firmwareFixture?.id !== 'avr-quadrature-detent-intent') return undefined;
  if ((result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  let normalized;
  try {
    normalized = normalizeFixtureStimulus('avr-quadrature-detent-intent', result.modeledStimulus);
  } catch {
    return undefined;
  }
  if (!isAvrQuadratureDetentStimulus(normalized)) return undefined;
  const direction = normalized.encoder_direction;
  const plan = quadraturePhasePlan(direction);
  const inputEvents = (result.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected');
  if (inputEvents.length !== plan.length) return undefined;
  if (!inputEvents.every((event, index) => {
    const expected = plan[index];
    return event.controller === 'GPIOD' && event.port === 'D'
      && event.bit === expected.bit && event.pinAlias === expected.pinAlias
      && event.initialLevel === 1 && event.previousLevel === expected.previousLevel
      && event.level === expected.level && event.sequenceIndex === index
      && event.detentIndex === 0 && event.phaseIndex === index
      && event.requestedCycle === expected.requestedCycle
      && event.appliedCycle === expected.requestedCycle
      && event.delivery === 'avr8js-setPin-clock-event';
  })) return undefined;

  const directionTrace = exactDigitalTrace(result, 'D5', 5);
  const completionTrace = exactDigitalTrace(result, 'D6', 6);
  if (!directionTrace || !completionTrace) return undefined;
  const directionTransitions = traceTransitions(directionTrace);
  const completionTransitions = traceTransitions(completionTrace);
  const expectedDirection = direction === 1
    ? [{ cycle: 1, level: 0 as const }, { cycle: 805, level: 1 as const }]
    : [{ cycle: 1, level: 0 as const }];
  const expectedCompletion = [
    { cycle: 1, level: 0 as const },
    { cycle: direction === 1 ? 3206 : 3204, level: 1 as const },
  ];
  if (!sameTransitions(directionTransitions, expectedDirection)
    || !sameTransitions(completionTransitions, expectedCompletion)
    || directionTrace.v.at(-1) !== (direction === 1 ? 1 : 0)
    || completionTrace.v.at(-1) !== 1) return undefined;
  return {
    direction: direction === 1 ? 'CW' : 'CCW',
    directionValue: direction,
    inputStateSequence: direction === 1 ? '11→10→00→01→11' : '11→01→00→10→11',
    inputEvents,
    directionLatchTrace: 'D5', completionLatchTrace: 'D6',
    directionLatchLevel: direction === 1 ? 1 : 0,
    completionLatchLevel: 1,
    directionTransitions,
    completionTransitions,
    completionCycle: expectedCompletion[1].cycle,
    clockHz: AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  };
}

export function canonicalGpioInputEventCycles(events: readonly GpioInputEvent[]): string {
  return events.map((event) => `${event.pinAlias}:${event.previousLevel}>${event.level}@${event.requestedCycle}/${event.appliedCycle}`).join(' ');
}
