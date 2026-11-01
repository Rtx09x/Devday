/**
 * Simulation types
 *
 * The plan calls for three independent simulation axes -- interactive logical,
 * analog SPICE, and MCU firmware emulation -- each the right tool for a
 * different class of part. They all reduce to the same shape: a set of named
 * signal traces over time (for the scope), optional serial output (for the
 * monitor), a snapshot of part state, and human/agent-readable notes. Keeping
 * one result type lets the simulation panel and the `electronics.simulate` AI
 * tool treat every engine uniformly.
 */

import type { AnyCircuitElement } from '../circuit/circuitJson';

export type SimMode = 'auto' | 'logical' | 'analog' | 'mcu';
export type McuTarget = 'avr' | 'rp2040' | 'esp32';
export type FirmwareFixtureId = 'rp2040-launch-beacon' | 'avr-pwm-heartbeat' | 'avr-servo-pulse-intent' | 'avr-timer2-tone-intent' | 'avr-spi-pixel-palette' | 'avr-adc-threshold' | 'avr-adc-pwm-controller-intent' | 'avr-i2c-display-intent' | 'avr-uart-command-response' | 'avr-step-dir-intent' | 'avr-limit-interlock-intent' | 'avr-quadrature-detent-intent' | 'avr-button-debounce-intent' | 'avr-neopixel-frame-intent' | 'avr-eeprom-roundtrip-intent' | 'avr-watchdog-reset-intent' | 'avr-int0-interrupt-intent' | 'avr-timer1-pulse-counter-intent' | 'avr-pcint-mask-intent';

/** One named signal sampled over time. `unit` drives the scope axis label. */
export interface SimTrace {
  name: string;
  unit: 'V' | 'A' | 'digital' | 'count';
  /** Time in seconds for each sample. */
  t: number[];
  /** Value at each sample (volts, amps, 0/1 for digital). */
  v: number[];
  /** Optional exact emulator-cycle timing parallel to t/v; never physical-clock evidence. */
  timing?: {
    domain: 'emulator-cycles';
    clockHz: number;
    sampleCycles: number[];
  };
  /** Structured engine identity used for exact canvas evidence joins. */
  origin?:
    | { family: 'avr'; port: string; bit: number; aliases: string[] }
    | { family: 'rp2040'; pin: number; aliases: string[] };
}

/** A line emitted on the emulated serial port (UART). */
export interface SerialLine {
  /** Milliseconds of simulated time when the line completed. */
  t: number;
  text: string;
}

/** Structured byte-level peripheral evidence; never inferred electrical waveforms. */
export type PeripheralEvent =
  | {
    kind: 'spi-transfer';
    controller: 'SPI0';
    startCycle: number;
    completeCycle: number;
    tx: number;
    rx: number;
    master: boolean;
    mode: 0 | 1 | 2 | 3;
    dataOrder: 'msbFirst' | 'lsbFirst';
    clockDivider: number;
    modeledFrequencyHz: number;
  }
  | {
    kind: 'adc-sample';
    controller: 'ADC0';
    channel: 'ADC0';
    pinAlias: 'A0';
    startCycle: number;
    completeCycle: number;
    inputVoltage: number;
    reference: 'AVCC';
    referenceVoltage: 5;
    resolutionBits: 10;
    raw: number;
  }
  | {
    kind: 'i2c-write-intent';
    controller: 'TWI0';
    address7Bit: number;
    bytes: number[];
    startCycle: number;
    stopCycle: number;
    responseMode: 'synthetic-ack-for-controller-progress';
    syntheticAckCount: number;
  }
  | {
    kind: 'uart-rx-injected';
    controller: 'USART0';
    byte: number;
    requestCycle: number;
    completeCycle: number;
    baudRate: number;
    bitsPerChar: number;
    stopBits: number;
    parity: 'none' | 'even' | 'odd';
    delivery: 'avr8js-writeByte-scheduled';
  }
  | {
    kind: 'uart-tx';
    controller: 'USART0';
    byte: number;
    writeCycle: number;
    baudRate: number;
    bitsPerChar: number;
    stopBits: number;
    parity: 'none' | 'even' | 'odd';
  }
  | {
    kind: 'gpio-input-injected';
    controller: 'GPIOD';
    port: 'D';
    bit: number;
    pinAlias: string;
    initialLevel: 0 | 1;
    previousLevel: 0 | 1;
    level: 0 | 1;
    sequenceIndex: number;
    detentIndex?: number;
    phaseIndex?: number;
    requestedCycle: number;
    appliedCycle: number;
    delivery: 'avr8js-setPin-clock-event';
  }
  | {
    kind: 'external-interrupt-entered';
    controller: 'INT0';
    pinAlias: 'D2';
    edge: 'falling';
    vectorWordAddress: 2;
    inputRequestedCycle: number;
    inputAppliedCycle: number;
    entryCycle: number;
    delivery: 'avr8js-gpio-external-interrupt';
  }
  | {
    kind: 'external-interrupt-entered';
    controller: 'PCINT2';
    pinAlias: 'D4';
    edge: 'change';
    vectorWordAddress: 10;
    inputRequestedCycle: number;
    inputAppliedCycle: number;
    entryCycle: number;
    delivery: 'avr8js-gpio-external-interrupt';
  }
  | {
    kind: 'timer-counter-read';
    controller: 'TIMER1';
    counter: 'TCNT1';
    pinAlias: 'D5';
    edge: 'rising';
    counterValue: number;
    readCycle: number;
    clockSelect: 7;
    delivery: 'avr8js-timer1-tcnt-read-hook';
  }
  | {
    kind: 'neopixel-frame-intent';
    controller: 'GPIOD6';
    colorOrder: 'GRB';
    bytes: [number, number, number];
    bitCount: 24;
    frameStartCycle: number;
    frameEndCycle: number;
    zeroHighCycles: number;
    oneHighCycles: number;
    highCycles: number[];
    decode: 'fixture-exact-modeled-high-cycles';
  }
  | {
    kind: 'eeprom-write';
    controller: 'EEPROM';
    address: number;
    value: number;
    requestCycle: number;
    readyCycle: number;
    mode: 'erase-and-write';
    delivery: 'avr8js-eeprom-memory-backend';
  }
  | {
    kind: 'eeprom-read';
    controller: 'EEPROM';
    address: number;
    value: number;
    readCycle: number;
    delivery: 'avr8js-eeprom-memory-backend';
  }
  | {
    kind: 'watchdog-reset';
    controller: 'WDT';
    resetCycle: number;
    mcusrReadCycle: number;
    mcusrValue: number;
    watchdogClockHz: 128_000;
    prescaler: 2_048;
    mode: 'system-reset';
    delivery: 'avr8js-watchdog-timeout';
  };

