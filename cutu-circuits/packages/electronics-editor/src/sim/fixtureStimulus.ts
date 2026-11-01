import type { FirmwareFixtureId } from './types.ts';

export const AVR_ADC_THRESHOLD_DEFAULT_VOLTAGE = 2.5;
export const AVR_UART_COMMAND_DEFAULT_BYTE = 0x31;
export const AVR_LIMIT_INTERLOCK_DEFAULT_TRIP_MS = 0.75;
export const AVR_LIMIT_INTERLOCK_CLOCK_HZ = 16_000_000;
export const AVR_QUADRATURE_DEFAULT_DIRECTION = 1;
export const AVR_BUTTON_DEBOUNCE_DEFAULT_BOUNCE = 1;
export const AVR_INT0_DEFAULT_FALLING_CYCLE = 2_000;
export const AVR_TIMER1_PULSE_COUNTER_DEFAULT_COUNT = 4;
export const AVR_PCINT_MASK_DEFAULT_PROFILE = 1;

export interface AvrAdcThresholdStimulus extends Record<string, number> {
  adc0_voltage: number;
}

export interface AvrUartCommandStimulus extends Record<string, number> {
  uart0_rx_byte: number;
}

export interface AvrLimitInterlockStimulus extends Record<string, number> {
  limit_trip_ms: number;
}

export interface AvrQuadratureDetentStimulus extends Record<string, number> {
  /** Fixture-defined: 1 = D2/A leads D3/B (CW); -1 = D3/B leads D2/A (CCW). */
  encoder_direction: 1 | -1;
}

export interface AvrButtonDebounceStimulus extends Record<string, number> {
  /** Fixture-defined: 0 = one clean falling edge; 1 = bounded low/high bounce before stable low. */
  button_bounce: 0 | 1;
}

export interface AvrInt0InterruptStimulus extends Record<string, number> {
  /** Exact modeled cycle requested for the fixture-only D2 falling edge. */
  int0_falling_cycle: number;
}

export interface AvrTimer1PulseCounterStimulus extends Record<string, number> {
  /** Exact number of clean fixture-only D5/T1 pulses scheduled for Timer1. */
  timer1_pulse_count: number;
}

export interface AvrPcintMaskStimulus extends Record<string, number> {
  /** Fixture-defined: 0 = masked D7 change only; 1 = masked D7 then enabled D4 change. */
  pcint_profile: 0 | 1;
}

export type NormalizedFixtureStimulus = AvrAdcThresholdStimulus | Record<string, number>;

