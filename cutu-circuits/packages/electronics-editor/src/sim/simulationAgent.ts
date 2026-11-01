import type { CanvasFeedback } from './canvasFeedback.ts';
import type { SimResult } from './types.ts';
import { canonicalServoPulseTransitions, deriveServoPulseIntentEvidence } from './servoPulseIntent.ts';
import { canonicalTimer2ToneTransitions, deriveTimer2ToneIntentEvidence } from './timer2ToneIntent.ts';
import { deriveAdcPwmControllerIntentEvidence } from './adcPwmControllerIntent.ts';
import { canonicalEepromRoundtrip, deriveEepromRoundtripIntentEvidence } from './eepromRoundtripIntent.ts';
import { canonicalWatchdogReset, deriveWatchdogResetIntentEvidence } from './watchdogResetIntent.ts';
import { canonicalExternalInterrupt, deriveInt0InterruptIntentEvidence } from './int0InterruptIntent.ts';
import { canonicalTimer1ExternalCount, deriveTimer1PulseCounterIntentEvidence } from './timer1PulseCounterIntent.ts';
import { canonicalPcintMask, derivePcintMaskIntentEvidence } from './pcintMaskIntent.ts';

export const MAX_SIM_AGENT_TRACES = 12;
export const MAX_SIM_AGENT_SERIAL_LINES = 24;
export const MAX_SIM_AGENT_PARTS = 16;
export const MAX_SIM_AGENT_NOTES = 16;
export const MAX_SIM_AGENT_FEEDBACK_ITEMS = 16;
export const MAX_SIM_AGENT_PERIPHERAL_EVENTS = 32;
export const MAX_SIM_AGENT_FIELD_BYTES = 240;
export const MAX_SIM_AGENT_SNAPSHOT_BYTES = 8_192;

export interface SimulationAgentSnapshot {
  targetKey: string;
  label: string;
  description: string;
  omittedDescriptionBytes: number;
}

const encoder = new TextEncoder();

function boundedText(value: unknown, field: string, maxBytes = MAX_SIM_AGENT_FIELD_BYTES): string {
  if (typeof value !== 'string') throw new Error(`Simulation evidence requires ${field} to be a string.`);
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error(`Simulation evidence requires non-empty ${field}.`);
  if (encoder.encode(normalized).length <= maxBytes) return normalized;
  const suffix = '…';
  const budget = maxBytes - encoder.encode(suffix).length;
  let result = '';
  for (const point of normalized) {
    if (encoder.encode(result + point).length > budget) break;
    result += point;
  }
  return result + suffix;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value == null ? undefined : boundedText(value, field);
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Simulation evidence requires finite ${field}.`);
  return value;
}

function byte(value: unknown, field: string): number {
  const result = finite(value, field);
  if (!Number.isSafeInteger(result) || result < 0 || result > 255) throw new Error(`Simulation evidence requires ${field} to be an exact byte.`);
  return result;
}

function finiteSeries(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Simulation evidence requires a non-empty ${field} array.`);
  return value.map((entry, index) => finite(entry, `${field}[${index}]`));
}

function boundedDescription(value: string): { description: string; omittedDescriptionBytes: number } {
  const exactBytes = encoder.encode(value).length;
  if (exactBytes <= MAX_SIM_AGENT_SNAPSHOT_BYTES) return { description: value, omittedDescriptionBytes: 0 };
  const suffix = '\n[presentation omitted to fit the 8192-byte simulation snapshot limit]';
  const budget = MAX_SIM_AGENT_SNAPSHOT_BYTES - encoder.encode(suffix).length;
  let prefix = '';
  for (const point of value) {
    if (encoder.encode(prefix + point).length > budget) break;
    prefix += point;
  }
  return {
    description: prefix + suffix,
    omittedDescriptionBytes: exactBytes - encoder.encode(prefix).length,
  };
}

