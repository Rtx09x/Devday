/**
 * Behavioural test harness
 *
 * Phase 3 asks for "given this sketch, assert the LED blinks at 1Hz"-style
 * checks. We run a simulation (MCU firmware by default) and evaluate a list of
 * assertions against its result -- serial output, GPIO traces, and part state.
 * This runs fully in-renderer against the avr8js/rp2040js emulators we already
 * drive, so the agent can write and run behavioural tests today without a
 * backend. (ESP32/QEMU firmware would route through the backend module once the
 * host exposes renderer->backend RPC.)
 */

import { simulate } from './simulate.ts';
import type { PeripheralEvent, SimContext, SimRequest, SimResult, SimTrace } from './types.ts';
import { measureDigitalTrace } from './digitalTrace.ts';
import { canonicalEepromRoundtrip, deriveEepromRoundtripIntentEvidence } from './eepromRoundtripIntent.ts';
import { canonicalWatchdogReset, deriveWatchdogResetIntentEvidence } from './watchdogResetIntent.ts';
import { canonicalExternalInterrupt, deriveInt0InterruptIntentEvidence } from './int0InterruptIntent.ts';
import { canonicalTimer1ExternalCount, deriveTimer1PulseCounterIntentEvidence } from './timer1PulseCounterIntent.ts';
import { canonicalPcintMask, derivePcintMaskIntentEvidence } from './pcintMaskIntent.ts';
export { measureDigitalTrace, type DigitalTraceMeasurement } from './digitalTrace.ts';

type SpiTransferEvent = Extract<PeripheralEvent, { kind: 'spi-transfer' }>;
type AdcSampleEvent = Extract<PeripheralEvent, { kind: 'adc-sample' }>;
type I2cWriteIntentEvent = Extract<PeripheralEvent, { kind: 'i2c-write-intent' }>;
type UartRxEvent = Extract<PeripheralEvent, { kind: 'uart-rx-injected' }>;
type UartTxEvent = Extract<PeripheralEvent, { kind: 'uart-tx' }>;
type GpioInputEvent = Extract<PeripheralEvent, { kind: 'gpio-input-injected' }>;
type NeoPixelFrameEvent = Extract<PeripheralEvent, { kind: 'neopixel-frame-intent' }>;

export type AssertionType =
  | 'serial_contains'
  | 'serial_matches'
  | 'serial_line_count'
  | 'pin_toggles'
  | 'pin_frequency'
  | 'pin_duty_cycle'
  | 'pin_final'
  | 'pin_transition_cycles_equals'
  | 'gpio_input_event_cycles_equals'
  | 'spi_tx_equals'
  | 'adc_sample_equals'
  | 'i2c_write_intent_equals'
  | 'uart_tx_equals'
  | 'neopixel_frame_intent_equals'
  | 'eeprom_roundtrip_equals'
  | 'watchdog_reset_equals'
  | 'external_interrupt_equals'
  | 'timer_external_count_equals'
  | 'pin_change_interrupt_equals'
  | 'led_on';

export interface Assertion {
  type: AssertionType;
  /** Exact trace name or exact part source-component ID/name; never substring matched. */
  target?: string;
  /** Expected value: substring/regex (serial), number (count/freq/final 0|1). */
  value?: string | number | boolean;
  /** Fractional tolerance for pin_frequency; absolute fraction tolerance for pin_duty_cycle. */
  tolerance?: number;
}

export interface AssertionResult extends Assertion {
  pass: boolean;
  actual: unknown;
  detail: string;
}

export interface TestReport {
  pass: boolean;
  passed: number;
  failed: number;
  engine: string;
  simulatedMs?: number;
  results: AssertionResult[];
  simError?: string;
  firmwareFixture?: SimResult['firmwareFixture'];
  modeledStimulus?: SimResult['modeledStimulus'];
}

export const MAX_TEST_ASSERTIONS = 32;
export const MAX_ASSERTION_TEXT_LENGTH = 256;

const ASSERTION_TYPES = new Set<AssertionType>([
  'serial_contains', 'serial_matches', 'serial_line_count', 'pin_toggles',
  'pin_frequency', 'pin_duty_cycle', 'pin_final', 'led_on',
  'pin_transition_cycles_equals',
  'gpio_input_event_cycles_equals',
  'spi_tx_equals',
  'adc_sample_equals',
  'i2c_write_intent_equals',
  'uart_tx_equals',
  'neopixel_frame_intent_equals',
  'eeprom_roundtrip_equals',
  'watchdog_reset_equals',
  'external_interrupt_equals',
  'timer_external_count_equals',
  'pin_change_interrupt_equals',
]);

export function parseCanonicalHexBytes(value: unknown, field = 'SPI byte sequence'): number[] {
  const text = exactText(value, field);
  if (!/^[0-9a-f]{2}(?: [0-9a-f]{2})*$/.test(text)) {
    throw new Error(`${field} must be canonical lowercase hex bytes separated by single spaces.`);
  }
  return text.split(' ').map((byte) => Number.parseInt(byte, 16));
}

