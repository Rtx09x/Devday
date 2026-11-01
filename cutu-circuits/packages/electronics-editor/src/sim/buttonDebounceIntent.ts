import {
  AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  isAvrButtonDebounceStimulus,
  normalizeFixtureStimulus,
} from './fixtureStimulus.ts';
import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';
import { canonicalTransitionCycles, type DigitalTransitionCycle } from './limitInterlockIntent.ts';

type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;

export interface ButtonInputPhase {
  level: 0 | 1;
  requestedCycle: number;
}

export interface ButtonDebounceEvidence {
  profile: 'clean' | 'bouncy';
  inputTrace: 'D7';
  acceptedTrace: 'D4';
  bounceSeenTrace: 'D5';
  inputEvents: GpioInputEvent[];
  inputStateSequence: string;
  acceptedCycle: number;
  responseCycles: number;
  bounceObserved: boolean;
  bounceObservedCycle?: number;
  acceptedTransitions: DigitalTransitionCycle[];
  bounceSeenTransitions: DigitalTransitionCycle[];
  clockHz: 16_000_000;
}

const CLEAN_PLAN: readonly ButtonInputPhase[] = [
  { level: 0, requestedCycle: 2_000 },
];

const BOUNCY_PLAN: readonly ButtonInputPhase[] = [
  { level: 0, requestedCycle: 2_000 },
  { level: 1, requestedCycle: 2_400 },
  { level: 0, requestedCycle: 2_800 },
  { level: 1, requestedCycle: 3_200 },
  { level: 0, requestedCycle: 3_600 },
];

export function buttonDebouncePlan(buttonBounce: 0 | 1): readonly ButtonInputPhase[] {
  return buttonBounce === 0 ? CLEAN_PLAN : BOUNCY_PLAN;
}

function exactDigitalTrace(result: SimResult, name: 'D4' | 'D5', bit: 4 | 5): SimTrace | undefined {
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
    && trace.timing.sampleCycles.every((cycle, index) => Number.isSafeInteger(cycle) && cycle >= 0
      && (index === 0 || cycle > trace.timing!.sampleCycles[index - 1])));
  return matches.length === 1 ? matches[0] : undefined;
}

function transitions(trace: SimTrace): DigitalTransitionCycle[] {
  const output: DigitalTransitionCycle[] = [];
  for (let index = 1; index < trace.v.length; index += 1) {
    if (trace.v[index] !== trace.v[index - 1]) {
      output.push({ cycle: trace.timing!.sampleCycles[index], level: trace.v[index] as 0 | 1 });
    }
  }
  return output;
}

export function canonicalButtonInputEvents(events: readonly GpioInputEvent[]): string {
  return events.map((event) => `${event.pinAlias}:${event.previousLevel}>${event.level}@${event.requestedCycle}/${event.appliedCycle}`).join(' ');
}

/**
 * Derive exact fixture-scoped scheduled-input and polling debounce intent.
 * The bounded transition profile is emulator stimulus, never a contact model.
 */
export function deriveButtonDebounceEvidence(result: SimResult | null | undefined): ButtonDebounceEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.firmwareFixture?.id !== 'avr-button-debounce-intent') return undefined;
  if ((result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  let normalized;
  try {
    normalized = normalizeFixtureStimulus('avr-button-debounce-intent', result.modeledStimulus);
  } catch {
    return undefined;
  }
  if (!isAvrButtonDebounceStimulus(normalized)) return undefined;
  const plan = buttonDebouncePlan(normalized.button_bounce);
  const inputEvents = (result.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected');
  if (inputEvents.length !== plan.length) return undefined;
  let previousLevel: 0 | 1 = 1;
  for (let index = 0; index < plan.length; index += 1) {
    const expected = plan[index];
    const event = inputEvents[index];
    const expectedAppliedCycle = index === 0 ? expected.requestedCycle + 1 : expected.requestedCycle;
    if (event.controller !== 'GPIOD' || event.port !== 'D' || event.bit !== 7 || event.pinAlias !== 'D7'
      || event.initialLevel !== 1 || event.previousLevel !== previousLevel || event.level !== expected.level
      || event.sequenceIndex !== index || event.detentIndex != null || event.phaseIndex != null
      || event.requestedCycle !== expected.requestedCycle || event.appliedCycle !== expectedAppliedCycle
      || event.delivery !== 'avr8js-setPin-clock-event') return undefined;
    previousLevel = expected.level;
  }

  const accepted = exactDigitalTrace(result, 'D4', 4);
  const bounceSeen = exactDigitalTrace(result, 'D5', 5);
  if (!accepted || !bounceSeen || accepted.v.at(-1) !== 1) return undefined;
  const acceptedTransitions = transitions(accepted);
  const bounceSeenTransitions = transitions(bounceSeen);
  const acceptedRises = acceptedTransitions.filter((transition) => transition.level === 1 && transition.cycle > 1);
  const bounceRises = bounceSeenTransitions.filter((transition) => transition.level === 1 && transition.cycle > 1);
  const expectedAcceptedCycle = normalized.button_bounce === 0 ? 2_579 : 4_180;
  const expectedBounceCycle = normalized.button_bounce === 0 ? undefined : 2_405;
  if (acceptedRises.length !== 1 || acceptedRises[0].cycle !== expectedAcceptedCycle
    || bounceRises.length !== (normalized.button_bounce === 0 ? 0 : 1)
    || bounceRises[0]?.cycle !== expectedBounceCycle
    || bounceSeen.v.at(-1) !== normalized.button_bounce) return undefined;
  const finalInput = inputEvents.at(-1)!;
  if (acceptedRises[0].cycle <= finalInput.appliedCycle) return undefined;

  return {
    profile: normalized.button_bounce === 0 ? 'clean' : 'bouncy',
    inputTrace: 'D7', acceptedTrace: 'D4', bounceSeenTrace: 'D5',
    inputEvents: inputEvents.map((event) => ({ ...event })),
    inputStateSequence: [1, ...plan.map((phase) => phase.level)].join('→'),
    acceptedCycle: acceptedRises[0].cycle,
    responseCycles: acceptedRises[0].cycle - finalInput.appliedCycle,
    bounceObserved: normalized.button_bounce === 1,
    ...(expectedBounceCycle == null ? {} : { bounceObservedCycle: expectedBounceCycle }),
    acceptedTransitions,
    bounceSeenTransitions,
    clockHz: AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  };
}

export { canonicalTransitionCycles };
