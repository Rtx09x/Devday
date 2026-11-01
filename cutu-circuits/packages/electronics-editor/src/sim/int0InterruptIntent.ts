import { AVR_INT0_INTERRUPT_INTENT_SHA256 } from './generated/avrInt0InterruptIntent.ts';
import { isAvrInt0InterruptStimulus, normalizeFixtureStimulus } from './fixtureStimulus.ts';
import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';

type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;
type ExternalInterruptEvent = Extract<PeripheralEvent, { kind: 'external-interrupt-entered' }>;

export interface Int0InterruptIntentEvidence {
  requestedCycle: number;
  appliedCycle: number;
  entryCycle: number;
  armedLowCycle: number;
  observedHighCycle: number;
  vectorWordAddress: 2;
  inputPin: 'D2';
  armedPin: 'D5';
  observedPin: 'D6';
  edge: 'falling';
}

function exactTrace(result: SimResult, name: 'D5' | 'D6', bit: 5 | 6): SimTrace | undefined {
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

export function canonicalExternalInterrupt(evidence: Pick<Int0InterruptIntentEvidence, 'requestedCycle' | 'appliedCycle' | 'entryCycle'>): string {
  return `D2:1>0@${evidence.requestedCycle}/${evidence.appliedCycle} INT0:v2@${evidence.entryCycle}`;
}

export function deriveInt0InterruptIntentEvidence(result: SimResult | null | undefined): Int0InterruptIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.mode !== 'mcu'
    || result.firmwareFixture?.id !== 'avr-int0-interrupt-intent'
    || result.firmwareFixture.sha256 !== AVR_INT0_INTERRUPT_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-int0-interrupt-intent.asm'
    || (result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  let normalized;
  try {
    normalized = normalizeFixtureStimulus('avr-int0-interrupt-intent', result.modeledStimulus);
  } catch {
    return undefined;
  }
  if (!isAvrInt0InterruptStimulus(normalized)) return undefined;
  const inputEvents = (result.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected');
  const interruptEvents = (result.peripheralEvents ?? []).filter((event): event is ExternalInterruptEvent => event.kind === 'external-interrupt-entered');
  if (inputEvents.length !== 1 || interruptEvents.length !== 1 || result.peripheralEvents?.length !== 2) return undefined;
  const [input] = inputEvents;
  const [interrupt] = interruptEvents;
  const expectedApplied = normalized.int0_falling_cycle + (normalized.int0_falling_cycle % 2 === 0 ? 1 : 0);
  if (input.controller !== 'GPIOD' || input.port !== 'D' || input.bit !== 2 || input.pinAlias !== 'D2'
    || input.initialLevel !== 1 || input.previousLevel !== 1 || input.level !== 0 || input.sequenceIndex !== 0
    || input.detentIndex != null || input.phaseIndex != null
    || input.requestedCycle !== normalized.int0_falling_cycle || input.appliedCycle !== expectedApplied
    || input.delivery !== 'avr8js-setPin-clock-event'
    || interrupt.controller !== 'INT0' || interrupt.pinAlias !== 'D2' || interrupt.edge !== 'falling'
    || interrupt.vectorWordAddress !== 2 || interrupt.inputRequestedCycle !== input.requestedCycle
    || interrupt.inputAppliedCycle !== input.appliedCycle || interrupt.entryCycle !== input.appliedCycle + 2
    || interrupt.delivery !== 'avr8js-gpio-external-interrupt') return undefined;
  const armed = exactTrace(result, 'D5', 5);
  const observed = exactTrace(result, 'D6', 6);
  const armedLowCycle = interrupt.entryCycle + 2;
  const observedHighCycle = interrupt.entryCycle + 3;
  if (!armed || !observed
    || armed.timing!.sampleCycles.length !== 5
    || armed.timing!.sampleCycles.slice(0, 4).join(',') !== `0,7,9,${armedLowCycle}`
    || armed.v.join(',') !== '1,0,1,0,0'
    || observed.timing!.sampleCycles.length !== 4
    || observed.timing!.sampleCycles.slice(0, 3).join(',') !== `0,7,${observedHighCycle}`
    || observed.v.join(',') !== '1,0,1,1'
    || armed.timing!.sampleCycles.at(-1) !== observed.timing!.sampleCycles.at(-1)
    || observed.timing!.sampleCycles.at(-1)! < observedHighCycle) return undefined;
  return {
    requestedCycle: input.requestedCycle,
    appliedCycle: input.appliedCycle,
    entryCycle: interrupt.entryCycle,
    armedLowCycle,
    observedHighCycle,
    vectorWordAddress: 2,
    inputPin: 'D2', armedPin: 'D5', observedPin: 'D6', edge: 'falling',
  };
}