/** Final logical state of a part (LED on, servo angle, ...) for the canvas. */
export interface PartState {
  /** Stable Circuit JSON identity; display names are never used as joins. */
  sourceComponentId?: string;
  name: string;
  kind: string;
  /** Display fields, e.g. { on: true } or { angle: 90 }. */
  state: Record<string, unknown>;
}

export interface SimResult {
  ok: boolean;
  mode: Exclude<SimMode, 'auto'>;
  /** Engine actually used (e.g. 'ngspice', 'avr8js', 'rp2040js', 'logical'). */
  engine: string;
  durationMs: number;
  /** Simulated time span covered, in milliseconds. */
  simulatedMs?: number;
  traces: SimTrace[];
  serial: SerialLine[];
  /** Exact engine peripheral callbacks, bounded by the runner. */
  peripheralEvents?: PeripheralEvent[];
  peripheralEventsOmitted?: number;
  /** Strict normalized modeled input used by a bundled fixture, when supported. */
  modeledStimulus?: Record<string, number>;
  parts: PartState[];
  /** Short, agent-readable observations ("3.3V rail sags to 2.9V"). */
  notes: string[];
  /** Exact bundled firmware identity when a fixture, rather than a path, ran. */
  firmwareFixture?: {
    id: FirmwareFixtureId;
    sha256: string;
    sourcePath: string;
    limitations: string[];
  };
  error?: string;
}

export interface SimRequest {
  mode?: SimMode;
  /** For MCU sims: which emulator family. */
  mcu?: McuTarget;
  /** For MCU sims: path to a compiled firmware (.hex) or raw Intel-HEX text. */
  firmware?: string;
  /** Bundled, reviewable firmware image. Mutually exclusive with `firmware`. */
  fixture?: FirmwareFixtureId;
  /** How long to simulate, in milliseconds of circuit/firmware time. */
  durationMs?: number;
  /** Optional strict stimulus: logical inputs, or fixture-specific modeled inputs. */
  stimulus?: Record<string, unknown>;
}

export interface SimContext {
  circuitJson: AnyCircuitElement[];
  /** Source `.tsx`/`.json` text, when the engine needs the original. */
  code?: string;
  /** Resolve a workspace-relative or absolute path to its text (firmware). */
  readFile?: (path: string) => Promise<string>;
}

export function emptyResult(mode: Exclude<SimMode, 'auto'>, engine: string): SimResult {
  return { ok: false, mode, engine, durationMs: 0, traces: [], serial: [], parts: [], notes: [] };
}
