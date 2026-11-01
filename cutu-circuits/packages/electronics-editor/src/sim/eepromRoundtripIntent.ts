import type { PeripheralEvent, SimResult, SimTrace } from './types.ts';
import { AVR_EEPROM_ROUNDTRIP_INTENT_SHA256 } from './generated/avrEepromRoundtripIntent.ts';

type EepromWrite = Extract<PeripheralEvent, { kind: 'eeprom-write' }>;
type EepromRead = Extract<PeripheralEvent, { kind: 'eeprom-read' }>;

export const AVR_EEPROM_ADDRESS = 0x0010;
export const AVR_EEPROM_VALUE = 0x5a;
export const AVR_EEPROM_WRITE_REQUEST_CYCLE = 13;
export const AVR_EEPROM_READY_CYCLE = 57_613;
export const AVR_EEPROM_READ_CYCLE = 57_620;
export const AVR_EEPROM_SUCCESS_CYCLE = 57_628;

export interface EepromRoundtripIntentEvidence {
  address: number;
  value: number;
  writeRequestCycle: number;
  writeReadyCycle: number;
  readCycle: number;
  successCycle: number;
  successPin: 'D6';
  failurePin: 'D5';
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

export function canonicalEepromRoundtrip(evidence: Pick<EepromRoundtripIntentEvidence, 'address' | 'value'>): string {
  return `${evidence.address.toString(16).padStart(4, '0')}:${evidence.value.toString(16).padStart(2, '0')}`;
}

export function deriveEepromRoundtripIntentEvidence(result: SimResult | null | undefined): EepromRoundtripIntentEvidence | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.mode !== 'mcu'
    || result.firmwareFixture?.id !== 'avr-eeprom-roundtrip-intent'
    || result.firmwareFixture.sha256 !== AVR_EEPROM_ROUNDTRIP_INTENT_SHA256
    || result.firmwareFixture.sourcePath !== 'examples/firmware/avr-eeprom-roundtrip-intent.asm'
    || (result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  const writes = (result.peripheralEvents ?? []).filter((event): event is EepromWrite => event.kind === 'eeprom-write');
  const reads = (result.peripheralEvents ?? []).filter((event): event is EepromRead => event.kind === 'eeprom-read');
  if (writes.length !== 1 || reads.length !== 1 || (result.peripheralEvents?.length ?? 0) !== 2) return undefined;
  const [write] = writes;
  const [read] = reads;
  if (write.controller !== 'EEPROM' || write.address !== AVR_EEPROM_ADDRESS || write.value !== AVR_EEPROM_VALUE
    || write.requestCycle !== AVR_EEPROM_WRITE_REQUEST_CYCLE || write.readyCycle !== AVR_EEPROM_READY_CYCLE
    || write.mode !== 'erase-and-write' || write.delivery !== 'avr8js-eeprom-memory-backend'
    || read.controller !== 'EEPROM' || read.address !== AVR_EEPROM_ADDRESS || read.value !== AVR_EEPROM_VALUE
    || read.readCycle !== AVR_EEPROM_READ_CYCLE || read.delivery !== 'avr8js-eeprom-memory-backend'
    || read.readCycle <= write.readyCycle) return undefined;
  const failure = exactTrace(result, 'D5', 5);
  const success = exactTrace(result, 'D6', 6);
  if (!failure || !success
    || failure.timing!.sampleCycles.length !== 3
    || failure.timing!.sampleCycles[0] !== 0
    || failure.timing!.sampleCycles[1] !== 1
    || failure.v.join(',') !== '1,0,0'
    || success.timing!.sampleCycles.length !== 4
    || success.timing!.sampleCycles.slice(0, 3).join(',') !== `0,1,${AVR_EEPROM_SUCCESS_CYCLE}`
    || success.v.join(',') !== '1,0,1,1'
    || failure.timing!.sampleCycles.at(-1) !== success.timing!.sampleCycles.at(-1)
    || success.timing!.sampleCycles.at(-1)! < AVR_EEPROM_SUCCESS_CYCLE) return undefined;
  return {
    address: write.address,
    value: write.value,
    writeRequestCycle: write.requestCycle,
    writeReadyCycle: write.readyCycle,
    readCycle: read.readCycle,
    successCycle: AVR_EEPROM_SUCCESS_CYCLE,
    successPin: 'D6',
    failurePin: 'D5',
  };
}
