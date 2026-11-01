/**
 * MCU firmware simulation dispatch
 *
 * Routes a firmware-emulation request to the right pure-JS core: avr8js for
 * AVR (Arduino Uno class), rp2040js for the Pico, and an honest stub for ESP32
 * -- ESP32 is Xtensa and only emulates under QEMU, which needs a backend
 * (utility-process) module. We resolve firmware from an inline Intel-HEX string
 * or a workspace file, and fall back to a tiny built-in blink demo for AVR so
 * the path is exercisable with zero external files.
 */

import { runAvrFirmware, runAvrProgram } from './avrRunner.ts';
import { runRp2040Firmware, decodeFirmware } from './rp2040Runner.ts';
import { looksLikeHex } from './intelHex.ts';
import { detectMcu } from './detect.ts';
import { emptyResult, type McuTarget, type SimContext, type SimResult } from './types.ts';
import { getFirmwareFixture } from './firmwareFixtures.ts';
import {
  AVR_LIMIT_INTERLOCK_CLOCK_HZ,
  isAvrAdcThresholdStimulus,
  isAvrButtonDebounceStimulus,
  isAvrInt0InterruptStimulus,
  isAvrPcintMaskStimulus,
  isAvrLimitInterlockStimulus,
  isAvrQuadratureDetentStimulus,
  isAvrTimer1PulseCounterStimulus,
  isAvrUartCommandStimulus,
  normalizeFixtureStimulus,
} from './fixtureStimulus.ts';
import { deriveStepDirIntentEvidence } from './stepDirIntent.ts';
import { deriveLimitInterlockEvidence } from './limitInterlockIntent.ts';
import { deriveQuadratureDetentEvidence, quadraturePhasePlan } from './quadratureDetentIntent.ts';
import { buttonDebouncePlan, deriveButtonDebounceEvidence } from './buttonDebounceIntent.ts';
import { deriveNeoPixelFrameIntentEvent } from './neopixelFrameIntent.ts';
import { deriveServoPulseIntentEvidence } from './servoPulseIntent.ts';
import { deriveTimer2ToneIntentEvidence } from './timer2ToneIntent.ts';
import { deriveAdcPwmControllerIntentEvidence } from './adcPwmControllerIntent.ts';
import { deriveEepromRoundtripIntentEvidence } from './eepromRoundtripIntent.ts';
import { deriveWatchdogResetIntentEvidence } from './watchdogResetIntent.ts';
import { deriveInt0InterruptIntentEvidence } from './int0InterruptIntent.ts';
import { deriveTimer1PulseCounterIntentEvidence, timer1PulsePlan } from './timer1PulseCounterIntent.ts';
import { derivePcintMaskIntentEvidence } from './pcintMaskIntent.ts';

/**
 * A minimal hand-assembled ATmega328P program: set PB5 (Arduino D13) as output
 * and toggle it in a busy loop. Verifies the GPIO emulation end-to-end without
 * needing a compiler. Opcodes are little-endian 16-bit words.
 */
export function builtinAvrBlink(): Uint16Array {
  // 0: ldi r16,0x20      E0 20 -> 0xE200   load bit mask (1<<5)
  // 1: out DDRB,r16      B9 04 -> 0xB904   DDRB |= 0x20 (PB5 output)
  // 2: out PINB,r16      B9 03 -> 0xB903   toggle PORTB5 (write-1-to-toggle)
  // 3: ldi r24,0xFF      EF 8F -> 0xEF8F   delay counter low
  // 4: ldi r25,0xFF      EF 9F -> 0xEF9F   delay counter high
  // 5: sbiw r24,1        97 01 -> 0x9701
  // 6: brne -2 (to 5)    F7 F1 -> 0xF7F1
  // 7: rjmp -6 (to 2)    CF FA -> 0xCFFA
  const prog = new Uint16Array(0x8000);
  prog.set([0xe200, 0xb904, 0xb903, 0xef8f, 0xef9f, 0x9701, 0xf7f1, 0xcffa], 0);
  return prog;
}

function avrFixtureProgram(bytes: Uint8Array): Uint16Array {
  if (bytes.byteLength % 2 !== 0) throw new Error('Bundled AVR fixture byte length must be even.');
  const program = new Uint16Array(0x8000);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 2) program[offset / 2] = view.getUint16(offset, true);
  return program;
}