export function normalizeFixtureStimulus(
  fixture: FirmwareFixtureId,
  value: unknown,
): NormalizedFixtureStimulus {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('stimulus must be an object.');
  }
  const record = (value ?? {}) as Record<string, unknown>;
  const keys = Object.keys(record);
  if (fixture === 'avr-uart-command-response') {
    const unknown = keys.filter((key) => key !== 'uart0_rx_byte');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-uart-command-response: ${unknown.join(', ')}.`);
    const byte = record.uart0_rx_byte ?? AVR_UART_COMMAND_DEFAULT_BYTE;
    if (typeof byte !== 'number' || !Number.isSafeInteger(byte) || byte < 0 || byte > 255) {
      throw new Error('stimulus.uart0_rx_byte must be an exact integer byte from 0 to 255 inclusive.');
    }
    return { uart0_rx_byte: byte };
  }
  if (fixture === 'avr-limit-interlock-intent') {
    const unknown = keys.filter((key) => key !== 'limit_trip_ms');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-limit-interlock-intent: ${unknown.join(', ')}.`);
    const tripMs = record.limit_trip_ms ?? AVR_LIMIT_INTERLOCK_DEFAULT_TRIP_MS;
    const requestedCycle = typeof tripMs === 'number' ? tripMs * (AVR_LIMIT_INTERLOCK_CLOCK_HZ / 1000) : Number.NaN;
    if (typeof tripMs !== 'number' || !Number.isFinite(tripMs) || tripMs < 0.05 || tripMs > 1.5
      || !Number.isSafeInteger(requestedCycle)) {
      throw new Error('stimulus.limit_trip_ms must be a finite 0.05 to 1.5 ms value that maps to one exact modeled 16MHz cycle.');
    }
    return { limit_trip_ms: tripMs };
  }
  if (fixture === 'avr-quadrature-detent-intent') {
    const unknown = keys.filter((key) => key !== 'encoder_direction');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-quadrature-detent-intent: ${unknown.join(', ')}.`);
    const direction = record.encoder_direction ?? AVR_QUADRATURE_DEFAULT_DIRECTION;
    if (direction !== 1 && direction !== -1) {
      throw new Error('stimulus.encoder_direction must be exactly 1 (fixture-defined CW) or -1 (fixture-defined CCW).');
    }
    return { encoder_direction: direction };
  }
  if (fixture === 'avr-button-debounce-intent') {
    const unknown = keys.filter((key) => key !== 'button_bounce');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-button-debounce-intent: ${unknown.join(', ')}.`);
    const bounce = record.button_bounce ?? AVR_BUTTON_DEBOUNCE_DEFAULT_BOUNCE;
    if (bounce !== 0 && bounce !== 1) {
      throw new Error('stimulus.button_bounce must be exactly 0 (fixture-defined clean press) or 1 (bounded bouncing press).');
    }
    return { button_bounce: bounce };
  }
  if (fixture === 'avr-int0-interrupt-intent') {
    const unknown = keys.filter((key) => key !== 'int0_falling_cycle');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-int0-interrupt-intent: ${unknown.join(', ')}.`);
    const cycle = record.int0_falling_cycle ?? AVR_INT0_DEFAULT_FALLING_CYCLE;
    if (typeof cycle !== 'number' || !Number.isSafeInteger(cycle) || cycle < 500 || cycle > 8_000) {
      throw new Error('stimulus.int0_falling_cycle must be an exact modeled cycle from 500 to 8000 inclusive.');
    }
    return { int0_falling_cycle: cycle };
  }
  if (fixture === 'avr-timer1-pulse-counter-intent') {
    const unknown = keys.filter((key) => key !== 'timer1_pulse_count');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-timer1-pulse-counter-intent: ${unknown.join(', ')}.`);
    const count = record.timer1_pulse_count ?? AVR_TIMER1_PULSE_COUNTER_DEFAULT_COUNT;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 8) {
      throw new Error('stimulus.timer1_pulse_count must be an exact integer from 1 to 8 inclusive.');
    }
    return { timer1_pulse_count: count };
  }
  if (fixture === 'avr-pcint-mask-intent') {
    const unknown = keys.filter((key) => key !== 'pcint_profile');
    if (unknown.length) throw new Error(`stimulus has unsupported field(s) for avr-pcint-mask-intent: ${unknown.join(', ')}.`);
    const profile = record.pcint_profile ?? AVR_PCINT_MASK_DEFAULT_PROFILE;
    if (profile !== 0 && profile !== 1) {
      throw new Error('stimulus.pcint_profile must be exactly 0 (masked D7 only) or 1 (masked D7 then enabled D4).');
    }
    return { pcint_profile: profile };
  }
  if (fixture !== 'avr-adc-threshold' && fixture !== 'avr-adc-pwm-controller-intent') {
    if (keys.length) throw new Error(`Fixture "${fixture}" does not accept stimulus fields.`);
    return {};
  }
  const unknown = keys.filter((key) => key !== 'adc0_voltage');
  if (unknown.length) throw new Error(`stimulus has unsupported field(s) for ${fixture}: ${unknown.join(', ')}.`);
  const voltage = record.adc0_voltage ?? AVR_ADC_THRESHOLD_DEFAULT_VOLTAGE;
  if (typeof voltage !== 'number' || !Number.isFinite(voltage) || voltage < 0 || voltage > 5) {
    throw new Error('stimulus.adc0_voltage must be a finite modeled voltage from 0 to 5 inclusive.');
  }
  return { adc0_voltage: voltage };
}

export function isAvrAdcThresholdStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrAdcThresholdStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'adc0_voltage');
}

export function isAvrUartCommandStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrUartCommandStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'uart0_rx_byte');
}

export function isAvrLimitInterlockStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrLimitInterlockStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'limit_trip_ms');
}

export function isAvrQuadratureDetentStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrQuadratureDetentStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'encoder_direction');
}

export function isAvrButtonDebounceStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrButtonDebounceStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'button_bounce');
}

export function isAvrInt0InterruptStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrInt0InterruptStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'int0_falling_cycle');
}

export function isAvrTimer1PulseCounterStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrTimer1PulseCounterStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'timer1_pulse_count');
}

export function isAvrPcintMaskStimulus(
  value: NormalizedFixtureStimulus,
): value is AvrPcintMaskStimulus {
  return Object.prototype.hasOwnProperty.call(value, 'pcint_profile');
}