export function parseCanonicalI2cWriteIntent(value: unknown, field = 'I2C write intent'): { address7Bit: number; bytes: number[] } {
  const text = exactText(value, field);
  if (!/^[0-7][0-9a-f]: [0-9a-f]{2}(?: [0-9a-f]{2})*$/.test(text)) {
    throw new Error(`${field} must be a canonical lowercase 7-bit address and bytes, e.g. "3c: 00 ae a6 af".`);
  }
  const [address, byteText] = text.split(': ');
  return { address7Bit: Number.parseInt(address, 16), bytes: byteText.split(' ').map((byte) => Number.parseInt(byte, 16)) };
}

export function parseCanonicalTransitionCycles(value: unknown, field = 'pin transition cycles'): Array<{ cycle: number; level: 0 | 1 }> {
  const text = exactText(value, field);
  if (!/^(?:0|[1-9]\d*):[01](?: (?:0|[1-9]\d*):[01])*$/.test(text)) {
    throw new Error(`${field} must be canonical strictly increasing "cycle:level" tokens, e.g. "1:0 8:1 4107:0".`);
  }
  const parsed = text.split(' ').map((token) => {
    const [cycleText, levelText] = token.split(':');
    return { cycle: Number(cycleText), level: Number(levelText) as 0 | 1 };
  });
  if (parsed.some(({ cycle }, index) => !Number.isSafeInteger(cycle)
    || cycle < 0 || (index > 0 && cycle <= parsed[index - 1].cycle))) {
    throw new Error(`${field} cycles must be safe non-negative integers in strictly increasing order.`);
  }
  if (parsed.some(({ level }, index) => index > 0 && level === parsed[index - 1].level)) {
    throw new Error(`${field} levels must alternate at every recorded transition.`);
  }
  return parsed;
}

export function parseCanonicalGpioInputEventCycles(
  value: unknown,
  field = 'GPIO input event cycles',
): Array<{ pinAlias: string; previousLevel: 0 | 1; level: 0 | 1; requestedCycle: number; appliedCycle: number }> {
  const text = exactText(value, field);
  if (!/^D[0-7]:[01]>[01]@(?:0|[1-9]\d*)\/(?:0|[1-9]\d*)(?: D[0-7]:[01]>[01]@(?:0|[1-9]\d*)\/(?:0|[1-9]\d*))*$/.test(text)) {
    throw new Error(`${field} must be canonical "Dpin:from>to@requested/applied" tokens, e.g. "D2:1>0@800/800 D3:1>0@1600/1600".`);
  }
  const parsed = text.split(' ').map((token) => {
    const match = /^(D[0-7]):([01])>([01])@(\d+)\/(\d+)$/.exec(token)!;
    return {
      pinAlias: match[1], previousLevel: Number(match[2]) as 0 | 1, level: Number(match[3]) as 0 | 1,
      requestedCycle: Number(match[4]), appliedCycle: Number(match[5]),
    };
  });
  if (parsed.length > 16) throw new Error(`${field} must contain at most 16 bounded events.`);
  if (parsed.some((event, index) => event.previousLevel === event.level
    || !Number.isSafeInteger(event.requestedCycle) || !Number.isSafeInteger(event.appliedCycle)
    || event.requestedCycle < 0 || event.appliedCycle < event.requestedCycle
    || (index > 0 && (event.requestedCycle <= parsed[index - 1].requestedCycle
      || event.appliedCycle <= parsed[index - 1].appliedCycle)))) {
    throw new Error(`${field} must contain changing levels and safe globally increasing requested/applied cycles.`);
  }
  return parsed;
}

export function parseCanonicalExternalInterrupt(value: unknown, field = 'external interrupt evidence'): {
  requestedCycle: number; appliedCycle: number; entryCycle: number;
} {
  const text = exactText(value, field);
  const match = /^D2:1>0@(0|[1-9]\d*)\/(0|[1-9]\d*) INT0:v2@(0|[1-9]\d*)$/.exec(text);
  if (!match) {
    throw new Error(`${field} must be canonical "D2:1>0@requested/applied INT0:v2@entry" evidence.`);
  }
  const requestedCycle = Number(match[1]);
  const appliedCycle = Number(match[2]);
  const entryCycle = Number(match[3]);
  if (![requestedCycle, appliedCycle, entryCycle].every(Number.isSafeInteger)
    || appliedCycle < requestedCycle || entryCycle <= appliedCycle) {
    throw new Error(`${field} cycles must be safe and ordered requested <= applied < entry.`);
  }
  return { requestedCycle, appliedCycle, entryCycle };
}

