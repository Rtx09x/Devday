/**
 * AVR firmware emulation (avr8js)
 *
 * Runs the *actual* compiled sketch for ATmega328P-class boards (Arduino Uno) in
 * pure JS -- no native toolchain, no backend. We load an Intel-HEX image into an
 * avr8js CPU, wire up the three timers, the GPIO ports and USART0, then step the
 * core for a bounded slice of firmware time. GPIO transitions become digital
 * scope traces; USART bytes become serial-monitor lines. Bounded by both a cycle
 * budget and a wall-clock cap so a runaway sketch can never freeze the editor.
 */

import {
  CPU,
  avrInstruction,
  AVRTimer,
  timer0Config,
  timer1Config,
  timer2Config,
  AVRIOPort,
  portBConfig,
  portCConfig,
  portDConfig,
  AVRUSART,
  usart0Config,
  AVRSPI,
  spiConfig,
  AVRADC,
  adcConfig,
  ADCMuxInputType,
  ADCReference,
  AVRTWI,
  twiConfig,
  type TWIEventHandler,
  AVREEPROM,
  EEPROMMemoryBackend,
  eepromConfig,
  AVRClock,
  AVRWatchdog,
  watchdogConfig,
  PinState,
} from 'avr8js';
import { parseIntelHex } from './intelHex.ts';
import type { PeripheralEvent, SerialLine, SimTrace } from './types.ts';

const FREQ_HZ = 16_000_000; // Arduino Uno: 16 MHz
const WALL_CLOCK_CAP_MS = 4000; // never block the renderer longer than this
const MAX_PERIPHERAL_EVENTS = 256;

export interface AvrRunResult {
  traces: SimTrace[];
  serial: SerialLine[];
  peripheralEvents: PeripheralEvent[];
  peripheralEventsOmitted: number;
  simulatedMs: number;
  cycles: number;
  hitCap: boolean;
}

interface PinSamples {
  label: string;
  port: string;
  bit: number;
  t: number[];
  v: number[];
  cycles: number[];
}

/** Arduino digital-pin labels for the pins worth tracing by default. */
const PORT_PIN_LABELS: Record<string, Record<number, string>> = {
  B: { 0: 'D8', 1: 'D9', 2: 'D10', 3: 'D11', 4: 'D12', 5: 'D13(LED)' },
  C: { 0: 'A0', 1: 'A1', 2: 'A2', 3: 'A3', 4: 'A4', 5: 'A5' },
  D: { 0: 'D0', 1: 'D1', 2: 'D2', 3: 'D3', 4: 'D4', 5: 'D5', 6: 'D6', 7: 'D7' },
};

export function runAvrFirmware(hex: string, durationMs: number): AvrRunResult {
  const program = new Uint16Array(0x8000); // 32K words = 64KB flash
  const image = parseIntelHex(hex, program.byteLength);
  new Uint8Array(program.buffer).set(image.bytes.subarray(0, program.byteLength));
  return runAvrProgram(program, durationMs);
}

