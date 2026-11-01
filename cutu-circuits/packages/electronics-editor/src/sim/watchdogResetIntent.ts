import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';
import { AVR_WATCHDOG_RESET_INTENT_SHA256 } from './generated/avrWatchdogResetIntent.ts';

type WatchdogReset = Extract<PeripheralEvent, { kind: 'watchdog-reset' }>;

export const AVR_WATCHDOG_RESET_CYCLE = 256_015;
export const AVR_WATCHDOG_MCUSR_READ_CYCLE = 256_016;
export const AVR_WATCHDOG_MCUSR_VALUE = 0x08;
export const AVR_WATCHDOG_ARMED_HIGH_CYCLE = 7;
export const AVR_WATCHDOG_ARMED_LOW_CYCLE = 256_021;
export const AVR_WATCHDOG_SUCCESS_CYCLE = 256_022;

export interface WatchdogResetIntentEvidence {
  resetCycle: number;
  mcusrReadCycle: number;
  mcusrValue: number;
  watchdogClockHz: 128_000;
  prescaler: 2_048;
  armedHighCycle: number;
  armedLowCycle: number;
  successCycle: number;
  armedPin: 'D5';
  successPin: 'D6';
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

export function canonicalWatchdogReset(evidence: Pick<WatchdogResetIntentEvidence, 'resetCycle' | 'mcusrValue'>): string {
  return `${evidence.resetCycle}:${evidence.mcusrValue.toString(16).padStart(2, '0')}`;
}

export function deriveWatchdogResetIntentEvidence(result: SimResult | null | undefined): WatchdogResetIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.mode !== 'mcu'
    || result.firmwareFixture?.id !== 'avr-watchdog-reset-intent'
    || result.firmwareFixture.sha256 !== AVR_WATCHDOG_RESET_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-watchdog-reset-intent.asm'
    || (result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  const resets = (result.peripheralEvents ?? []).filter((event): event is WatchdogReset => event.kind === 'watchdog-reset');
  if (resets.length !== 1 || (result.peripheralEvents?.length ?? 0) !== 1) return undefined;
  const [reset] = resets;
  if (reset.controller !== 'WDT'
    || reset.resetCycle !== AVR_WATCHDOG_RESET_CYCLE
    || reset.mcusrReadCycle !== AVR_WATCHDOG_MCUSR_READ_CYCLE
    || reset.mcusrValue !== AVR_WATCHDOG_MCUSR_VALUE
    || reset.watchdogClockHz !== 128_000
    || reset.prescaler !== 2_048
    || reset.mode !== 'system-reset'
    || reset.delivery !== 'avr8js-watchdog-timeout') return undefined;
  const armed = exactTrace(result, 'D5', 5);
  const success = exactTrace(result, 'D6', 6);
  if (!armed || !success
    || armed.timing!.sampleCycles.length !== 5
    || armed.timing!.sampleCycles.slice(0, 4).join(',') !== `0,6,${AVR_WATCHDOG_ARMED_HIGH_CYCLE},${AVR_WATCHDOG_ARMED_LOW_CYCLE}`
    || armed.v.join(',') !== '1,0,1,0,0'
    || success.timing!.sampleCycles.length !== 4
    || success.timing!.sampleCycles.slice(0, 3).join(',') !== `0,6,${AVR_WATCHDOG_SUCCESS_CYCLE}`
    || success.v.join(',') !== '1,0,1,1'
    || armed.timing!.sampleCycles.at(-1) !== success.timing!.sampleCycles.at(-1)
    || success.timing!.sampleCycles.at(-1)! < AVR_WATCHDOG_SUCCESS_CYCLE) return undefined;
  return {
    resetCycle: reset.resetCycle,
    mcusrReadCycle: reset.mcusrReadCycle,
    mcusrValue: reset.mcusrValue,
    watchdogClockHz: reset.watchdogClockHz,
    prescaler: reset.prescaler,
    armedHighCycle: AVR_WATCHDOG_ARMED_HIGH_CYCLE,
    armedLowCycle: AVR_WATCHDOG_ARMED_LOW_CYCLE,
    successCycle: AVR_WATCHDOG_SUCCESS_CYCLE,
    armedPin: 'D5',
    successPin: 'D6',
  };
}
