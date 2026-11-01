import {
  AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  isAvrLimitInterlockStimulus,
  normalizeFixtureStimulus,
} from './fixtureStimulus.ts';
import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';

type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;

export interface DigitalTransitionCycle {
  cycle: number;
  level: 0 | 1;
}

export interface LimitInterlockEvidence {
  inputTrace: 'D7';
  stepTrace: 'D2';
  enableTrace: 'D4';
  requestedCycle: number;
  appliedCycle: number;
  reactionCycle: number;
  responseCycles: number;
  stepTransitions: DigitalTransitionCycle[];
  enableTransitions: DigitalTransitionCycle[];
  finalStepLevel: 0;
  finalEnableActiveLowLevel: 1;
  clockHz: 16_000_000;
}

function exactDigitalTrace(result: SimResult, name: 'D2' | 'D4', bit: 2 | 4): SimTrace | undefined {
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

function transitions(trace: SimTrace): DigitalTransitionCycle[] {
  const output: DigitalTransitionCycle[] = [];
  for (let index = 1; index < trace.v.length; index += 1) {
    if (trace.v[index] === trace.v[index - 1]) continue;
    output.push({ cycle: trace.timing!.sampleCycles[index], level: trace.v[index] as 0 | 1 });
  }
  return output;
}

/**
 * Derive exact fixture-scoped polling/interlock evidence. This represents one
 * scheduled avr8js input and firmware GPIO intent, never switch or motor safety.
 */
export function deriveLimitInterlockEvidence(result: SimResult | null | undefined): LimitInterlockEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.firmwareFixture?.id !== 'avr-limit-interlock-intent') return undefined;
  if ((result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  let normalized;
  try {
    normalized = normalizeFixtureStimulus('avr-limit-interlock-intent', result.modeledStimulus);
  } catch {
    return undefined;
  }
  if (!isAvrLimitInterlockStimulus(normalized)) return undefined;
  const requestedCycle = normalized.limit_trip_ms * (AVR_LIMIT_INTERLOCK_CLOCK_HZ / 1000);
  if (!Number.isSafeInteger(requestedCycle)) return undefined;
  const inputEvents = (result.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected');
  if (inputEvents.length !== 1) return undefined;
  const input = inputEvents[0];
  if (input.controller !== 'GPIOD' || input.port !== 'D' || input.bit !== 7 || input.pinAlias !== 'D7'
    || input.initialLevel !== 1 || input.previousLevel !== 1 || input.level !== 0 || input.sequenceIndex !== 0
    || input.detentIndex != null || input.phaseIndex != null || input.requestedCycle !== requestedCycle
    || input.appliedCycle !== requestedCycle + 1 || input.delivery !== 'avr8js-setPin-clock-event') return undefined;

  const step = exactDigitalTrace(result, 'D2', 2);
  const enable = exactDigitalTrace(result, 'D4', 4);
  if (!step || !enable || step.v.at(-1) !== 0 || enable.v.at(-1) !== 1) return undefined;
  const stepTransitions = transitions(step);
  const enableTransitions = transitions(enable);
  const enableRises = enableTransitions.filter((transition) => transition.level === 1 && transition.cycle > input.appliedCycle);
  if (enableRises.length !== 1) return undefined;
  const reactionCycle = enableRises[0].cycle;
  if (stepTransitions.some((transition) => transition.level === 1 && transition.cycle > input.appliedCycle)
    || stepTransitions.some((transition) => transition.cycle > reactionCycle)) return undefined;
  return {
    inputTrace: 'D7', stepTrace: 'D2', enableTrace: 'D4',
    requestedCycle: input.requestedCycle, appliedCycle: input.appliedCycle,
    reactionCycle, responseCycles: reactionCycle - input.appliedCycle,
    stepTransitions, enableTransitions,
    finalStepLevel: 0, finalEnableActiveLowLevel: 1,
    clockHz: AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  };
}

export function canonicalTransitionCycles(values: readonly DigitalTransitionCycle[]): string {
  return values.map(({ cycle, level }) => `${cycle}:${level}`).join(' ');
}