/** Run a pre-assembled program image (word array). Used by the built-in demo. */
export function runAvrProgram(
  program: Uint16Array,
  durationMs: number,
  options: {
    adc0Voltage?: number;
    captureEepromEvents?: boolean;
    captureExternalInterrupt?: {
      controller: 'INT0'; pinAlias: 'D2'; vectorWordAddress: 2; edge: 'falling';
    } | {
      controller: 'PCINT2'; pinAlias: 'D4'; vectorWordAddress: 10; edge: 'change';
    };
    captureTimer1ExternalCount?: boolean;
    captureWatchdogEvents?: boolean;
    syntheticI2cWriteAck?: boolean;
    uart0RxByte?: number;
    scheduledDigitalInputs?: Array<{
      port: 'D'; bit: number; pinAlias: string; initialLevel: 0 | 1;
      transitions: Array<{
        level: 0 | 1; requestedCycle: number; detentIndex?: number; phaseIndex?: number;
      }>;
    }>;
  } = {},
): AvrRunResult {
  const cpu = new CPU(program);
  // Timers must exist so millis()/delay() and PWM advance.
  new AVRTimer(cpu, timer0Config);
  const timer1 = new AVRTimer(cpu, timer1Config);
  new AVRTimer(cpu, timer2Config);
  const portB = new AVRIOPort(cpu, portBConfig);
  const portC = new AVRIOPort(cpu, portCConfig);
  const portD = new AVRIOPort(cpu, portDConfig);
  const usart = new AVRUSART(cpu, usart0Config, FREQ_HZ);
  const spi = new AVRSPI(cpu, spiConfig, FREQ_HZ);

  const peripheralEvents: PeripheralEvent[] = [];
  let peripheralEventsOmitted = 0;
  const recordPeripheralEvent = (event: PeripheralEvent) => {
    if (peripheralEvents.length < MAX_PERIPHERAL_EVENTS) peripheralEvents.push(event);
    else peripheralEventsOmitted += 1;
  };

  // Timer1 exists for every AVR run, but only the exact bundled pulse-counter
  // fixture asks us to classify its one firmware TCNT1 read as evidence.
  if (options.captureTimer1ExternalCount) {
    const originalTimer1Read = cpu.readHooks[timer1Config.TCNT];
    let captured = false;
    cpu.readHooks[timer1Config.TCNT] = (address) => {
      const value = originalTimer1Read ? originalTimer1Read(address) : cpu.data[address];
      if (!captured) {
        captured = true;
        recordPeripheralEvent({
          kind: 'timer-counter-read', controller: 'TIMER1', counter: 'TCNT1',
          pinAlias: 'D5', edge: 'rising', counterValue: timer1.debugTCNT,
          readCycle: cpu.cycles, clockSelect: (cpu.data[timer1Config.TCCRB] & 0x7) as 7,
          delivery: 'avr8js-timer1-tcnt-read-hook',
        });
      }
      return value;
    };
  }

  // avr8js watchdog behavior is available for every AVR run, but its reset
  // event is classified only for the one exact bundled fixture that requests
  // this evidence. The MCUSR read proves firmware observed WDRF after reset.
  const clock = new AVRClock(cpu, FREQ_HZ);
  let pendingWatchdogResetCycle: number | undefined;
  if (options.captureWatchdogEvents) {
    const originalReset = cpu.reset.bind(cpu);
    cpu.reset = () => {
      pendingWatchdogResetCycle = cpu.cycles;
      originalReset();
    };
    const originalMcusrRead = cpu.readHooks[watchdogConfig.MCUSR];
    cpu.readHooks[watchdogConfig.MCUSR] = (address) => {
      const value = originalMcusrRead ? originalMcusrRead(address) : cpu.data[address];
      if (pendingWatchdogResetCycle != null && (value & 0x08) !== 0) {
        recordPeripheralEvent({
          kind: 'watchdog-reset', controller: 'WDT',
          resetCycle: pendingWatchdogResetCycle, mcusrReadCycle: cpu.cycles,
          mcusrValue: value, watchdogClockHz: 128_000, prescaler: 2_048,
          mode: 'system-reset', delivery: 'avr8js-watchdog-timeout',
        });
        pendingWatchdogResetCycle = undefined;
      }
      return value;
    };
  }
  new AVRWatchdog(cpu, watchdogConfig, clock);

  const eepromMemory = new EEPROMMemoryBackend(1024);
  let pendingEepromErase: { address: number; requestCycle: number } | undefined;
  const eepromBackend = {
    readMemory: (address: number) => {
      const value = eepromMemory.readMemory(address);
      if (options.captureEepromEvents) {
        recordPeripheralEvent({
          kind: 'eeprom-read', controller: 'EEPROM', address, value,
          readCycle: cpu.cycles, delivery: 'avr8js-eeprom-memory-backend',
        });
      }
      return value;
    },
    eraseMemory: (address: number) => {
      pendingEepromErase = { address, requestCycle: cpu.cycles };
      eepromMemory.eraseMemory(address);
    },
    writeMemory: (address: number, value: number) => {
      const pending = pendingEepromErase;
      eepromMemory.writeMemory(address, value);
      if (options.captureEepromEvents) {
        recordPeripheralEvent({
          kind: 'eeprom-write', controller: 'EEPROM', address, value,
          requestCycle: pending?.address === address ? pending.requestCycle : cpu.cycles,
          readyCycle: cpu.cycles + eepromConfig.eraseCycles + eepromConfig.writeCycles,
          mode: 'erase-and-write', delivery: 'avr8js-eeprom-memory-backend',
        });
      }
      pendingEepromErase = undefined;
    },
  };
  new AVREEPROM(cpu, eepromBackend, eepromConfig);

  if (options.scheduledDigitalInputs?.length) {
    const scheduledInputs = options.scheduledDigitalInputs;
    const transitions = scheduledInputs.flatMap((input) => input.transitions.map((transition) => ({ input, transition })))
      .sort((a, b) => a.transition.requestedCycle - b.transition.requestedCycle);
    if (scheduledInputs.length > 2 || transitions.length > 16) throw new Error('Scheduled AVR digital input plan exceeds the bounded two-pin/16-transition limit.');
    const seenBits = new Set<number>();
    const plannedLevelByBit = new Map<number, 0 | 1>();
    for (const input of scheduledInputs) {
      if (!Number.isInteger(input.bit) || input.bit < 0 || input.bit > 7 || seenBits.has(input.bit)) throw new Error('Scheduled AVR digital input pins must be unique GPIOD bits 0..7.');
      seenBits.add(input.bit);
      plannedLevelByBit.set(input.bit, input.initialLevel);
      portD.setPin(input.bit, input.initialLevel === 1);
    }
    let previousRequestedCycle = -1;
    transitions.forEach(({ input, transition }, sequenceIndex) => {
      if (!Number.isSafeInteger(transition.requestedCycle) || transition.requestedCycle <= previousRequestedCycle) throw new Error('Scheduled AVR digital input cycles must be safe, globally strictly increasing integers.');
      const previousLevel = plannedLevelByBit.get(input.bit);
      if (previousLevel == null || transition.level === previousLevel) throw new Error('Scheduled AVR digital input transitions must change one planned pin level.');
      plannedLevelByBit.set(input.bit, transition.level);
      previousRequestedCycle = transition.requestedCycle;
      cpu.addClockEvent(() => {
        const state = portD.pinState(input.bit);
        if (state !== PinState.Input && state !== PinState.InputPullUp) return;
        portD.setPin(input.bit, transition.level === 1);
        recordPeripheralEvent({
          kind: 'gpio-input-injected', controller: 'GPIOD', port: input.port,
          bit: input.bit, pinAlias: input.pinAlias, initialLevel: input.initialLevel,
          previousLevel, level: transition.level, sequenceIndex,
          ...(transition.detentIndex == null ? {} : { detentIndex: transition.detentIndex }),
          ...(transition.phaseIndex == null ? {} : { phaseIndex: transition.phaseIndex }),
          requestedCycle: transition.requestedCycle, appliedCycle: cpu.cycles,
          delivery: 'avr8js-setPin-clock-event',
        });
      }, transition.requestedCycle);
    });
  }

  const uartConfig = () => ({
    baudRate: usart.baudRate,
    bitsPerChar: usart.bitsPerChar,
    stopBits: usart.stopBits,
    parity: !usart.parityEnabled ? 'none' as const : usart.parityOdd ? 'odd' as const : 'even' as const,
  });
  let uartInjectionRequestCycle: number | undefined;
  if (options.uart0RxByte != null) {
    usart.onRxComplete = () => {
      if (uartInjectionRequestCycle == null) return;
      recordPeripheralEvent({
        kind: 'uart-rx-injected', controller: 'USART0', byte: options.uart0RxByte!,
        requestCycle: uartInjectionRequestCycle, completeCycle: cpu.cycles,
        ...uartConfig(), delivery: 'avr8js-writeByte-scheduled',
      });
    };
  }

  const adc = new AVRADC(cpu, adcConfig);
  adc.avcc = 5;
  if (options.adc0Voltage != null) {
    adc.channelValues[0] = options.adc0Voltage;
    const defaultOnADCRead = adc.onADCRead;
    adc.onADCRead = (input) => {
      const startCycle = cpu.cycles;
      if (input.type === ADCMuxInputType.SingleEnded && input.channel === 0
        && adc.referenceVoltageType === ADCReference.AVCC && adc.referenceVoltage === 5) {
        const raw = Math.min(Math.max(Math.floor((options.adc0Voltage! / 5) * 1024), 0), 1023);
        const conversionCycles = adc.sampleCycles;
        cpu.addClockEvent(() => {
          adc.completeADCRead(raw);
          recordPeripheralEvent({
            kind: 'adc-sample', controller: 'ADC0', channel: 'ADC0', pinAlias: 'A0',
            startCycle, completeCycle: cpu.cycles,
            inputVoltage: options.adc0Voltage!, reference: 'AVCC', referenceVoltage: 5,
            resolutionBits: 10, raw,
          });
        }, conversionCycles);
        return;
      }
      defaultOnADCRead(input);
    };
  }

  const twi = new AVRTWI(cpu, twiConfig, FREQ_HZ);
  if (options.syntheticI2cWriteAck) {
    let startCycle: number | undefined;
    let address7Bit: number | undefined;
    let write = false;
    let bytes: number[] = [];
    let syntheticAckCount = 0;
    let transactionValid = false;
    const handler: TWIEventHandler = {
      start: (repeated) => {
        startCycle = cpu.cycles;
        address7Bit = undefined;
        write = false;
        bytes = [];
        syntheticAckCount = 0;
        transactionValid = !repeated;
        twi.completeStart();
      },
      stop: () => {
        const stopCycle = cpu.cycles;
        twi.completeStop();
        if (transactionValid && startCycle != null && address7Bit != null && write) {
          recordPeripheralEvent({
            kind: 'i2c-write-intent', controller: 'TWI0', address7Bit, bytes: [...bytes],
            startCycle, stopCycle,
            responseMode: 'synthetic-ack-for-controller-progress', syntheticAckCount,
          });
        }
        startCycle = undefined;
        address7Bit = undefined;
        write = false;
        bytes = [];
        syntheticAckCount = 0;
        transactionValid = false;
      },
      connectToSlave: (address, isWrite) => {
        address7Bit = address;
        write = isWrite;
        if (!isWrite) transactionValid = false;
        syntheticAckCount += 1;
        twi.completeConnect(true);
      },
      writeByte: (value) => {
        bytes.push(value);
        syntheticAckCount += 1;
        twi.completeWrite(true);
      },
      readByte: () => {
        transactionValid = false;
        twi.completeRead(0xff);
      },
    };
    twi.eventHandler = handler;
  }

  // Byte-level controller evidence only. The deterministic 0xff response keeps
  // firmware progressing and represents an idle emulator response, not a modeled peripheral.
  spi.onByte = (tx) => {
    const startCycle = cpu.cycles;
    const transferCycles = spi.transferCycles;
    const event: PeripheralEvent = {
      kind: 'spi-transfer',
      controller: 'SPI0',
      startCycle,
      completeCycle: startCycle + transferCycles,
      tx,
      rx: 0xff,
      master: spi.isMaster,
      mode: spi.spiMode,
      dataOrder: spi.dataOrder,
      clockDivider: spi.clockDivider,
      modeledFrequencyHz: spi.spiFrequency,
    };
    recordPeripheralEvent(event);
    cpu.addClockEvent(() => spi.completeTransfer(event.rx), transferCycles);
  };

  // --- Serial capture ---
  const serial: SerialLine[] = [];
  let lineBuf = '';
  usart.onByteTransmit = (value: number) => {
    if (options.uart0RxByte != null) {
      recordPeripheralEvent({ kind: 'uart-tx', controller: 'USART0', byte: value, writeCycle: cpu.cycles, ...uartConfig() });
    }
    const ch = String.fromCharCode(value);
    if (ch === '\n') {
      serial.push({ t: cpu.cycles / (FREQ_HZ / 1000), text: lineBuf });
      lineBuf = '';
    } else if (ch !== '\r') {
      lineBuf += ch;
    }
  };

  // --- GPIO capture ---
  const samples = new Map<string, PinSamples>();
  const last = new Map<string, number>();
  const watch = (port: AVRIOPort, portLetter: string) => {
    port.addListener(() => {
      const now = cpu.cycles / FREQ_HZ;
      const labels = PORT_PIN_LABELS[portLetter] ?? {};
      for (let pin = 0; pin < 8; pin++) {
        const state = port.pinState(pin);
        const level = state === PinState.High ? 1 : 0;
        const key = `${portLetter}${pin}`;
        if (last.get(key) === level) continue;
        last.set(key, level);
        let s = samples.get(key);
        if (!s) {
          // Only start tracing a pin once it is driven as an output.
          if (state === PinState.Input || state === PinState.InputPullUp) continue;
          s = { label: labels[pin] ?? `P${key}`, port: portLetter, bit: pin, t: [0], v: [level === 1 ? 0 : 1], cycles: [0] };
          samples.set(key, s);
        }
        s.t.push(now);
        s.v.push(level);
        s.cycles.push(cpu.cycles);
      }
    });
  };
  watch(portB, 'B');
  watch(portC, 'C');
  watch(portD, 'D');

  // --- Execution loop (bounded by cycles AND wall clock) ---
  const targetCycles = Math.round((durationMs / 1000) * FREQ_HZ);
  const wallStart = performance.now();
  let hitCap = false;
  let uartInjectionAttempted = false;
  let externalInterruptCaptured = false;
  while (cpu.cycles < targetCycles) {
    avrInstruction(cpu);
    cpu.tick();
    if (options.captureExternalInterrupt && !externalInterruptCaptured
      && cpu.pc === options.captureExternalInterrupt.vectorWordAddress) {
      const inputEvent = [...peripheralEvents].reverse().find((event) => event.kind === 'gpio-input-injected'
        && event.pinAlias === options.captureExternalInterrupt!.pinAlias);
      if (inputEvent?.kind === 'gpio-input-injected') {
        externalInterruptCaptured = true;
        const common = {
          kind: 'external-interrupt-entered' as const,
          inputRequestedCycle: inputEvent.requestedCycle,
          inputAppliedCycle: inputEvent.appliedCycle,
          entryCycle: cpu.cycles,
          delivery: 'avr8js-gpio-external-interrupt' as const,
        };
        recordPeripheralEvent(options.captureExternalInterrupt.controller === 'INT0'
          ? { ...common, controller: 'INT0', pinAlias: 'D2', edge: 'falling', vectorWordAddress: 2 }
          : { ...common, controller: 'PCINT2', pinAlias: 'D4', edge: 'change', vectorWordAddress: 10 });
      }
    }
    if (options.uart0RxByte != null && !uartInjectionAttempted && cpu.cycles >= 256 && cpu.cycles <= 4096 && usart.rxEnable && !usart.rxBusy) {
      uartInjectionAttempted = true;
      uartInjectionRequestCycle = cpu.cycles;
      if (!usart.writeByte(options.uart0RxByte, false)) uartInjectionRequestCycle = undefined;
    }
    // Cheap wall-clock guard: check every ~100k cycles.
    if ((cpu.cycles & 0x1ffff) === 0 && performance.now() - wallStart > WALL_CLOCK_CAP_MS) {
      hitCap = true;
      break;
    }
  }
  const simulatedMs = cpu.cycles / (FREQ_HZ / 1000);
  if (lineBuf) serial.push({ t: simulatedMs, text: lineBuf });

  // Close out traces at the final time so the scope draws to the end.
  const traces: SimTrace[] = [];
  for (const s of samples.values()) {
    const endT = simulatedMs / 1000;
    if (s.t[s.t.length - 1] < endT) {
      s.t.push(endT);
      s.v.push(s.v[s.v.length - 1]);
      s.cycles.push(cpu.cycles);
    }
    const arduinoAlias = PORT_PIN_LABELS[s.port]?.[s.bit]?.replace(/\(.*\)$/, '');
    traces.push({
      name: s.label,
      unit: 'digital',
      t: s.t,
      v: s.v,
      timing: { domain: 'emulator-cycles', clockHz: FREQ_HZ, sampleCycles: s.cycles },
      origin: {
        family: 'avr',
        port: s.port,
        bit: s.bit,
        aliases: [arduinoAlias, `P${s.port}${s.bit}`].filter((alias): alias is string => Boolean(alias)),
      },
    });
  }

  return { traces, serial, peripheralEvents, peripheralEventsOmitted, simulatedMs, cycles: cpu.cycles, hitCap };
}