export function parseCanonicalTimerExternalCount(value: unknown, field = 'Timer external-count evidence'): {
  count: number; readCycle: number;
} {
  const text = exactText(value, field);
  const match = /^D5:rising@((?:0|[1-9]\d*)\/(?:0|[1-9]\d*)=(?:[1-8])(?:,(?:0|[1-9]\d*)\/(?:0|[1-9]\d*)=(?:[1-8]))*) TIMER1:TCNT1=([1-8])@(0|[1-9]\d*) CS=7$/.exec(text);
  if (!match) {
    throw new Error(`${field} must be canonical "D5:rising@requested/applied=count,... TIMER1:TCNT1=count@read-cycle CS=7" evidence.`);
  }
  const edges = match[1].split(',').map((token) => {
    const edge = /^(\d+)\/(\d+)=(\d+)$/.exec(token)!;
    return { requested: Number(edge[1]), applied: Number(edge[2]), count: Number(edge[3]) };
  });
  const count = Number(match[2]);
  const readCycle = Number(match[3]);
  if (edges.length !== count || edges.some((edge, index) => edge.count !== index + 1
    || !Number.isSafeInteger(edge.requested) || !Number.isSafeInteger(edge.applied)
    || edge.applied < edge.requested
    || (index > 0 && (edge.requested <= edges[index - 1].requested || edge.applied <= edges[index - 1].applied)))
    || !Number.isSafeInteger(readCycle) || readCycle <= edges.at(-1)!.applied) {
    throw new Error(`${field} must contain 1–8 ordered rising edges, sequential counts, and one later safe read cycle.`);
  }
  return { count, readCycle };
}

export function parseCanonicalPcintMask(value: unknown, field = 'pin-change interrupt evidence'): void {
  const text = exactText(value, field);
  const maskedOnly = /^D7:0>1@(0|[1-9]\d*)\/(0|[1-9]\d*) MASKED PCINT2:none PCMSK2=10$/.exec(text);
  const enabled = /^D7:0>1@(0|[1-9]\d*)\/(0|[1-9]\d*) MASKED;D4:0>1@(0|[1-9]\d*)\/(0|[1-9]\d*) ENABLED PCINT2:v10@(0|[1-9]\d*) PCMSK2=10$/.exec(text);
  if (!maskedOnly && !enabled) {
    throw new Error(`${field} must be canonical masked-only or masked-then-enabled PCINT2/PCMSK2=10 evidence.`);
  }
  const values = (enabled ?? maskedOnly)!.slice(1).map(Number);
  if (!values.every(Number.isSafeInteger) || values.some((cycle) => cycle < 0)
    || values[1] < values[0]
    || (enabled && (values[2] <= values[1] || values[3] < values[2] || values[4] <= values[3]))) {
    throw new Error(`${field} cycles must be safe and ordered within and across the masked/enabled events.`);
  }
}

function canonicalHexBytes(values: readonly number[]): string {
  return values.map((value) => value.toString(16).padStart(2, '0')).join(' ');
}

