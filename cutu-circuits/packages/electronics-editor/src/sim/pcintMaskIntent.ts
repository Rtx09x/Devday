import { AVR_PCINT_MASK_INTENT_SHA256 } from './generated/avrPcintMaskIntent.ts';
import { isAvrPcintMaskStimulus, normalizeFixtureStimulus } from './fixtureStimulus.ts';
import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';

type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;
type PcintEvent = Extract<PeripheralEvent, { kind: 'external-interrupt-entered'; controller: 'PCINT2' }>;

export const PCINT_MASKED_D7_REQUESTED_CYCLE = 1_000;
export const PCINT_MASKED_D7_APPLIED_CYCLE = 1_000;
export const PCINT_ENABLED_D4_REQUESTED_CYCLE = 2_000;
export const PCINT_ENABLED_D4_APPLIED_CYCLE = 2_000;
export const PCINT2_ENTRY_CYCLE = 2_002;
export const PCINT2_ARMED_LOW_CYCLE = 2_004;
export const PCINT2_OBSERVED_HIGH_CYCLE = 2_005;

export interface PcintMaskIntentEvidence {
  profile: 0 | 1;
  maskRegister: 'PCMSK2';
  maskValue: 0x10;
  controller: 'PCINT2';
  vectorWordAddress: 10;
  maskedInput: { pin: 'D7'; requestedCycle: number; appliedCycle: number };
  enabledInput?: { pin: 'D4'; requestedCycle: number; appliedCycle: number };
  entryCycle?: number;
  armedLowCycle?: number;
  observedHighCycle?: number;
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

export function canonicalPcintMask(evidence: PcintMaskIntentEvidence): string {
  const masked = `D7:0>1@${evidence.maskedInput.requestedCycle}/${evidence.maskedInput.appliedCycle} MASKED`;
  if (!evidence.enabledInput) return `${masked} PCINT2:none PCMSK2=10`;
  return `${masked};D4:0>1@${evidence.enabledInput.requestedCycle}/${evidence.enabledInput.appliedCycle} ENABLED PCINT2:v10@${evidence.entryCycle} PCMSK2=10`;
}

export function derivePcintMaskIntentEvidence(result: SimResult | null | undefined): PcintMaskIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.mode !== 'mcu'
    || result.firmwareFixture?.id !== 'avr-pcint-mask-intent'
    || result.firmwareFixture.sha256 !== AVR_PCINT_MASK_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-pcint-mask-intent.asm'
    || (result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  let normalized;
  try {
    normalized = normalizeFixtureStimulus('avr-pcint-mask-intent', result.modeledStimulus);
  } catch {
    return undefined;
  }
  if (!isAvrPcintMaskStimulus(normalized)) return undefined;
  const inputs = (result.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected');
  const entries = (result.peripheralEvents ?? []).filter((event): event is PcintEvent => event.kind === 'external-interrupt-entered' && event.controller === 'PCINT2');
  const expectedInputCount = normalized.pcint_profile === 1 ? 2 : 1;
  if (inputs.length !== expectedInputCount || entries.length !== normalized.pcint_profile
    || result.peripheralEvents?.length !== expectedInputCount + normalized.pcint_profile) return undefined;
  const masked = inputs[0];
  if (masked.controller !== 'GPIOD' || masked.port !== 'D' || masked.bit !== 7 || masked.pinAlias !== 'D7'
    || masked.initialLevel !== 0 || masked.previousLevel !== 0 || masked.level !== 1 || masked.sequenceIndex !== 0
    || masked.detentIndex != null || masked.phaseIndex != null
    || masked.requestedCycle !== PCINT_MASKED_D7_REQUESTED_CYCLE
    || masked.appliedCycle !== PCINT_MASKED_D7_APPLIED_CYCLE
    || masked.delivery !== 'avr8js-setPin-clock-event') return undefined;
  const armed = exactTrace(result, 'D5', 5);
  const observed = exactTrace(result, 'D6', 6);
  if (!armed || !observed) return undefined;
  const armedCycles = armed.timing!.sampleCycles.slice(0, -1);
  const observedCycles = observed.timing!.sampleCycles.slice(0, -1);
  const armedValues = armed.v.slice(0, -1);
  const observedValues = observed.v.slice(0, -1);
  if (normalized.pcint_profile === 0) {
    if (armedCycles.join(',') !== '0,7,9' || armedValues.join(',') !== '1,0,1'
      || observedCycles.join(',') !== '0,7' || observedValues.join(',') !== '1,0') return undefined;
    return {
      profile: 0, maskRegister: 'PCMSK2', maskValue: 0x10, controller: 'PCINT2', vectorWordAddress: 10,
      maskedInput: { pin: 'D7', requestedCycle: masked.requestedCycle, appliedCycle: masked.appliedCycle },
    };
  }
  const enabled = inputs[1];
  const entry = entries[0];
  if (enabled.controller !== 'GPIOD' || enabled.port !== 'D' || enabled.bit !== 4 || enabled.pinAlias !== 'D4'
    || enabled.initialLevel !== 0 || enabled.previousLevel !== 0 || enabled.level !== 1 || enabled.sequenceIndex !== 1
    || enabled.detentIndex != null || enabled.phaseIndex != null
    || enabled.requestedCycle !== PCINT_ENABLED_D4_REQUESTED_CYCLE
    || enabled.appliedCycle !== PCINT_ENABLED_D4_APPLIED_CYCLE
    || enabled.delivery !== 'avr8js-setPin-clock-event'
    || entry.pinAlias !== 'D4' || entry.edge !== 'change' || entry.vectorWordAddress !== 10
    || entry.inputRequestedCycle !== enabled.requestedCycle || entry.inputAppliedCycle !== enabled.appliedCycle
    || entry.entryCycle !== PCINT2_ENTRY_CYCLE || entry.delivery !== 'avr8js-gpio-external-interrupt'
    || armedCycles.join(',') !== `0,7,9,${PCINT2_ARMED_LOW_CYCLE}` || armedValues.join(',') !== '1,0,1,0'
    || observedCycles.join(',') !== `0,7,${PCINT2_OBSERVED_HIGH_CYCLE}` || observedValues.join(',') !== '1,0,1') return undefined;
  return {
    profile: 1, maskRegister: 'PCMSK2', maskValue: 0x10, controller: 'PCINT2', vectorWordAddress: 10,
    maskedInput: { pin: 'D7', requestedCycle: masked.requestedCycle, appliedCycle: masked.appliedCycle },
    enabledInput: { pin: 'D4', requestedCycle: enabled.requestedCycle, appliedCycle: enabled.appliedCycle },
    entryCycle: entry.entryCycle, armedLowCycle: PCINT2_ARMED_LOW_CYCLE, observedHighCycle: PCINT2_OBSERVED_HIGH_CYCLE,
  };
}