async function resolveFirmware(ctx: SimContext, firmware?: string): Promise<string | undefined> {
  if (!firmware) return undefined;
  if (looksLikeHex(firmware)) return firmware;
  // Treat as a path; read it through the host filesystem service.
  if (ctx.readFile) {
    try {
      return await ctx.readFile(firmware);
    } catch (err) {
      throw new Error(`Could not read firmware "${firmware}": ${(err as Error).message}`);
    }
  }
  return firmware;
}

export async function runMcuSim(
  ctx: SimContext,
  opts: { mcu?: McuTarget; firmware?: string; fixture?: string; durationMs?: number; stimulus?: unknown } = {},
): Promise<SimResult> {
  const started = performance.now();
  const fixture = opts.fixture ? getFirmwareFixture(opts.fixture) : undefined;
  if (opts.fixture && !fixture) {
    const result = emptyResult('mcu', 'none');
    result.error = `Unknown bundled firmware fixture "${opts.fixture}".`;
    return result;
  }
  if (fixture && opts.firmware) {
    const result = emptyResult('mcu', fixture.mcu === 'rp2040' ? 'rp2040js' : 'avr8js');
    result.error = 'Choose either a bundled firmware fixture or firmware input, not both.';
    return result;
  }
  let normalizedStimulus: ReturnType<typeof normalizeFixtureStimulus> = {};
  try {
    if (fixture) normalizedStimulus = normalizeFixtureStimulus(fixture.id, opts.stimulus);
    else if (opts.stimulus != null) {
      if (typeof opts.stimulus !== 'object' || Array.isArray(opts.stimulus) || Object.keys(opts.stimulus).length) {
        throw new Error('MCU stimulus is supported only by an explicit bundled fixture.');
      }
    }
  } catch (error) {
    const result = emptyResult('mcu', fixture?.mcu === 'rp2040' ? 'rp2040js' : 'avr8js');
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
  const target: McuTarget = opts.mcu ?? fixture?.mcu ?? detectMcu(ctx.circuitJson) ?? 'avr';
  if (fixture && target !== fixture.mcu) {
    const result = emptyResult('mcu', target === 'rp2040' ? 'rp2040js' : target === 'avr' ? 'avr8js' : 'qemu-esp32');
    result.error = `Firmware fixture "${fixture.id}" targets ${fixture.mcu}, not ${target}.`;
    return result;
  }
  const durationMs = opts.durationMs ?? fixture?.defaultDurationMs ?? 1000;

  if (target === 'esp32') {
    const r = emptyResult('mcu', 'qemu-esp32');
    r.notes.push(
      'ESP32 is Xtensa and emulates only under QEMU, which runs in the extension backend ' +
        '(utility-process) module. See the firmware-build backend; the renderer cannot host it. ' +
        'Use avr8js (AVR) or rp2040js (Pico) for in-renderer emulation.',
    );
    r.error = 'ESP32 emulation requires the QEMU backend module';
    r.durationMs = Math.round(performance.now() - started);
    return r;
  }

  if (target === 'rp2040') {
    const result = emptyResult('mcu', 'rp2040js');
    try {
      const fwText = fixture ? undefined : await resolveFirmware(ctx, opts.firmware);
      if (!fixture && !fwText) {
        result.error = 'RP2040 emulation needs a bundled fixture or byte-safe base64 firmware input.';
        result.notes.push('Choose `fixture: "rp2040-launch-beacon"` or provide base64 firmware. Arbitrary binary workspace paths are not claimed byte-safe.');
        result.durationMs = Math.round(performance.now() - started);
        return result;
      }
      if (fixture && fixture.imageFormat !== 'rp2040-raw-binary') throw new Error(`Fixture "${fixture.id}" has an incompatible image format.`);
      const run = await runRp2040Firmware(fixture ? fixture.bytes : decodeFirmware(fwText!), durationMs);
      result.ok = !run.hitCap;
      result.traces = run.traces;
      result.serial = run.serial;
      result.simulatedMs = run.simulatedMs;
      if (fixture) {
        result.firmwareFixture = {
          id: fixture.id,
          sha256: fixture.sha256,
          sourcePath: fixture.sourcePath,
          limitations: [...fixture.limitations],
        };
        result.notes.push(`Bundled fixture ${fixture.id}; sha256 ${fixture.sha256}; source ${fixture.sourcePath}.`);
      }
      result.notes.push(
        `rp2040js ran ${run.cycles.toLocaleString()} cycles (${run.simulatedMs.toFixed(1)}ms sim).` +
          (run.bootromLoaded ? '' : ' Boot ROM unavailable; booted from flash vector table (best-effort).'),
      );
      if (run.hitCap) {
        result.error = 'Stopped at the wall-clock cap before the requested firmware duration completed.';
        result.notes.push('The bounded execution guard stopped this run; fixture observations are incomplete.');
      }
      if (!run.serial.length && !run.traces.length) {
        result.notes.push('No serial or GPIO activity observed -- firmware may need the boot ROM or different clock setup.');
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    result.durationMs = Math.round(performance.now() - started);
    return result;
  }

  // --- AVR ---
  const result = emptyResult('mcu', 'avr8js');
  try {
    const fwText = await resolveFirmware(ctx, opts.firmware);
    if (fixture && fixture.imageFormat !== 'avr-word-little-endian') throw new Error(`Fixture "${fixture.id}" has an incompatible image format.`);
    const run = fixture
      ? runAvrProgram(
        avrFixtureProgram(fixture.bytes),
        durationMs,
        {
          ...(fixture.id === 'avr-eeprom-roundtrip-intent' ? { captureEepromEvents: true } : {}),
          ...(fixture.id === 'avr-watchdog-reset-intent' ? { captureWatchdogEvents: true } : {}),
          ...(fixture.id === 'avr-int0-interrupt-intent' ? {
            captureExternalInterrupt: {
              controller: 'INT0' as const, pinAlias: 'D2' as const,
              vectorWordAddress: 2 as const, edge: 'falling' as const,
            },
          } : {}),
          ...(fixture.id === 'avr-pcint-mask-intent' ? {
            captureExternalInterrupt: {
              controller: 'PCINT2' as const, pinAlias: 'D4' as const,
              vectorWordAddress: 10 as const, edge: 'change' as const,
            },
          } : {}),
          ...(fixture.id === 'avr-timer1-pulse-counter-intent' ? { captureTimer1ExternalCount: true } : {}),
          ...(isAvrAdcThresholdStimulus(normalizedStimulus) ? { adc0Voltage: normalizedStimulus.adc0_voltage } : {}),
          ...(fixture.id === 'avr-i2c-display-intent' ? { syntheticI2cWriteAck: true } : {}),
          ...(isAvrUartCommandStimulus(normalizedStimulus) ? { uart0RxByte: normalizedStimulus.uart0_rx_byte } : {}),
          ...(isAvrLimitInterlockStimulus(normalizedStimulus) ? {
            scheduledDigitalInputs: [{
              port: 'D' as const,
              bit: 7 as const,
              pinAlias: 'D7' as const,
              initialLevel: 1 as const,
              transitions: [{
                level: 0 as const,
                requestedCycle: Math.round(normalizedStimulus.limit_trip_ms * (AVR_LIMIT_INTERLOCK_CLOCK_HZ / 1000)),
              }],
            }],
          } : {}),
          ...(isAvrQuadratureDetentStimulus(normalizedStimulus) ? {
            scheduledDigitalInputs: [
              {
                port: 'D' as const, bit: 2 as const, pinAlias: 'D2', initialLevel: 1 as const,
                transitions: quadraturePhasePlan(normalizedStimulus.encoder_direction)
                  .filter((phase) => phase.bit === 2)
                  .map((phase) => ({ level: phase.level, requestedCycle: phase.requestedCycle, detentIndex: 0, phaseIndex: phase.phaseIndex })),
              },
              {
                port: 'D' as const, bit: 3 as const, pinAlias: 'D3', initialLevel: 1 as const,
                transitions: quadraturePhasePlan(normalizedStimulus.encoder_direction)
                  .filter((phase) => phase.bit === 3)
                  .map((phase) => ({ level: phase.level, requestedCycle: phase.requestedCycle, detentIndex: 0, phaseIndex: phase.phaseIndex })),
              },
            ],
          } : {}),
          ...(isAvrButtonDebounceStimulus(normalizedStimulus) ? {
            scheduledDigitalInputs: [{
              port: 'D' as const,
              bit: 7 as const,
              pinAlias: 'D7',
              initialLevel: 1 as const,
              transitions: buttonDebouncePlan(normalizedStimulus.button_bounce)
                .map((phase) => ({ level: phase.level, requestedCycle: phase.requestedCycle })),
            }],
          } : {}),
          ...(isAvrInt0InterruptStimulus(normalizedStimulus) ? {
            scheduledDigitalInputs: [{
              port: 'D' as const, bit: 2 as const, pinAlias: 'D2', initialLevel: 1 as const,
              transitions: [{ level: 0 as const, requestedCycle: normalizedStimulus.int0_falling_cycle }],
            }],
          } : {}),
          ...(isAvrPcintMaskStimulus(normalizedStimulus) ? {
            scheduledDigitalInputs: [
              {
                port: 'D' as const, bit: 7 as const, pinAlias: 'D7', initialLevel: 0 as const,
                transitions: [{ level: 1 as const, requestedCycle: 1_000 }],
              },
              ...(normalizedStimulus.pcint_profile === 1 ? [{
                port: 'D' as const, bit: 4 as const, pinAlias: 'D4', initialLevel: 0 as const,
                transitions: [{ level: 1 as const, requestedCycle: 2_000 }],
              }] : []),
            ],
          } : {}),
          ...(isAvrTimer1PulseCounterStimulus(normalizedStimulus) ? {
            scheduledDigitalInputs: [{
              port: 'D' as const, bit: 5 as const, pinAlias: 'D5', initialLevel: 0 as const,
              transitions: timer1PulsePlan(normalizedStimulus.timer1_pulse_count),
            }],
          } : {}),
        },
      )
      : fwText ? runAvrFirmware(fwText, durationMs) : runAvrProgram(builtinAvrBlink(), Math.min(durationMs, 50));
    result.ok = true;
    result.traces = run.traces;
    result.serial = run.serial;
    result.peripheralEvents = run.peripheralEvents;
    result.peripheralEventsOmitted = run.peripheralEventsOmitted;
    if (isAvrAdcThresholdStimulus(normalizedStimulus)
      || isAvrUartCommandStimulus(normalizedStimulus)
      || isAvrLimitInterlockStimulus(normalizedStimulus)
      || isAvrQuadratureDetentStimulus(normalizedStimulus)
      || isAvrButtonDebounceStimulus(normalizedStimulus)
      || isAvrInt0InterruptStimulus(normalizedStimulus)
      || isAvrTimer1PulseCounterStimulus(normalizedStimulus)
      || isAvrPcintMaskStimulus(normalizedStimulus)) result.modeledStimulus = { ...normalizedStimulus };
    result.simulatedMs = run.simulatedMs;
    result.notes.push(
      `avr8js ran ${run.cycles.toLocaleString()} cycles (${run.simulatedMs.toFixed(1)}ms sim) on a 16MHz ATmega328P.`,
    );
    if (fixture) {
      result.firmwareFixture = {
        id: fixture.id,
        sha256: fixture.sha256,
        sourcePath: fixture.sourcePath,
        limitations: [...fixture.limitations],
      };
      result.notes.push(`Bundled fixture ${fixture.id}; sha256 ${fixture.sha256}; source ${fixture.sourcePath}.`);
    } else if (!fwText) result.notes.push('Ran the built-in blink demo (no firmware given): watch D13(LED) toggle.');
    if (run.hitCap) {
      result.ok = false;
      result.error = 'Stopped at the wall-clock cap before the requested AVR firmware duration completed.';
      result.notes.push('The bounded execution guard stopped this run; observations do not prove completion of the requested duration.');
    }
    const toggling = run.traces.filter((t) => t.v.some((v, i) => i > 0 && v !== t.v[i - 1])).map((t) => t.name);
    if (toggling.length) result.notes.push(`GPIO level transitions observed: ${toggling.join(', ')}. Output-enable initialization can create a transition and is not repeated activity by itself.`);
    if (run.serial.length) result.notes.push(`Serial: ${run.serial.length} line(s) captured.`);
    const spiTransfers = run.peripheralEvents.filter((event) => event.kind === 'spi-transfer');
    if (spiTransfers.length) result.notes.push(`SPI0: ${spiTransfers.length} byte transfer(s) captured at the avr8js controller boundary${run.peripheralEventsOmitted ? `; ${run.peripheralEventsOmitted} additional event(s) omitted` : ''}; no wire waveform or external-device response was modeled.`);
    const adcSamples = run.peripheralEvents.filter((event) => event.kind === 'adc-sample');
    if (adcSamples.length) result.notes.push(`ADC0: ${adcSamples.length} modeled conversion(s) captured at the avr8js controller boundary. Input voltage is explicit stimulus, not physical sensor or calibrated analog evidence.`);
    if ((fixture?.id === 'avr-adc-threshold' || fixture?.id === 'avr-adc-pwm-controller-intent') && adcSamples.length !== 1) {
      result.ok = false;
      result.error = 'The requested firmware duration ended before one complete ADC0 conversion was observed.';
      result.notes.push('No ADC result is claimed from an incomplete modeled conversion.');
    }
    if (fixture?.id === 'avr-adc-pwm-controller-intent') {
      const adcPwm = deriveAdcPwmControllerIntentEvidence(result);
      if (!adcPwm) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact ADC0-to-Timer0 PWM controller intent completed.';
        result.notes.push('No ADC→PWM controller intent is claimed from missing, ambiguous, malformed, or incomplete ADC/D6 modeled-cycle evidence.');
      } else {
        result.notes.push(`ADC→PWM controller intent: explicit ${adcPwm.inputVoltage}V produced raw ${adcPwm.raw}, OCR0A ${adcPwm.compareValue}, and D6 ${adcPwm.frequencyHz} Hz at ${(adcPwm.dutyCycle * 100).toFixed(2)}% duty across ${adcPwm.completePeriods} complete period(s). No sensor, fan, motor, load, or hardware behavior was modeled.`);
      }
    }
    const i2cWrites = run.peripheralEvents.filter((event) => event.kind === 'i2c-write-intent');
    if (i2cWrites.length) result.notes.push(`TWI0: ${i2cWrites.length} completed write intent captured at STOP. Synthetic ACKs were fixture-scoped only to advance the avr8js controller; no external response or bus waveform was modeled.`);
    if (fixture?.id === 'avr-i2c-display-intent' && i2cWrites.length !== 1) {
      result.ok = false;
      result.error = 'The requested firmware duration ended before one complete TWI0 write intent reached STOP.';
      result.notes.push('No I2C write intent is claimed from an incomplete modeled controller transaction.');
    }
    const uartRx = run.peripheralEvents.filter((event) => event.kind === 'uart-rx-injected');
    const uartTx = run.peripheralEvents.filter((event) => event.kind === 'uart-tx');
    if (uartRx.length || uartTx.length) result.notes.push(`USART0: ${uartRx.length} scheduled avr8js RX byte(s) and ${uartTx.length} firmware TX byte(s) observed at the controller boundary. No external serial device or wire waveform was modeled.`);
    if (fixture?.id === 'avr-uart-command-response' && (uartRx.length !== 1 || uartTx.length !== 1)) {
      result.ok = false;
      result.error = 'The requested firmware duration ended before one complete USART0 command/response was observed.';
      result.notes.push('No complete UART command/response is claimed from incomplete emulator evidence.');
    }
    if (fixture?.id === 'avr-step-dir-intent') {
      const stepDir = deriveStepDirIntentEvidence(result);
      if (!stepDir) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before the exact three-pulse STEP/DIR/ENABLE intent completed.';
        result.notes.push('No complete motor-control intent is claimed from missing, ambiguous, or incomplete GPIO evidence.');
      } else {
        result.notes.push(`STEP/DIR intent: ${stepDir.pulseCount} D2 pulse(s) at exact modeled cycles; D3 DIR high; active-low D4 ENABLE low. No driver or motor response was modeled.`);
      }
    }
    if (fixture?.id === 'avr-servo-pulse-intent') {
      const servoPulse = deriveServoPulseIntentEvidence(result);
      if (!servoPulse) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before two exact Timer1/OC1A servo-pulse intent cycles completed.';
        result.notes.push('No servo-pulse intent is claimed from missing, ambiguous, malformed, or incomplete D9 modeled-cycle evidence.');
      } else {
        result.notes.push(`Timer1/OC1A pulse intent: D9 ${servoPulse.frequencyHz} Hz modeled, ${servoPulse.highPulseMicroseconds} us high, ${(servoPulse.dutyCycle * 100).toFixed(1)}% duty across ${servoPulse.completedPulses} complete pulse(s). No physical servo, angle, load, or hardware timing was modeled.`);
      }
    }
    if (fixture?.id === 'avr-timer2-tone-intent') {
      const tone = deriveTimer2ToneIntentEvidence(result);
      if (!tone) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before two exact Timer2/OC2B tone-intent periods completed.';
        result.notes.push('No tone intent is claimed from missing, ambiguous, malformed, or incomplete D3 modeled-cycle evidence.');
      } else {
        result.notes.push(`Timer2/OC2B tone intent: D3 ${tone.frequencyHz} Hz modeled, ${(tone.dutyCycle * 100).toFixed(1)}% duty across ${tone.completePeriods} complete period(s). No buzzer, speaker, emitted sound, load, or hardware timing was modeled.`);
      }
    }
    if (fixture?.id === 'avr-limit-interlock-intent') {
      const interlock = deriveLimitInterlockEvidence(result);
      if (!interlock) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact LIMIT input and completed STEP/ENABLE interlock response were observed.';
        result.notes.push('No complete limit-interlock intent is claimed from missing, ambiguous, malformed, or incomplete GPIO evidence.');
      } else {
        result.notes.push(`LIMIT interlock intent: D7 low applied at modeled cycle ${interlock.appliedCycle}; polling firmware forced D2 STEP low and active-low D4 ENABLE high at cycle ${interlock.reactionCycle} (${interlock.responseCycles} modeled cycles later). No physical switch, safety function, driver, or motor response was modeled.`);
      }
    }
    if (fixture?.id === 'avr-quadrature-detent-intent') {
      const quadrature = deriveQuadratureDetentEvidence(result);
      if (!quadrature) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact clean quadrature detent and completed direction/completion latches were observed.';
        result.notes.push('No quadrature-detent intent is claimed from missing, ambiguous, malformed, omitted, or incomplete GPIO evidence.');
      } else {
        result.notes.push(`Quadrature intent: ${quadrature.inputStateSequence}; fixture-defined ${quadrature.direction}; D5 direction latch ${quadrature.directionLatchLevel}; D6 completion latch high at modeled cycle ${quadrature.completionCycle}. No physical encoder or motion was modeled.`);
      }
    }
    if (fixture?.id === 'avr-button-debounce-intent') {
      const debounce = deriveButtonDebounceEvidence(result);
      if (!debounce) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact button profile and completed debounce latches were observed.';
        result.notes.push('No button-debounce intent is claimed from missing, ambiguous, malformed, omitted, or incomplete GPIO evidence.');
      } else {
        result.notes.push(`Button debounce intent: fixture-defined ${debounce.profile} D7 profile ${debounce.inputStateSequence}; D4 accepted at modeled cycle ${debounce.acceptedCycle}; D5 bounce-seen ${debounce.bounceObserved ? `high at cycle ${debounce.bounceObservedCycle}` : 'remained low'}. No physical button or contact behavior was modeled.`);
      }
    }
    if (fixture?.id === 'avr-neopixel-frame-intent') {
      const frame = deriveNeoPixelFrameIntentEvent(result);
      if (!frame) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact 24-bit NeoPixel frame intent completed.';
        result.notes.push('No NeoPixel frame intent is claimed from missing, ambiguous, malformed, or incomplete D6 modeled-cycle evidence.');
      } else {
        result.peripheralEvents = [...(result.peripheralEvents ?? []), frame];
        result.notes.push(`NeoPixel frame intent: GRB ${frame.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')} across ${frame.bitCount} fixture-decoded D6 pulses at modeled cycles ${frame.frameStartCycle}→${frame.frameEndCycle}. No attached pixel, emitted light, electrical waveform, or hardware was modeled.`);
      }
    }
    if (fixture?.id === 'avr-eeprom-roundtrip-intent') {
      const roundtrip = deriveEepromRoundtripIntentEvidence(result);
      if (!roundtrip) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact EEPROM write/read round trip and D6 success latch completed.';
        result.notes.push('No EEPROM round-trip intent is claimed from missing, extra, malformed, omitted, or incomplete controller/backend and GPIO evidence.');
      } else {
        result.notes.push(`EEPROM round-trip intent: wrote and read 0x${roundtrip.value.toString(16).padStart(2, '0')} at 0x${roundtrip.address.toString(16).padStart(4, '0')}; modeled write ${roundtrip.writeRequestCycle}→${roundtrip.writeReadyCycle}, read ${roundtrip.readCycle}, D6 success ${roundtrip.successCycle}. No retention, endurance, power-loss safety, or hardware persistence was modeled.`);
      }
    }
    if (fixture?.id === 'avr-watchdog-reset-intent') {
      const watchdog = deriveWatchdogResetIntentEvidence(result);
      if (!watchdog) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact watchdog reset, MCUSR.WDRF observation, and D5/D6 latch sequence completed.';
        result.notes.push('No watchdog-reset intent is claimed from missing, extra, malformed, omitted, or incomplete controller/reset and GPIO evidence.');
      } else {
        result.notes.push(`Watchdog reset intent: avr8js reset at modeled cycle ${watchdog.resetCycle}; firmware read MCUSR 0x${watchdog.mcusrValue.toString(16).padStart(2, '0')} at ${watchdog.mcusrReadCycle}, lowered D5 at ${watchdog.armedLowCycle}, and raised D6 at ${watchdog.successCycle}. No calibrated timeout, brownout/reset-pin/bootloader behavior, startup safety, or hardware reset was modeled.`);
      }
    }
    if (fixture?.id === 'avr-int0-interrupt-intent') {
      const interrupt = deriveInt0InterruptIntentEvidence(result);
      if (!interrupt) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before one exact D2 falling edge, INT0 vector entry, and D5/D6 ISR latch sequence completed.';
        result.notes.push('No INT0 interrupt intent is claimed from missing, extra, malformed, omitted, or incomplete input/controller/CPU-vector/GPIO evidence.');
      } else {
        result.notes.push(`INT0 interrupt intent: D2 falling edge requested/applied ${interrupt.requestedCycle}/${interrupt.appliedCycle}; avr8js entered vector word ${interrupt.vectorWordAddress} at ${interrupt.entryCycle}, lowered D5 at ${interrupt.armedLowCycle}, and raised D6 at ${interrupt.observedHighCycle}. No calibrated latency, deadline, priority/nesting, electrical edge, or hardware interrupt was modeled.`);
      }
    }
    if (fixture?.id === 'avr-timer1-pulse-counter-intent') {
      const pulseCounter = deriveTimer1PulseCounterIntentEvidence(result);
      if (!pulseCounter) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before the exact D5/T1 pulse plan, Timer1 count, firmware TCNT1 read, and D6/D7 latch sequence completed.';
        result.notes.push('No Timer1 pulse-counter intent is claimed from missing, extra, reordered, malformed, omitted, or incomplete input/controller/register-read/GPIO evidence.');
      } else {
        result.notes.push(`Timer1 pulse-counter intent: ${pulseCounter.requestedPulseCount} explicit D5 rising edge(s), TCNT1=${pulseCounter.countedPulseCount} at firmware read cycle ${pulseCounter.readCycle}, D6 read-complete at ${pulseCounter.readCompleteCycle}, D7 threshold ${pulseCounter.thresholdReached ? `high at ${pulseCounter.thresholdCycle}` : 'remained low'}. No frequency, tachometer/RPM, missed-pulse, electrical-edge, or hardware behavior was modeled.`);
      }
    }
    if (fixture?.id === 'avr-pcint-mask-intent') {
      const pcint = derivePcintMaskIntentEvidence(result);
      if (!pcint) {
        result.ok = false;
        result.error = 'The requested firmware duration ended before the exact PCMSK2 mask-selectivity profile and ISR-latch evidence completed.';
        result.notes.push('No PCINT2 mask intent is claimed from missing, extra, reordered, malformed, omitted, or incomplete input/controller/CPU-vector/GPIO evidence.');
      } else if (pcint.profile === 0) {
        result.notes.push(`PCINT mask intent: masked D7 change requested/applied ${pcint.maskedInput.requestedCycle}/${pcint.maskedInput.appliedCycle}; no PCINT2 vector entry or ISR latch occurred. avr8js evidence only; no simultaneous-edge, bounce/noise, electrical, latency, or hardware claim.`);
      } else {
        result.notes.push(`PCINT mask intent: masked D7 change at ${pcint.maskedInput.appliedCycle}; enabled D4 change at ${pcint.enabledInput!.appliedCycle} entered shared PCINT2 vector word ${pcint.vectorWordAddress} at ${pcint.entryCycle}, lowered D5 at ${pcint.armedLowCycle}, and raised D6 at ${pcint.observedHighCycle}. avr8js evidence only; no simultaneous-edge, bounce/noise, electrical, latency, or hardware claim.`);
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