function exactText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ASSERTION_TEXT_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${field} must be a non-empty control-free string no longer than ${MAX_ASSERTION_TEXT_LENGTH} characters.`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

export function validateAssertions(value: unknown): Assertion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TEST_ASSERTIONS) {
    throw new Error(`assertions must contain 1 to ${MAX_TEST_ASSERTIONS} explicit checks.`);
  }
  const validated = value.map((raw, index): Assertion => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`assertions[${index}] must be an object.`);
    const record = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key) => !['type', 'target', 'value', 'tolerance'].includes(key));
    if (unknownKeys.length) throw new Error(`assertions[${index}] has unsupported field(s): ${unknownKeys.join(', ')}.`);
    if (typeof record.type !== 'string' || !ASSERTION_TYPES.has(record.type as AssertionType)) {
      throw new Error(`assertions[${index}].type is unsupported.`);
    }
    const type = record.type as AssertionType;
    const targetRequired = type.startsWith('pin_') || type === 'gpio_input_event_cycles_equals' || type === 'led_on' || type === 'spi_tx_equals' || type === 'adc_sample_equals' || type === 'i2c_write_intent_equals' || type === 'uart_tx_equals' || type === 'neopixel_frame_intent_equals' || type === 'eeprom_roundtrip_equals' || type === 'watchdog_reset_equals' || type === 'external_interrupt_equals' || type === 'timer_external_count_equals' || type === 'pin_change_interrupt_equals';
    const target = targetRequired ? exactText(record.target, `assertions[${index}].target`) : undefined;
    let expected: Assertion['value'];
    let tolerance: number | undefined;
    if (type === 'serial_contains' || type === 'serial_matches') {
      expected = exactText(record.value, `assertions[${index}].value`);
      if (type === 'serial_matches') {
        try { new RegExp(expected); } catch { throw new Error(`assertions[${index}].value must be a valid regular expression.`); }
      }
    } else if (type === 'spi_tx_equals' || type === 'uart_tx_equals' || type === 'neopixel_frame_intent_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      const bytes = parseCanonicalHexBytes(expected, `assertions[${index}].value`);
      if (type === 'uart_tx_equals' && bytes.length !== 1) throw new Error(`assertions[${index}].value must contain exactly one canonical UART TX byte.`);
      if (type === 'neopixel_frame_intent_equals' && bytes.length !== 3) throw new Error(`assertions[${index}].value must contain exactly three canonical GRB bytes.`);
    } else if (type === 'pin_transition_cycles_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      parseCanonicalTransitionCycles(expected, `assertions[${index}].value`);
    } else if (type === 'gpio_input_event_cycles_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      parseCanonicalGpioInputEventCycles(expected, `assertions[${index}].value`);
    } else if (type === 'i2c_write_intent_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      parseCanonicalI2cWriteIntent(expected, `assertions[${index}].value`);
    } else if (type === 'eeprom_roundtrip_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      if (!/^[0-9a-f]{4}:[0-9a-f]{2}$/.test(expected)) {
        throw new Error(`assertions[${index}].value must be canonical lowercase EEPROM address:byte, e.g. "0010:5a".`);
      }
    } else if (type === 'watchdog_reset_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      if (!/^(?:0|[1-9]\d*):[0-9a-f]{2}$/.test(expected)) {
        throw new Error(`assertions[${index}].value must be canonical watchdog reset-cycle:MCUSR-byte, e.g. "256015:08".`);
      }
    } else if (type === 'external_interrupt_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      parseCanonicalExternalInterrupt(expected, `assertions[${index}].value`);
    } else if (type === 'timer_external_count_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      parseCanonicalTimerExternalCount(expected, `assertions[${index}].value`);
    } else if (type === 'pin_change_interrupt_equals') {
      expected = exactText(record.value, `assertions[${index}].value`);
      parseCanonicalPcintMask(expected, `assertions[${index}].value`);
    } else if (type === 'adc_sample_equals') {
      const number = finiteNumber(record.value, `assertions[${index}].value`);
      if (!Number.isSafeInteger(number) || number < 0 || number > 1023) throw new Error(`assertions[${index}].value must be an integer raw ADC code from 0 to 1023.`);
      expected = number;
    } else if (type === 'serial_line_count') {
      const number = finiteNumber(record.value, `assertions[${index}].value`);
      if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000) throw new Error(`assertions[${index}].value must be an integer from 0 to 1000000.`);
      expected = number;
    } else if (type === 'pin_toggles') {
      const number = finiteNumber(record.value, `assertions[${index}].value`);
      if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000) throw new Error(`assertions[${index}].value must be an integer from 1 to 1000000.`);
      expected = number;
    } else if (type === 'pin_frequency') {
      const number = finiteNumber(record.value, `assertions[${index}].value`);
      if (number <= 0 || number > 1_000_000_000) throw new Error(`assertions[${index}].value must be greater than 0 and at most 1000000000.`);
      expected = number;
      tolerance = record.tolerance == null ? undefined : finiteNumber(record.tolerance, `assertions[${index}].tolerance`);
      if (tolerance != null && (tolerance < 0 || tolerance > 1)) throw new Error(`assertions[${index}].tolerance must be from 0 to 1.`);
    } else if (type === 'pin_duty_cycle') {
      const number = finiteNumber(record.value, `assertions[${index}].value`);
      if (number < 0 || number > 1) throw new Error(`assertions[${index}].value must be a duty fraction from 0 to 1.`);
      expected = number;
      tolerance = record.tolerance == null ? undefined : finiteNumber(record.tolerance, `assertions[${index}].tolerance`);
      if (tolerance != null && (tolerance < 0 || tolerance > 1)) throw new Error(`assertions[${index}].tolerance must be from 0 to 1.`);
    } else if (type === 'pin_final') {
      const number = finiteNumber(record.value, `assertions[${index}].value`);
      if (number !== 0 && number !== 1) throw new Error(`assertions[${index}].value must be exactly 0 or 1.`);
      expected = number;
    } else {
      if (record.value != null && typeof record.value !== 'boolean') throw new Error(`assertions[${index}].value must be boolean when provided.`);
      expected = record.value == null ? true : record.value as boolean;
    }
    return { type, ...(target ? { target } : {}), ...(expected !== undefined ? { value: expected } : {}), ...(tolerance !== undefined ? { tolerance } : {}) };
  });
  const keys = validated.map((assertion) => JSON.stringify(assertion));
  if (new Set(keys).size !== keys.length) throw new Error('assertions must not contain duplicate checks.');
  return validated;
}

function findTrace(traces: SimTrace[], target?: string): SimTrace | undefined {
  if (!target) return undefined;
  const matches = traces.filter((trace) => trace.name === target);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Count 0->1 / 1->0 edges in a digital trace. */
function countEdges(tr: SimTrace): number {
  let edges = 0;
  for (let i = 1; i < tr.v.length; i++) if (tr.v[i] !== tr.v[i - 1]) edges++;
  return edges;
}

function evaluate(a: Assertion, sim: SimResult): AssertionResult {
  const base = { ...a } as AssertionResult;
  const serialText = sim.serial.map((l) => l.text).join('\n');
  switch (a.type) {
    case 'serial_contains': {
      const needle = String(a.value ?? '');
      const pass = serialText.includes(needle);
      return { ...base, pass, actual: serialText.slice(0, 200), detail: pass ? `Found "${needle}"` : `"${needle}" not in serial output` };
    }
    case 'serial_matches': {
      let pass = false;
      try {
        pass = new RegExp(String(a.value ?? '')).test(serialText);
      } catch {
        return { ...base, pass: false, actual: null, detail: `Invalid regex: ${a.value}` };
      }
      return { ...base, pass, actual: serialText.slice(0, 200), detail: pass ? `Matched /${a.value}/` : `No match for /${a.value}/` };
    }
    case 'serial_line_count': {
      const n = sim.serial.length;
      const pass = n === Number(a.value);
      return { ...base, pass, actual: n, detail: `${n} line(s), expected ${a.value}` };
    }
    case 'pin_toggles': {
      const tr = findTrace(sim.traces, a.target);
      if (!tr) return { ...base, pass: false, actual: null, detail: `No trace for "${a.target}"` };
      const edges = countEdges(tr);
      const min = a.value != null ? Number(a.value) : 1;
      const pass = edges >= min;
      return { ...base, pass, actual: edges, detail: `${edges} edge(s) on ${tr.name}, expected >= ${min}` };
    }
    case 'pin_frequency': {
      const tr = findTrace(sim.traces, a.target);
      if (!tr) return { ...base, pass: false, actual: null, detail: `No trace for "${a.target}"` };
      const measurement = measureDigitalTrace(tr);
      if (!measurement) return { ...base, pass: false, actual: null, detail: `No complete well-formed digital period for "${a.target}"` };
      const freq = measurement.frequencyHz;
      const tol = a.tolerance ?? 0.2;
      const want = Number(a.value);
      const pass = want > 0 && Math.abs(freq - want) <= want * tol;
      const periodEvidence = measurement.timingDomain === 'emulator-cycles'
        ? `; ${measurement.completePeriods} complete period(s), ${measurement.averagePeriod.toFixed(2)} modeled cycles average at ${measurement.clockHz}Hz`
        : `; ${measurement.completePeriods} complete period(s)`;
      return { ...base, pass, actual: Number(freq.toFixed(3)), detail: `${freq.toFixed(3)}Hz on ${tr.name}, expected ${want}Hz ±${Math.round(tol * 100)}%${periodEvidence}` };
    }
    case 'pin_duty_cycle': {
      const tr = findTrace(sim.traces, a.target);
      if (!tr) return { ...base, pass: false, actual: null, detail: `No trace for "${a.target}"` };
      const measurement = measureDigitalTrace(tr);
      if (!measurement) return { ...base, pass: false, actual: null, detail: `No complete well-formed digital period for "${a.target}"` };
      const duty = measurement.dutyCycle;
      const tolerance = a.tolerance ?? 0.05;
      const want = Number(a.value);
      const pass = Math.abs(duty - want) <= tolerance;
      const periodEvidence = measurement.timingDomain === 'emulator-cycles'
        ? `; ${measurement.completePeriods} complete period(s), ${measurement.averageHigh.toFixed(2)}/${measurement.averagePeriod.toFixed(2)} modeled cycles high/period`
        : `; ${measurement.completePeriods} complete period(s)`;
      return { ...base, pass, actual: Number(duty.toFixed(6)), detail: `${(duty * 100).toFixed(3)}% high on ${tr.name}, expected ${(want * 100).toFixed(2)}% ±${(tolerance * 100).toFixed(2)} percentage points${periodEvidence}` };
    }
    case 'pin_final': {
      const tr = findTrace(sim.traces, a.target);
      if (!tr) return { ...base, pass: false, actual: null, detail: `No trace for "${a.target}"` };
      const last = tr.v[tr.v.length - 1];
      const pass = last === Number(a.value);
      return { ...base, pass, actual: last, detail: `${tr.name} final=${last}, expected ${a.value}` };
    }
    case 'pin_transition_cycles_equals': {
      const tr = findTrace(sim.traces, a.target);
      if (!tr) return { ...base, pass: false, actual: null, detail: `No unique trace for "${a.target}"` };
      if (tr.unit !== 'digital' || tr.timing?.domain !== 'emulator-cycles'
        || tr.timing.sampleCycles.length !== tr.v.length
        || tr.v.some((value) => value !== 0 && value !== 1)
        || tr.timing.sampleCycles.some((cycle, index) => !Number.isSafeInteger(cycle)
          || cycle < 0 || (index > 0 && cycle <= tr.timing!.sampleCycles[index - 1]))) {
        return { ...base, pass: false, actual: null, detail: `Trace "${a.target}" lacks one well-formed exact digital emulator-cycle sequence.` };
      }
      const actualTransitions = [] as Array<{ cycle: number; level: 0 | 1 }>;
      for (let index = 1; index < tr.v.length; index += 1) {
        if (tr.v[index] === tr.v[index - 1]) continue;
        actualTransitions.push({ cycle: tr.timing.sampleCycles[index], level: tr.v[index] as 0 | 1 });
      }
      const actual = actualTransitions.map(({ cycle, level }) => `${cycle}:${level}`).join(' ');
      const expected = String(a.value);
      return {
        ...base,
        pass: actual === expected,
        actual,
        detail: `${tr.name} exact modeled transition cycles ${actual || '(none)'}; expected ${expected}. Emulator-cycle GPIO evidence only; no calibrated timing, voltage, waveform, or hardware claim.`,
      };
    }
    case 'gpio_input_event_cycles_equals': {
      const events = (sim.peripheralEvents ?? []).filter((event): event is GpioInputEvent => event.kind === 'gpio-input-injected' && event.controller === a.target);
      if (!events.length) return { ...base, pass: false, actual: null, detail: `No scheduled GPIO input evidence for "${a.target}"` };
      if ((sim.peripheralEventsOmitted ?? 0) !== 0
        || events.some((event, index) => event.sequenceIndex !== index
          || event.previousLevel === event.level
          || !Number.isSafeInteger(event.requestedCycle) || !Number.isSafeInteger(event.appliedCycle)
          || event.requestedCycle < 0 || event.appliedCycle < event.requestedCycle
          || (index > 0 && (event.requestedCycle <= events[index - 1].requestedCycle
            || event.appliedCycle <= events[index - 1].appliedCycle)))) {
        return { ...base, pass: false, actual: null, detail: `GPIO input evidence for "${a.target}" is omitted or malformed.` };
      }
      const actual = events.map((event) => `${event.pinAlias}:${event.previousLevel}>${event.level}@${event.requestedCycle}/${event.appliedCycle}`).join(' ');
      const expected = String(a.value);
      return {
        ...base, pass: actual === expected, actual,
        detail: `${a.target} exact scheduled input cycles ${actual}; expected ${expected}. Emulator input evidence only; no contacts, motion, voltage, calibrated timing, or hardware claim.`,
      };
    }
    case 'spi_tx_equals': {
      const events = (sim.peripheralEvents ?? []).filter((event): event is SpiTransferEvent => event.kind === 'spi-transfer' && event.controller === a.target);
      if (!events.length) return { ...base, pass: false, actual: null, detail: `No byte-level SPI transfer evidence for "${a.target}"` };
      const actual = canonicalHexBytes(events.map((event) => event.tx));
      const expected = String(a.value);
      const pass = actual === expected;
      const config = events[0];
      const omitted = sim.peripheralEventsOmitted ?? 0;
      const stableConfig = events.every((event) => event.master === config.master
        && event.mode === config.mode
        && event.dataOrder === config.dataOrder
        && event.clockDivider === config.clockDivider
        && event.modeledFrequencyHz === config.modeledFrequencyHz);
      return {
        ...base,
        pass: pass && stableConfig && omitted === 0,
        actual,
        detail: `${events.length} SPI0 TX byte(s), expected exact sequence; ${config.master ? 'master' : 'slave'}, mode ${config.mode}, ${config.dataOrder}, divider ${config.clockDivider}, ${config.modeledFrequencyHz}Hz modeled${stableConfig ? '' : '; configuration changed during frame'}${omitted ? `; ${omitted} event(s) omitted so exact equality is unprovable` : ''}. Byte-level controller evidence only; no MOSI/SCK waveform or external-device response.`,
      };
    }
    case 'neopixel_frame_intent_equals': {
      const events = (sim.peripheralEvents ?? []).filter((event): event is NeoPixelFrameEvent => event.kind === 'neopixel-frame-intent' && event.controller === a.target);
      if (events.length !== 1) return { ...base, pass: false, actual: null, detail: `Expected one exact fixture-derived NeoPixel frame event for "${a.target}"; found ${events.length}.` };
      const event = events[0];
      const actual = canonicalHexBytes(event.bytes);
      const expected = String(a.value);
      const wellFormed = event.colorOrder === 'GRB' && event.bitCount === 24
        && event.highCycles.length === 24
        && event.highCycles.every((width) => width === event.zeroHighCycles || width === event.oneHighCycles)
        && event.zeroHighCycles < event.oneHighCycles
        && Number.isSafeInteger(event.frameStartCycle) && Number.isSafeInteger(event.frameEndCycle)
        && event.frameStartCycle >= 0 && event.frameEndCycle > event.frameStartCycle
        && event.decode === 'fixture-exact-modeled-high-cycles';
      return {
        ...base, pass: wellFormed && actual === expected, actual,
        detail: `One fixture-derived 24-bit ${event.colorOrder} D6 frame intent ${actual}, expected ${expected}; modeled cycles ${event.frameStartCycle}→${event.frameEndCycle}, high widths 0=${event.zeroHighCycles}/1=${event.oneHighCycles}. Byte/pulse controller intent only; no calibrated WS2812 timing, electrical waveform, pixel response, emitted light, or hardware claim.`,
      };
    }
    case 'eeprom_roundtrip_equals': {
      const evidence = deriveEepromRoundtripIntentEvidence(sim);
      const expected = String(a.value);
      if (!evidence || a.target !== 'EEPROM') {
        return { ...base, pass: false, actual: null, detail: `No exact complete fixture-scoped EEPROM round-trip evidence for "${a.target}".` };
      }
      const actual = canonicalEepromRoundtrip(evidence);
      return {
        ...base,
        pass: actual === expected,
        actual,
        detail: `EEPROM modeled erase-and-write/read-back ${actual}, expected ${expected}; write ${evidence.writeRequestCycle}→${evidence.writeReadyCycle}, read ${evidence.readCycle}, D6 success ${evidence.successCycle}. avr8js in-memory controller/backend evidence only; no retention, endurance, wear, power-loss safety, atomicity, calibrated timing, voltage, or hardware persistence claim.`,
      };
    }
    case 'watchdog_reset_equals': {
      const evidence = deriveWatchdogResetIntentEvidence(sim);
      const expected = String(a.value);
      if (!evidence || a.target !== 'WDT') {
        return { ...base, pass: false, actual: null, detail: `No exact complete fixture-scoped watchdog reset evidence for "${a.target}".` };
      }
      const actual = canonicalWatchdogReset(evidence);
      return {
        ...base,
        pass: actual === expected,
        actual,
        detail: `Watchdog modeled reset/MCUSR evidence ${actual}, expected ${expected}; firmware read MCUSR at ${evidence.mcusrReadCycle}, lowered D5 at ${evidence.armedLowCycle}, and raised D6 at ${evidence.successCycle}. avr8js controller/reset evidence only; no calibrated timeout, oscillator, brownout/reset-pin/bootloader, startup-safety, voltage, or hardware-reset claim.`,
      };
    }
    case 'external_interrupt_equals': {
      const evidence = deriveInt0InterruptIntentEvidence(sim);
      const expected = String(a.value);
      if (!evidence || a.target !== 'INT0') {
        return { ...base, pass: false, actual: null, detail: `No exact complete fixture-scoped INT0 interrupt evidence for "${a.target}".` };
      }
      const actual = canonicalExternalInterrupt(evidence);
      return {
        ...base,
        pass: actual === expected,
        actual,
        detail: `INT0 modeled input/vector evidence ${actual}, expected ${expected}; ISR lowered D5 at ${evidence.armedLowCycle} and raised D6 at ${evidence.observedHighCycle}. avr8js controller/CPU-vector evidence only; no calibrated latency, deadline, priority/nesting, bounce/noise, voltage, electrical-edge, startup-safety, or hardware-interrupt claim.`,
      };
    }
    case 'timer_external_count_equals': {
      const evidence = deriveTimer1PulseCounterIntentEvidence(sim);
      const expected = String(a.value);
      if (!evidence || a.target !== 'TIMER1') {
        return { ...base, pass: false, actual: null, detail: `No exact complete fixture-scoped Timer1 external-count evidence for "${a.target}".` };
      }
      const actual = canonicalTimer1ExternalCount(evidence);
      return {
        ...base,
        pass: actual === expected,
        actual,
        detail: `Timer1 modeled external rising-edge count ${actual}, expected ${expected}; firmware raised D6 at ${evidence.readCompleteCycle} and D7 ${evidence.thresholdReached ? `at ${evidence.thresholdCycle}` : 'remained low'}. avr8js GPIO/controller/register-read evidence only; no frequency, tachometer/RPM, missed-pulse, calibrated-timing, voltage, electrical-edge, or hardware claim.`,
      };
    }
    case 'pin_change_interrupt_equals': {
      const evidence = derivePcintMaskIntentEvidence(sim);
      const expected = String(a.value);
      if (!evidence || a.target !== 'PCINT2') {
        return { ...base, pass: false, actual: null, detail: `No exact complete fixture-scoped PCINT2 mask evidence for "${a.target}".` };
      }
      const actual = canonicalPcintMask(evidence);
      return {
        ...base,
        pass: actual === expected,
        actual,
        detail: `PCINT2 modeled mask/vector evidence ${actual}, expected ${expected}. avr8js input/controller/CPU-vector evidence only; no simultaneous-edge ordering, calibrated latency, priority/nesting, bounce/noise, voltage, electrical-edge, or hardware claim.`,
      };
    }
    case 'adc_sample_equals': {
      const events = (sim.peripheralEvents ?? []).filter((event): event is AdcSampleEvent => event.kind === 'adc-sample' && event.controller === a.target);
      const omitted = sim.peripheralEventsOmitted ?? 0;
      if (events.length !== 1 || omitted) {
        return { ...base, pass: false, actual: null, detail: `Expected exactly one complete ADC sample for "${a.target}"; observed ${events.length}${omitted ? ` with ${omitted} omitted peripheral event(s)` : ''}.` };
      }
      const event = events[0];
      const expected = Number(a.value);
      const pass = event.raw === expected;
      return {
        ...base,
        pass,
        actual: event.raw,
        detail: `${event.channel} raw=${event.raw}/1023 from explicit ${event.inputVoltage}V modeled input against ${event.reference} ${event.referenceVoltage}V; expected ${expected}; conversion ${event.startCycle}→${event.completeCycle} modeled cycles. Not physical sensor or calibrated analog evidence.`,
      };
    }
    case 'i2c_write_intent_equals': {
      const events = (sim.peripheralEvents ?? []).filter((event): event is I2cWriteIntentEvent => event.kind === 'i2c-write-intent' && event.controller === a.target);
      const omitted = sim.peripheralEventsOmitted ?? 0;
      if (events.length !== 1 || omitted) {
        return { ...base, pass: false, actual: null, detail: `Expected exactly one complete I2C write intent for "${a.target}"; observed ${events.length}${omitted ? ` with ${omitted} omitted peripheral event(s)` : ''}.` };
      }
      const event = events[0];
      const actual = `${event.address7Bit.toString(16).padStart(2, '0')}: ${canonicalHexBytes(event.bytes)}`;
      const expected = String(a.value);
      const responseExact = event.responseMode === 'synthetic-ack-for-controller-progress'
        && event.syntheticAckCount === event.bytes.length + 1;
      return {
        ...base,
        pass: actual === expected && responseExact,
        actual,
        detail: `TWI0 completed one STOP-bounded write intent ${actual}; expected ${expected}; ${event.syntheticAckCount} synthetic ACKs used only to advance avr8js. No external ACK/response, read data, SCL timing/frequency, SDA/SCL waveform, pull-ups, arbitration, pins/nets, display, PCB, or hardware behavior was modeled.${responseExact ? '' : ' Synthetic response metadata was inconsistent.'}`,
      };
    }
    case 'uart_tx_equals': {
      const rx = (sim.peripheralEvents ?? []).filter((event): event is UartRxEvent => event.kind === 'uart-rx-injected' && event.controller === a.target);
      const tx = (sim.peripheralEvents ?? []).filter((event): event is UartTxEvent => event.kind === 'uart-tx' && event.controller === a.target);
      const omitted = sim.peripheralEventsOmitted ?? 0;
      if (rx.length !== 1 || tx.length !== 1 || omitted) {
        return { ...base, pass: false, actual: null, detail: `Expected exactly one scheduled RX and one firmware TX byte for "${a.target}"; observed RX ${rx.length}, TX ${tx.length}${omitted ? ` with ${omitted} omitted peripheral event(s)` : ''}.` };
      }
      const receive = rx[0];
      const transmit = tx[0];
      const actual = canonicalHexBytes([transmit.byte]);
      const expected = String(a.value);
      const sameConfig = receive.baudRate === transmit.baudRate
        && receive.bitsPerChar === transmit.bitsPerChar
        && receive.stopBits === transmit.stopBits
        && receive.parity === transmit.parity;
      const stimulusByte = sim.modeledStimulus?.uart0_rx_byte;
      const exactStimulus = stimulusByte === receive.byte;
      const exactDelivery = receive.delivery === 'avr8js-writeByte-scheduled';
      const orderedResponse = receive.requestCycle < receive.completeCycle
        && receive.completeCycle <= transmit.writeCycle;
      return {
        ...base,
        pass: actual === expected && sameConfig && exactStimulus && exactDelivery && orderedResponse,
        actual,
        detail: `USART0 scheduled RX ${canonicalHexBytes([receive.byte])} at ${receive.requestCycle}→${receive.completeCycle} modeled cycles and firmware wrote TX ${actual} at cycle ${transmit.writeCycle}; expected ${expected}; ${transmit.baudRate} modeled baud, ${transmit.bitsPerChar} data bits, ${transmit.parity} parity, ${transmit.stopBits} stop bit(s). Controller/emulator evidence only; no external ACK/device, voltage, wire waveform, calibrated baud timing, cable, or USB serial behavior.${sameConfig ? '' : ' UART configuration changed between RX and TX.'}${exactStimulus ? '' : ' RX evidence did not match normalized stimulus.'}${exactDelivery ? '' : ' RX delivery provenance was not the exact scheduled avr8js writeByte path.'}${orderedResponse ? '' : ' TX was not ordered after the completed RX command.'}`,
      };
    }
    case 'led_on': {
      const matches = sim.parts.filter((part) => part.sourceComponentId === a.target || part.name === a.target);
      const p = matches.length === 1 ? matches[0] : undefined;
      const on = !!p?.state.on;
      const want = a.value !== false;
      const pass = on === want;
      return { ...base, pass, actual: on, detail: p ? `${a.target} on=${on}, expected ${want}` : `No part "${a.target}"` };
    }
    default:
      return { ...base, pass: false, actual: null, detail: `Unknown assertion type "${a.type}"` };
  }
}

export function evaluateAssertions(sim: SimResult, assertions: unknown): AssertionResult[] {
  return validateAssertions(assertions).map((assertion) => evaluate(assertion, sim));
}

export async function runFirmwareTest(
  ctx: SimContext,
  req: SimRequest,
  assertions: Assertion[],
): Promise<TestReport> {
  const request: SimRequest = { mode: 'mcu', ...req };
  // Bundled fixtures carry an evidence-backed default duration. Preserve the
  // historical 2s default only for caller-supplied firmware / AVR demo runs.
  if (request.durationMs == null && !request.fixture) request.durationMs = 2000;
  const sim = await simulate(ctx, request);
  const results = evaluateAssertions(sim, assertions);
  const failed = results.filter((r) => !r.pass).length;
  return {
    pass: failed === 0 && sim.ok,
    passed: results.length - failed,
    failed,
    engine: sim.engine,
    simulatedMs: sim.simulatedMs,
    results,
    simError: sim.error,
    firmwareFixture: sim.firmwareFixture,
    modeledStimulus: sim.modeledStimulus,
  };
}