function boundedJsonFact(value: unknown, field: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Simulation evidence could not serialize ${field}.`);
  }
  if (typeof serialized !== 'string') throw new Error(`Simulation evidence requires serializable ${field}.`);
  return boundedText(serialized, field);
}

export function buildSimulationAgentSnapshot(options: {
  runId: number;
  result: SimResult;
  feedback: CanvasFeedback | null;
}): SimulationAgentSnapshot {
  if (!Number.isSafeInteger(options.runId) || options.runId < 1) throw new Error('Simulation evidence requires a positive exact run ID.');
  const result = options.result;
  const mode = result.mode;
  if (mode !== 'logical' && mode !== 'analog' && mode !== 'mcu') throw new Error('Simulation evidence found an unsupported mode.');
  const engine = boundedText(result.engine, 'engine');
  const durationMs = finite(result.durationMs, 'wall duration');
  const simulatedMs = result.simulatedMs == null ? undefined : finite(result.simulatedMs, 'simulated duration');
  if (!Array.isArray(result.traces) || !Array.isArray(result.serial) || !Array.isArray(result.parts) || !Array.isArray(result.notes)) {
    throw new Error('Simulation evidence requires exact trace, serial, part, and note arrays.');
  }

  const traces = result.traces.slice(0, MAX_SIM_AGENT_TRACES).map((trace, traceIndex) => {
    const t = finiteSeries(trace.t, `trace ${traceIndex} times`);
    const v = finiteSeries(trace.v, `trace ${traceIndex} values`);
    if (t.length !== v.length) throw new Error(`Simulation evidence requires trace ${traceIndex} time/value lengths to match.`);
    let valueMin = v[0];
    let valueMax = v[0];
    for (const value of v) {
      valueMin = Math.min(valueMin, value);
      valueMax = Math.max(valueMax, value);
    }
    const origin = trace.origin?.family === 'avr'
      ? {
        family: 'avr' as const,
        port: boundedText(trace.origin.port, 'AVR port'),
        bit: finite(trace.origin.bit, 'AVR bit'),
        aliases: trace.origin.aliases.slice(0, 8).map((alias) => boundedText(alias, 'AVR alias')),
      }
      : trace.origin?.family === 'rp2040'
        ? {
          family: 'rp2040' as const,
          pin: finite(trace.origin.pin, 'RP2040 pin'),
          aliases: trace.origin.aliases.slice(0, 8).map((alias) => boundedText(alias, 'RP2040 alias')),
        }
        : undefined;
    return {
      name: boundedText(trace.name, 'trace name'),
      unit: trace.unit,
      sampleCount: t.length,
      timeStartSeconds: t[0],
      timeEndSeconds: t[t.length - 1],
      valueFirst: v[0],
      valueLast: v[v.length - 1],
      valueMin,
      valueMax,
      ...(origin ? { origin } : {}),
    };
  });

  const fixture = result.firmwareFixture ? {
    id: boundedText(result.firmwareFixture.id, 'fixture ID'),
    sha256: boundedText(result.firmwareFixture.sha256, 'fixture digest'),
    sourcePath: boundedText(result.firmwareFixture.sourcePath, 'fixture source path'),
    limitations: result.firmwareFixture.limitations.slice(0, MAX_SIM_AGENT_NOTES)
      .map((entry) => boundedText(entry, 'fixture limitation')),
    omittedLimitations: Math.max(0, result.firmwareFixture.limitations.length - MAX_SIM_AGENT_NOTES),
  } : undefined;
  const peripheralEvents = (result.peripheralEvents ?? []).slice(0, MAX_SIM_AGENT_PERIPHERAL_EVENTS).map((event, index) => {
    if (event.kind === 'gpio-input-injected') {
      return {
        kind: event.kind,
        controller: event.controller,
        port: event.port,
        bit: finite(event.bit, `peripheral event ${index} GPIO bit`),
        pinAlias: boundedText(event.pinAlias, `peripheral event ${index} pin alias`),
        initialLevel: event.initialLevel,
        previousLevel: event.previousLevel,
        level: event.level,
        sequenceIndex: finite(event.sequenceIndex, `peripheral event ${index} sequence index`),
        ...(event.detentIndex == null ? {} : { detentIndex: finite(event.detentIndex, `peripheral event ${index} detent index`) }),
        ...(event.phaseIndex == null ? {} : { phaseIndex: finite(event.phaseIndex, `peripheral event ${index} phase index`) }),
        requestedCycle: finite(event.requestedCycle, `peripheral event ${index} requested cycle`),
        appliedCycle: finite(event.appliedCycle, `peripheral event ${index} applied cycle`),
        delivery: event.delivery,
      };
    }
    if (event.kind === 'uart-rx-injected') {
      return {
        kind: event.kind, controller: event.controller,
        byte: byte(event.byte, `peripheral event ${index} RX byte`),
        requestCycle: finite(event.requestCycle, `peripheral event ${index} request cycle`),
        completeCycle: finite(event.completeCycle, `peripheral event ${index} complete cycle`),
        baudRate: finite(event.baudRate, `peripheral event ${index} modeled baud`),
        bitsPerChar: finite(event.bitsPerChar, `peripheral event ${index} data bits`),
        stopBits: finite(event.stopBits, `peripheral event ${index} stop bits`),
        parity: event.parity, delivery: event.delivery,
      };
    }
    if (event.kind === 'uart-tx') {
      return {
        kind: event.kind, controller: event.controller,
        byte: byte(event.byte, `peripheral event ${index} TX byte`),
        writeCycle: finite(event.writeCycle, `peripheral event ${index} write cycle`),
        baudRate: finite(event.baudRate, `peripheral event ${index} modeled baud`),
        bitsPerChar: finite(event.bitsPerChar, `peripheral event ${index} data bits`),
        stopBits: finite(event.stopBits, `peripheral event ${index} stop bits`),
        parity: event.parity,
      };
    }
    if (event.kind === 'i2c-write-intent') {
      return {
        kind: event.kind,
        controller: event.controller,
        address7Bit: finite(event.address7Bit, `peripheral event ${index} address`),
        bytes: event.bytes.map((value, byteIndex) => byte(value, `peripheral event ${index} byte ${byteIndex}`)),
        startCycle: finite(event.startCycle, `peripheral event ${index} start cycle`),
        stopCycle: finite(event.stopCycle, `peripheral event ${index} stop cycle`),
        responseMode: event.responseMode,
        syntheticAckCount: finite(event.syntheticAckCount, `peripheral event ${index} synthetic ACK count`),
      };
    }
    if (event.kind === 'adc-sample') {
      return {
        kind: event.kind,
        controller: event.controller,
        channel: event.channel,
        pinAlias: event.pinAlias,
        startCycle: finite(event.startCycle, `peripheral event ${index} start cycle`),
        completeCycle: finite(event.completeCycle, `peripheral event ${index} complete cycle`),
        inputVoltage: finite(event.inputVoltage, `peripheral event ${index} input voltage`),
        reference: event.reference,
        referenceVoltage: finite(event.referenceVoltage, `peripheral event ${index} reference voltage`),
        resolutionBits: finite(event.resolutionBits, `peripheral event ${index} resolution`),
        raw: finite(event.raw, `peripheral event ${index} raw result`),
      };
    }
    if (event.kind === 'neopixel-frame-intent') {
      return {
        kind: event.kind,
        controller: event.controller,
        colorOrder: event.colorOrder,
        bytes: event.bytes.map((value, byteIndex) => byte(value, `peripheral event ${index} GRB byte ${byteIndex}`)),
        bitCount: finite(event.bitCount, `peripheral event ${index} bit count`),
        frameStartCycle: finite(event.frameStartCycle, `peripheral event ${index} frame start cycle`),
        frameEndCycle: finite(event.frameEndCycle, `peripheral event ${index} frame end cycle`),
        zeroHighCycles: finite(event.zeroHighCycles, `peripheral event ${index} zero high cycles`),
        oneHighCycles: finite(event.oneHighCycles, `peripheral event ${index} one high cycles`),
        highCycles: event.highCycles.map((value, bitIndex) => finite(value, `peripheral event ${index} high cycle ${bitIndex}`)),
        decode: event.decode,
      };
    }
    if (event.kind === 'eeprom-write') {
      return {
        kind: event.kind, controller: event.controller,
        address: finite(event.address, `peripheral event ${index} EEPROM address`),
        value: byte(event.value, `peripheral event ${index} EEPROM value`),
        requestCycle: finite(event.requestCycle, `peripheral event ${index} request cycle`),
        readyCycle: finite(event.readyCycle, `peripheral event ${index} ready cycle`),
        mode: event.mode, delivery: event.delivery,
      };
    }
    if (event.kind === 'eeprom-read') {
      return {
        kind: event.kind, controller: event.controller,
        address: finite(event.address, `peripheral event ${index} EEPROM address`),
        value: byte(event.value, `peripheral event ${index} EEPROM value`),
        readCycle: finite(event.readCycle, `peripheral event ${index} read cycle`),
        delivery: event.delivery,
      };
    }
    if (event.kind === 'watchdog-reset') {
      return {
        kind: event.kind, controller: event.controller,
        resetCycle: finite(event.resetCycle, `peripheral event ${index} watchdog reset cycle`),
        mcusrReadCycle: finite(event.mcusrReadCycle, `peripheral event ${index} MCUSR read cycle`),
        mcusrValue: byte(event.mcusrValue, `peripheral event ${index} MCUSR value`),
        watchdogClockHz: finite(event.watchdogClockHz, `peripheral event ${index} watchdog clock`),
        prescaler: finite(event.prescaler, `peripheral event ${index} watchdog prescaler`),
        mode: event.mode, delivery: event.delivery,
      };
    }
    if (event.kind === 'external-interrupt-entered') {
      return {
        kind: event.kind, controller: event.controller, pinAlias: event.pinAlias,
        edge: event.edge, vectorWordAddress: event.vectorWordAddress,
        inputRequestedCycle: finite(event.inputRequestedCycle, `peripheral event ${index} input request cycle`),
        inputAppliedCycle: finite(event.inputAppliedCycle, `peripheral event ${index} input applied cycle`),
        entryCycle: finite(event.entryCycle, `peripheral event ${index} vector entry cycle`),
        delivery: event.delivery,
      };
    }
    if (event.kind === 'timer-counter-read') {
      return {
        kind: event.kind, controller: event.controller, counter: event.counter,
        pinAlias: event.pinAlias, edge: event.edge,
        counterValue: finite(event.counterValue, `peripheral event ${index} counter value`),
        readCycle: finite(event.readCycle, `peripheral event ${index} counter read cycle`),
        clockSelect: finite(event.clockSelect, `peripheral event ${index} clock select`),
        delivery: event.delivery,
      };
    }
    if (event.kind !== 'spi-transfer' || event.controller !== 'SPI0') throw new Error(`Simulation evidence found unsupported peripheral event ${index}.`);
    return {
      kind: event.kind,
      controller: event.controller,
      startCycle: finite(event.startCycle, `peripheral event ${index} start cycle`),
      completeCycle: finite(event.completeCycle, `peripheral event ${index} complete cycle`),
      tx: byte(event.tx, `peripheral event ${index} TX byte`),
      rx: byte(event.rx, `peripheral event ${index} RX byte`),
      master: event.master === true,
      mode: event.mode,
      dataOrder: event.dataOrder,
      clockDivider: finite(event.clockDivider, `peripheral event ${index} clock divider`),
      modeledFrequencyHz: finite(event.modeledFrequencyHz, `peripheral event ${index} modeled frequency`),
    };
  });

  const feedback = options.feedback ? {
    engine: boundedText(options.feedback.engine, 'feedback engine'),
    components: options.feedback.components.slice(0, MAX_SIM_AGENT_FEEDBACK_ITEMS).map((component) => ({
      sourceComponentId: boundedText(component.sourceComponentId, 'feedback source component ID'),
      kind: component.kind,
      label: boundedText(component.label, 'feedback label'),
    })),
    sourcePortIds: options.feedback.sourcePortIds.slice(0, MAX_SIM_AGENT_FEEDBACK_ITEMS)
      .map((id) => boundedText(id, 'feedback source port ID')),
    connectivityKeys: options.feedback.connectivityKeys.slice(0, MAX_SIM_AGENT_FEEDBACK_ITEMS)
      .map((key) => boundedText(key, 'feedback connectivity key')),
    diagnostics: options.feedback.diagnostics.slice(0, MAX_SIM_AGENT_FEEDBACK_ITEMS)
      .map((entry) => boundedText(entry, 'feedback diagnostic')),
    omittedComponents: Math.max(0, options.feedback.components.length - MAX_SIM_AGENT_FEEDBACK_ITEMS),
    omittedSourcePorts: Math.max(0, options.feedback.sourcePortIds.length - MAX_SIM_AGENT_FEEDBACK_ITEMS),
    omittedConnectivityKeys: Math.max(0, options.feedback.connectivityKeys.length - MAX_SIM_AGENT_FEEDBACK_ITEMS),
    omittedDiagnostics: Math.max(0, options.feedback.diagnostics.length - MAX_SIM_AGENT_FEEDBACK_ITEMS),
  } : null;

  const servoPulse = deriveServoPulseIntentEvidence(result);
  const timer2Tone = deriveTimer2ToneIntentEvidence(result);
  const adcPwmController = deriveAdcPwmControllerIntentEvidence(result);
  const eepromRoundtrip = deriveEepromRoundtripIntentEvidence(result);
  const watchdogReset = deriveWatchdogResetIntentEvidence(result);
  const int0Interrupt = deriveInt0InterruptIntentEvidence(result);
  const timer1PulseCounter = deriveTimer1PulseCounterIntentEvidence(result);
  const pcintMask = derivePcintMaskIntentEvidence(result);
  const payload = {
    evidenceKind: 'completed-local-simulation-observation',
    runId: options.runId,
    ok: result.ok,
    mode,
    engine,
    durationMs,
    ...(simulatedMs == null ? {} : { simulatedMs }),
    ...(optionalText(result.error, 'simulation error') ? { error: optionalText(result.error, 'simulation error') } : {}),
    omissions: {
      traces: Math.max(0, result.traces.length - MAX_SIM_AGENT_TRACES),
      serialLines: Math.max(0, result.serial.length - MAX_SIM_AGENT_SERIAL_LINES),
      parts: Math.max(0, result.parts.length - MAX_SIM_AGENT_PARTS),
      notes: Math.max(0, result.notes.length - MAX_SIM_AGENT_NOTES),
      feedbackComponents: Math.max(0, (options.feedback?.components.length ?? 0) - MAX_SIM_AGENT_FEEDBACK_ITEMS),
      feedbackSourcePorts: Math.max(0, (options.feedback?.sourcePortIds.length ?? 0) - MAX_SIM_AGENT_FEEDBACK_ITEMS),
      feedbackConnectivityKeys: Math.max(0, (options.feedback?.connectivityKeys.length ?? 0) - MAX_SIM_AGENT_FEEDBACK_ITEMS),
      feedbackDiagnostics: Math.max(0, (options.feedback?.diagnostics.length ?? 0) - MAX_SIM_AGENT_FEEDBACK_ITEMS),
      peripheralEvents: Math.max(0, (result.peripheralEvents?.length ?? 0) - MAX_SIM_AGENT_PERIPHERAL_EVENTS) + (result.peripheralEventsOmitted ?? 0),
    },
    traces,
    omittedTraces: Math.max(0, result.traces.length - MAX_SIM_AGENT_TRACES),
    serial: result.serial.slice(0, MAX_SIM_AGENT_SERIAL_LINES).map((line, index) => ({
      tMs: finite(line.t, `serial line ${index} time`),
      text: boundedText(line.text, `serial line ${index} text`),
    })),
    omittedSerialLines: Math.max(0, result.serial.length - MAX_SIM_AGENT_SERIAL_LINES),
    parts: result.parts.slice(0, MAX_SIM_AGENT_PARTS).map((part) => ({
      ...(part.sourceComponentId ? { sourceComponentId: boundedText(part.sourceComponentId, 'part source component ID') } : {}),
      name: boundedText(part.name, 'part name'),
      kind: boundedText(part.kind, 'part kind'),
      stateJson: boundedJsonFact(part.state, 'part state'),
    })),
    omittedParts: Math.max(0, result.parts.length - MAX_SIM_AGENT_PARTS),
    notes: result.notes.slice(0, MAX_SIM_AGENT_NOTES).map((note) => boundedText(note, 'simulation note')),
    omittedNotes: Math.max(0, result.notes.length - MAX_SIM_AGENT_NOTES),
    peripheralEvents,
    omittedPeripheralEvents: Math.max(0, (result.peripheralEvents?.length ?? 0) - MAX_SIM_AGENT_PERIPHERAL_EVENTS) + (result.peripheralEventsOmitted ?? 0),
    ...(fixture ? { firmwareFixture: fixture } : {}),
    ...(result.modeledStimulus ? { modeledStimulus: result.modeledStimulus } : {}),
    ...(servoPulse ? {
      servoPulseIntent: {
        timer: servoPulse.timer,
        outputCompare: servoPulse.outputCompare,
        pin: servoPulse.traceName,
        clockHz: servoPulse.clockHz,
        frequencyHz: servoPulse.frequencyHz,
        periodCycles: servoPulse.periodCycles,
        highPulseMicroseconds: servoPulse.highPulseMicroseconds,
        highCycles: servoPulse.highCycles,
        dutyCycle: servoPulse.dutyCycle,
        completedPulses: servoPulse.completedPulses,
        completePeriods: servoPulse.completePeriods,
        transitionCycles: canonicalServoPulseTransitions(servoPulse.transitionCycles),
        limitation: 'Exact avr8js controller-output intent only; not servo motion, angle, load, calibrated timing, electrical waveform, PCB, or hardware evidence.',
      },
    } : {}),
    ...(timer2Tone ? {
      timer2ToneIntent: {
        timer: timer2Tone.timer,
        outputCompare: timer2Tone.outputCompare,
        pin: timer2Tone.traceName,
        clockHz: timer2Tone.clockHz,
        frequencyHz: timer2Tone.frequencyHz,
        halfPeriodCycles: timer2Tone.halfPeriodCycles,
        periodCycles: timer2Tone.periodCycles,
        dutyCycle: timer2Tone.dutyCycle,
        completePeriods: timer2Tone.completePeriods,
        transitionCycles: canonicalTimer2ToneTransitions(timer2Tone.transitionCycles),
        limitation: 'Exact avr8js controller-output intent only; not emitted sound, loudness, load, calibrated timing, electrical waveform, PCB, or hardware evidence.',
      },
    } : {}),
    ...(adcPwmController ? {
      adcPwmControllerIntent: {
        inputVoltage: adcPwmController.inputVoltage,
        raw: adcPwmController.raw,
        conversionStartCycle: adcPwmController.conversionStartCycle,
        conversionCompleteCycle: adcPwmController.conversionCompleteCycle,
        compareValue: adcPwmController.compareValue,
        clockHz: adcPwmController.clockHz,
        frequencyHz: adcPwmController.frequencyHz,
        periodCycles: adcPwmController.periodCycles,
        highCycles: adcPwmController.highCycles,
        dutyCycle: adcPwmController.dutyCycle,
        completePeriods: adcPwmController.completePeriods,
        limitation: 'Exact avr8js ADC-to-Timer0 controller intent only; not sensor, analog front end, fan, motor, load/current, electrical waveform, PCB, or hardware evidence.',
      },
    } : {}),
    ...(eepromRoundtrip ? {
      eepromRoundtripIntent: {
        addressByte: canonicalEepromRoundtrip(eepromRoundtrip),
        writeRequestCycle: eepromRoundtrip.writeRequestCycle,
        writeReadyCycle: eepromRoundtrip.writeReadyCycle,
        readCycle: eepromRoundtrip.readCycle,
        successCycle: eepromRoundtrip.successCycle,
        successPin: eepromRoundtrip.successPin,
        failurePin: eepromRoundtrip.failurePin,
        limitation: 'Exact avr8js in-memory EEPROM controller/backend and firmware-latch intent only; not retention, endurance, wear, power-loss safety, atomicity, voltage, calibrated timing, PCB, or hardware persistence evidence.',
      },
    } : {}),
    ...(watchdogReset ? {
      watchdogResetIntent: {
        resetMcusr: canonicalWatchdogReset(watchdogReset),
        mcusrReadCycle: watchdogReset.mcusrReadCycle,
        watchdogClockHz: watchdogReset.watchdogClockHz,
        prescaler: watchdogReset.prescaler,
        armedHighCycle: watchdogReset.armedHighCycle,
        armedLowCycle: watchdogReset.armedLowCycle,
        successCycle: watchdogReset.successCycle,
        armedPin: watchdogReset.armedPin,
        successPin: watchdogReset.successPin,
        limitation: 'Exact avr8js watchdog controller/reset and firmware-latch intent only; not calibrated timeout, oscillator, brownout/reset-pin/bootloader behavior, startup safety, voltage, PCB, or hardware-reset evidence.',
      },
    } : {}),
    ...(int0Interrupt ? {
      int0InterruptIntent: {
        canonicalEvidence: canonicalExternalInterrupt(int0Interrupt),
        armedLowCycle: int0Interrupt.armedLowCycle,
        observedHighCycle: int0Interrupt.observedHighCycle,
        inputPin: int0Interrupt.inputPin,
        armedPin: int0Interrupt.armedPin,
        observedPin: int0Interrupt.observedPin,
        edge: int0Interrupt.edge,
        limitation: 'Exact avr8js GPIO external-interrupt/CPU-vector and firmware-latch intent only; not calibrated latency, deadline, priority/nesting, bounce/noise, voltage, electrical edge, startup safety, PCB, or hardware-interrupt evidence.',
      },
    } : {}),
    ...(timer1PulseCounter ? {
      timer1PulseCounterIntent: {
        canonicalEvidence: canonicalTimer1ExternalCount(timer1PulseCounter),
        requestedPulseCount: timer1PulseCounter.requestedPulseCount,
        countedPulseCount: timer1PulseCounter.countedPulseCount,
        readCycle: timer1PulseCounter.readCycle,
        readCompleteCycle: timer1PulseCounter.readCompleteCycle,
        thresholdReached: timer1PulseCounter.thresholdReached,
        ...(timer1PulseCounter.thresholdCycle == null ? {} : { thresholdCycle: timer1PulseCounter.thresholdCycle }),
        inputPin: timer1PulseCounter.inputPin,
        completionPin: timer1PulseCounter.completionPin,
        thresholdPin: timer1PulseCounter.thresholdPin,
        limitation: 'Exact avr8js D5/T1 external-rising counter, TCNT1-read, and firmware-latch intent only; not frequency, RPM/tachometer, calibrated timing, missed-pulse performance, electrical-edge, PCB, or hardware evidence.',
      },
    } : {}),
    ...(pcintMask ? {
      pcintMaskIntent: {
        canonicalEvidence: canonicalPcintMask(pcintMask),
        profile: pcintMask.profile,
        maskRegister: pcintMask.maskRegister,
        maskValue: pcintMask.maskValue,
        controller: pcintMask.controller,
        vectorWordAddress: pcintMask.vectorWordAddress,
        maskedInput: pcintMask.maskedInput,
        ...(pcintMask.enabledInput ? { enabledInput: pcintMask.enabledInput } : {}),
        ...(pcintMask.entryCycle == null ? {} : { entryCycle: pcintMask.entryCycle }),
        ...(pcintMask.armedLowCycle == null ? {} : { armedLowCycle: pcintMask.armedLowCycle }),
        ...(pcintMask.observedHighCycle == null ? {} : { observedHighCycle: pcintMask.observedHighCycle }),
        limitation: 'Exact avr8js PCMSK2/input/vector/latch intent only; not simultaneous-edge ordering, calibrated latency, priority/nesting, bounce/noise immunity, voltage, electrical-edge, PCB, or hardware evidence.',
      },
    } : {}),
    canvasFeedback: feedback,
    limitations: [
      'This is bounded evidence from one completed local simulation run, not a live design claim.',
      'It is not hardware, timing-fidelity, PCB copper or routing, ERC, DRC, manufacturing, physical, or offline validation.',
      'Waveform arrays, raw firmware bytes, and full source/Circuit JSON are intentionally omitted.',
    ],
  };
  const bounded = boundedDescription(JSON.stringify(payload));
  return {
    targetKey: `simulation:${options.runId}`,
    label: `${engine} simulation run ${options.runId}`,
    ...bounded,
  };
}
