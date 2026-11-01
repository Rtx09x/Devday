/**
 * Simulation panel
 *
 * The Phase-2 surface: pick an engine (auto / logical / analog / MCU), run it,
 * and read the results -- scope traces, a serial monitor, part state, and notes.
 * Logical mode is interactive: switches and pots derived from the circuit become
 * live controls that re-run the cheap logical model as you change them, so you
 * can "press the button -> see the LED light" without compiling anything.
 *
 * It calls the same `simulate()` orchestrator the `electronics.simulate` AI tool
 * uses, so the agent and the user drive identical engines.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Scope } from './Scope';
import { simulate } from '../sim/simulate';
import { computePartStates } from '../sim/logicalSim';
import { detectMcu } from '../sim/detect';
import type { FirmwareFixtureId, SimMode, McuTarget, PeripheralEvent, SimResult } from '../sim/types';
import type { AnyCircuitElement } from '../circuit/circuitJson';
import { deriveCanvasFeedback } from '../sim/canvasFeedback';
import { getFirmwareFixture } from '../sim/firmwareFixtures';
import { firmwareFixtureOptions, preferredFirmwareFixture } from '../sim/fixtureUi';
import {
  AVR_ADC_THRESHOLD_DEFAULT_VOLTAGE,
  AVR_BUTTON_DEBOUNCE_DEFAULT_BOUNCE,
  AVR_INT0_DEFAULT_FALLING_CYCLE,
  AVR_LIMIT_INTERLOCK_DEFAULT_TRIP_MS,
  AVR_QUADRATURE_DEFAULT_DIRECTION,
  AVR_UART_COMMAND_DEFAULT_BYTE,
  AVR_TIMER1_PULSE_COUNTER_DEFAULT_COUNT,
  AVR_PCINT_MASK_DEFAULT_PROFILE,
} from '../sim/fixtureStimulus';
import { AgentRequestCard } from './AgentRequestCard';
import {
  buildSimulationRequestPresets,
  SIMULATION_DEBUG_DEFAULT_REQUEST,
  type AgentProvider,
  type AgentProviderPreference,
  type AgentRequestStatus,
  type AgentSendAvailability,
} from '../agentSession';
import type { SimulationAgentSnapshot } from '../sim/simulationAgent';
import { deriveStepDirIntentEvidence } from '../sim/stepDirIntent';
import { canonicalTransitionCycles, deriveLimitInterlockEvidence } from '../sim/limitInterlockIntent';
import { canonicalGpioInputEventCycles, deriveQuadratureDetentEvidence } from '../sim/quadratureDetentIntent';
import { canonicalButtonInputEvents, deriveButtonDebounceEvidence } from '../sim/buttonDebounceIntent';
import { canonicalNeoPixelFrameBytes } from '../sim/neopixelFrameIntent';
import { canonicalServoPulseTransitions, deriveServoPulseIntentEvidence } from '../sim/servoPulseIntent';
import { canonicalTimer2ToneTransitions, deriveTimer2ToneIntentEvidence } from '../sim/timer2ToneIntent';
import { deriveAdcPwmControllerIntentEvidence } from '../sim/adcPwmControllerIntent';
import { deriveEepromRoundtripIntentEvidence } from '../sim/eepromRoundtripIntent';
import { deriveWatchdogResetIntentEvidence } from '../sim/watchdogResetIntent';
import { deriveInt0InterruptIntentEvidence } from '../sim/int0InterruptIntent';
import { canonicalTimer1ExternalCount, deriveTimer1PulseCounterIntentEvidence } from '../sim/timer1PulseCounterIntent';
import { canonicalPcintMask, derivePcintMaskIntentEvidence } from '../sim/pcintMaskIntent';

interface Props {
  circuitJson: AnyCircuitElement[];
  sourceIdentity: string;
  runAvailability: AgentSendAvailability;
  readFile?: (path: string) => Promise<string>;
  result: SimResult | null;
  onResult: (result: SimResult, sourceIdentity: string) => void;
  onClear: () => void;
  agentSnapshot?: SimulationAgentSnapshot;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (request: string, provider: AgentProvider) => Promise<void>;
}

function SpiEvidenceCard({ events, omitted = 0 }: { events: PeripheralEvent[]; omitted?: number }) {
  const transfers = events.filter((event) => event.kind === 'spi-transfer' && event.controller === 'SPI0');
  if (!transfers.length) return null;
  const first = transfers[0];
  const hex = transfers.map((event) => event.tx.toString(16).padStart(2, '0')).join(' ');
  const bytes = transfers.map((event) => event.tx);
  const palette = bytes.length === 20
    && bytes.slice(0, 4).every((byte) => byte === 0)
    && bytes.slice(-4).every((byte) => byte === 0xff)
    ? [0, 1, 2].map((index) => {
      const offset = 4 + index * 4;
      return { brightness: bytes[offset] & 0x1f, b: bytes[offset + 1], g: bytes[offset + 2], r: bytes[offset + 3] };
    })
    : [];
  return (
    <section className="es-sim-spi" aria-label="SPI0 byte-level evidence">
      <header><div><small>Byte-level emulator evidence</small><strong>SPI0 transmitted frame</strong></div><b>{transfers.length} bytes</b></header>
      <div className="es-sim-spi-config">
        <span>mode {first.mode}</span><span>{first.dataOrder}</span><span>÷{first.clockDivider}</span><span>{(first.modeledFrequencyHz / 1_000_000).toFixed(3)} MHz modeled</span>
      </div>
      <code>{hex}</code>
      {palette.length === 3 && <div className="es-sim-spi-palette" aria-label="Transmitted color intent">
        {palette.map((color, index) => <span key={index}>
          <i style={{ backgroundColor: `rgb(${color.r} ${color.g} ${color.b})` }} />
          <small>TX intent {index + 1} · B{color.b} G{color.g} R{color.r} · brightness {color.brightness}/31</small>
        </span>)}
      </div>}
      <footer>{omitted ? `${omitted} additional event(s) omitted. ` : ''}The 0xff RX value only completes emulator transfers. No MOSI/SCK waveform, external pixel response, emitted light, voltage/current, copper, or physical timing was modeled.</footer>
    </section>
  );
}

function AdcEvidenceCard({ result }: { result: SimResult }) {
  const samples = (result.peripheralEvents ?? []).filter((event) => event.kind === 'adc-sample');
  if (!samples.length) return null;
  const sample = samples[0];
  const adcPwm = deriveAdcPwmControllerIntentEvidence(result);
  if (adcPwm) {
    return (
      <section className="es-sim-adc" aria-label="AVR ADC to PWM controller intent evidence">
        <header><div><small>Composed emulator controller evidence</small><strong>ADC0 → Timer0 PWM intent</strong></div><b>{(adcPwm.dutyCycle * 100).toFixed(2)}%</b></header>
        <div className="es-sim-adc-meter" role="meter" aria-label="D6 modeled PWM duty" aria-valuemin={0} aria-valuemax={100} aria-valuenow={adcPwm.dutyCycle * 100}>
          <i style={{ width: `${adcPwm.dutyCycle * 100}%` }} />
        </div>
        <div className="es-sim-i2c-commands">
          <span><b>Explicit ADC0 input</b>{adcPwm.inputVoltage}V → raw {adcPwm.raw}/1023</span>
          <span><b>Firmware compare</b>OCR0A {adcPwm.compareValue} · clamped 16..240</span>
          <span><b>D6 output</b>{adcPwm.frequencyHz} Hz modeled · {(adcPwm.dutyCycle * 100).toFixed(2)}% duty</span>
          <span><b>Exact cycles</b>{adcPwm.highCycles.toLocaleString()} high / {adcPwm.periodCycles.toLocaleString()} period · {adcPwm.completePeriods} complete periods</span>
        </div>
        <footer>One explicit avr8js ADC sample and firmware-derived Timer0/OC0A output intent only. No sensor, analog front end, fan, motor, driver, load/current, speed/torque/airflow, electrical waveform, calibrated timing, PCB copper, or physical hardware was modeled.</footer>
      </section>
    );
  }
  const d6 = result.traces.find((trace) => trace.name === 'D6');
  const final = d6?.v[d6.v.length - 1];
  return (
    <section className="es-sim-adc" aria-label="ADC0 modeled-input evidence">
      <header><div><small>Modeled emulator input</small><strong>ADC0 sampled {sample.inputVoltage}V</strong></div><b>{sample.raw}/1023</b></header>
      <div className="es-sim-adc-meter" role="meter" aria-label="ADC0 raw code" aria-valuemin={0} aria-valuemax={1023} aria-valuenow={sample.raw}>
        <i style={{ width: `${sample.raw / 10.23}%` }} />
      </div>
      <div className="es-sim-spi-config">
        <span>{sample.reference} {sample.referenceVoltage}V</span><span>10-bit</span><span>{sample.completeCycle - sample.startCycle} modeled cycles</span>
        {final != null && <span>D6 threshold output {final ? 'high' : 'low'}</span>}
      </div>
      <footer>Explicit adc0_voltage stimulus only. No physical sensor, analog front end, loading, noise, calibration, external LED behavior, PCB behavior, or physical ADC accuracy was modeled.</footer>
    </section>
  );
}

function I2cEvidenceCard({ result }: { result: SimResult }) {
  const events = (result.peripheralEvents ?? []).filter((event) => event.kind === 'i2c-write-intent');
  if (!events.length) return null;
  const event = events[0];
  const labels = ['control byte', 'display-off intent', 'normal-mode intent', 'display-on intent'];
  return (
    <section className="es-sim-i2c" aria-label="TWI0 I2C write-intent evidence">
      <header><div><small>STOP-bounded controller evidence</small><strong>I2C configuration intent</strong></div><b>0x{event.address7Bit.toString(16).padStart(2, '0')}</b></header>
      <code>{event.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}</code>
      <div className="es-sim-i2c-commands">
        {event.bytes.map((byte, index) => <span key={`${byte}-${index}`}><b>{byte.toString(16).padStart(2, '0')}</b>{labels[index] ?? 'write byte'}</span>)}
      </div>
      <strong className="es-sim-i2c-ack">{event.syntheticAckCount} synthetic ACKs used only to advance avr8js</strong>
      <footer>No external ACK or response, read data, SCL timing/frequency, SDA/SCL waveform, pull-ups, arbitration, pins/nets, physical display, PCB, or hardware behavior was modeled.</footer>
    </section>
  );
}

function UartEvidenceCard({ result }: { result: SimResult }) {
  const rx = (result.peripheralEvents ?? []).find((event) => event.kind === 'uart-rx-injected');
  const tx = (result.peripheralEvents ?? []).find((event) => event.kind === 'uart-tx');
  if (!rx || !tx) return null;
  const d6 = result.traces.find((trace) => trace.name === 'D6');
  const final = d6?.v[d6.v.length - 1];
  const printable = (byte: number) => byte >= 0x20 && byte <= 0x7e ? ` “${String.fromCharCode(byte)}”` : '';
  return (
    <section className="es-sim-i2c" aria-label="USART0 command-response emulator evidence">
      <header><div><small>Scheduled controller evidence</small><strong>UART command response</strong></div><b>{tx.baudRate} modeled baud</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>RX {rx.byte.toString(16).padStart(2, '0')}</b>{printable(rx.byte)} · cycles {rx.requestCycle}→{rx.completeCycle}</span>
        <span><b>TX {tx.byte.toString(16).padStart(2, '0')}</b>{printable(tx.byte)} · write cycle {tx.writeCycle}</span>
        {final != null && <span><b>D6 {final ? 'high' : 'low'}</b>final emulator GPIO state</span>}
      </div>
      <strong className="es-sim-i2c-ack">{tx.bitsPerChar} data bits · {tx.parity} parity · {tx.stopBits} stop bit</strong>
      <footer>RX was injected once through avr8js and TX is firmware controller intent. No external ACK/device, voltage, wire waveform, calibrated baud timing, framing/noise/overrun, cable, USB serial, PCB, or hardware behavior was modeled.</footer>
    </section>
  );
}

function EepromRoundtripEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveEepromRoundtripIntentEvidence(result);
  if (!evidence) return null;
  const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');
  return (
    <section className="es-sim-i2c" aria-label="AVR EEPROM round-trip emulator evidence">
      <header><div><small>In-memory controller/backend evidence</small><strong>EEPROM round trip</strong></div><b>{hex(evidence.address, 4)}:{hex(evidence.value, 2)}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>Erase + write</b>cycles {evidence.writeRequestCycle}→{evidence.writeReadyCycle}</span>
        <span><b>Read back</b>cycle {evidence.readCycle} · byte 0x{hex(evidence.value, 2)}</span>
        <span><b>D6 success</b>high at cycle {evidence.successCycle}</span>
        <span><b>D5 failure</b>remained low</span>
      </div>
      <footer>One exact avr8js in-memory EEPROM controller/backend round trip only. This does not prove nonvolatile retention, endurance, wear, power-loss safety, atomicity, calibrated timing, voltage, PCB, or hardware persistence.</footer>
    </section>
  );
}

function WatchdogResetEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveWatchdogResetIntentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c" aria-label="AVR watchdog reset emulator evidence">
      <header><div><small>Controller / CPU-reset evidence</small><strong>Watchdog reset intent</strong></div><b>MCUSR 0x{evidence.mcusrValue.toString(16).padStart(2, '0')}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>System reset</b>modeled cycle {evidence.resetCycle}</span>
        <span><b>WDRF observed</b>firmware read at cycle {evidence.mcusrReadCycle}</span>
        <span><b>D5 armed</b>high {evidence.armedHighCycle} → low {evidence.armedLowCycle}</span>
        <span><b>D6 reset observed</b>high at cycle {evidence.successCycle}</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.watchdogClockHz.toLocaleString()} Hz modeled watchdog clock · prescaler {evidence.prescaler}</strong>
      <footer>One exact avr8js watchdog controller/reset and firmware-WDRF intent only. This does not prove calibrated timeout, oscillator tolerance, brownout/reset-pin/bootloader behavior, startup safety, voltage, PCB, or hardware reset.</footer>
    </section>
  );
}

function Int0InterruptEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveInt0InterruptIntentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c" aria-label="AVR INT0 external-interrupt emulator evidence">
      <header><div><small>GPIO / CPU-vector evidence</small><strong>INT0 interrupt intent</strong></div><b>vector word {evidence.vectorWordAddress}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D2 falling edge</b>requested/applied {evidence.requestedCycle}/{evidence.appliedCycle}</span>
        <span><b>INT0 entered</b>modeled cycle {evidence.entryCycle}</span>
        <span><b>D5 armed cleared</b>cycle {evidence.armedLowCycle}</span>
        <span><b>D6 ISR observed</b>cycle {evidence.observedHighCycle}</span>
      </div>
      <footer>One exact avr8js GPIO external-interrupt/CPU-vector and firmware-latch intent only. This does not prove calibrated latency, deadlines, priority/nesting, bounce/noise behavior, voltage thresholds, electrical edges, startup safety, PCB, or hardware interrupts.</footer>
    </section>
  );
}

function Timer1PulseCounterEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveTimer1PulseCounterIntentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c" aria-label="AVR Timer1 external pulse-counter emulator evidence">
      <header><div><small>GPIO / timer-register evidence</small><strong>Timer1 pulse-counter intent</strong></div><b>TCNT1 = {evidence.countedPulseCount}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D5 rising edges</b>{evidence.requestedPulseCount} explicit modeled pulse{evidence.requestedPulseCount === 1 ? '' : 's'}</span>
        <span><b>Firmware read</b>TCNT1 at cycle {evidence.readCycle}</span>
        <span><b>D6 read complete</b>high at cycle {evidence.readCompleteCycle}</span>
        <span><b>D7 threshold ≥ 4</b>{evidence.thresholdReached ? `high at cycle ${evidence.thresholdCycle}` : 'remained low'}</span>
      </div>
      <code>{canonicalTimer1ExternalCount(evidence)}</code>
      <footer>One exact avr8js D5/T1 external-rising count and firmware-read/latch intent only. This does not prove frequency, RPM/tachometer behavior, calibrated timing, missed-pulse performance, voltage thresholds, electrical edges, PCB, or hardware counting.</footer>
    </section>
  );
}

function PcintMaskEvidenceCard({ result }: { result: SimResult }) {
  const evidence = derivePcintMaskIntentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c" aria-label="AVR PCINT2 mask-selectivity emulator evidence">
      <header><div><small>GPIO mask / CPU-vector evidence</small><strong>PCINT2 mask intent</strong></div><b>profile {evidence.profile}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D7 / PCINT23</b>masked change at {evidence.maskedInput.requestedCycle}/{evidence.maskedInput.appliedCycle}</span>
        <span><b>D4 / PCINT20</b>{evidence.enabledInput ? `enabled change at ${evidence.enabledInput.requestedCycle}/${evidence.enabledInput.appliedCycle}` : 'not injected'}</span>
        <span><b>PCINT2 vector</b>{evidence.entryCycle == null ? 'not entered' : `word 10 at cycle ${evidence.entryCycle}`}</span>
        <span><b>D5 / D6 ISR latches</b>{evidence.entryCycle == null ? 'unchanged by an ISR' : `${evidence.armedLowCycle} / ${evidence.observedHighCycle}`}</span>
      </div>
      <code>{canonicalPcintMask(evidence)}</code>
      <footer>Exact avr8js PCMSK2/input/vector/latch intent only. This does not prove simultaneous-edge ordering, calibrated latency, priority/nesting, bounce/noise immunity, voltage thresholds, electrical edges, PCB, or hardware interrupts.</footer>
    </section>
  );
}

function StepDirEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveStepDirIntentEvidence(result);
  if (!evidence) return null;
  const formatCycles = (cycles: number[]) => cycles.join(', ');
  return (
    <section className="es-sim-i2c es-sim-step-dir" aria-label="AVR Step Dir controller intent evidence">
      <header><div><small>Finite emulator GPIO evidence</small><strong>STEP / DIR / ENABLE intent</strong></div><b>{evidence.pulseCount} pulses</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D2 STEP rises</b>cycles {formatCycles(evidence.risingEdgeCycles)}</span>
        <span><b>D2 STEP falls</b>cycles {formatCycles(evidence.fallingEdgeCycles)}</span>
        <span><b>D3 DIR high</b>final emulator GPIO level</span>
        <span><b>D4 ENABLE low</b>active-low intent; final emulator GPIO level</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.clockHz.toLocaleString()} Hz modeled AVR clock · exact cycles, not calibrated timing</strong>
      <footer>Controller-output intent only. No driver response, motor coils/current, microstepping, motion, direction of travel, torque, acceleration, mechanics, voltage/current, PCB copper, or physical hardware was modeled.</footer>
    </section>
  );
}

function ServoPulseEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveServoPulseIntentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c es-sim-step-dir" aria-label="AVR Timer1 servo pulse intent evidence">
      <header><div><small>Exact modeled Timer1 / OC1A evidence</small><strong>Servo pulse intent</strong></div><b>{evidence.frequencyHz} Hz</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D9 high pulse</b>{evidence.highPulseMicroseconds} us · {evidence.highCycles.toLocaleString()} modeled cycles</span>
        <span><b>Period</b>{evidence.periodCycles.toLocaleString()} modeled cycles · {(evidence.dutyCycle * 100).toFixed(1)}% duty</span>
        <span><b>Completed evidence</b>{evidence.completedPulses} pulses · {evidence.completePeriods} rising-to-rising periods</span>
        <span><b>Exact transitions</b>{canonicalServoPulseTransitions(evidence.transitionCycles)}</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.clockHz.toLocaleString()} Hz modeled AVR clock · Timer1 Fast PWM mode 14 · exact cycles, not calibrated timing</strong>
      <footer>Controller-output intent only. No physical servo, angle/position, load/current, power supply, calibrated timing, electrical waveform or signal integrity, PCB copper, firmware-on-hardware, or physical behavior was modeled.</footer>
    </section>
  );
}

function Timer2ToneEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveTimer2ToneIntentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c es-sim-step-dir" aria-label="AVR Timer2 tone intent evidence">
      <header><div><small>Exact modeled Timer2 / OC2B evidence</small><strong>Tone controller intent</strong></div><b>{evidence.frequencyHz.toLocaleString()} Hz</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D3 half-period</b>{evidence.halfPeriodCycles.toLocaleString()} modeled cycles</span>
        <span><b>Full period</b>{evidence.periodCycles.toLocaleString()} modeled cycles · {(evidence.dutyCycle * 100).toFixed(1)}% duty</span>
        <span><b>Completed evidence</b>{evidence.completePeriods} complete periods</span>
        <span><b>Exact transitions</b>{canonicalTimer2ToneTransitions(evidence.transitionCycles)}</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.clockHz.toLocaleString()} Hz modeled AVR clock · Timer2 CTC toggle · exact cycles, not calibrated timing</strong>
      <footer>Controller-output intent only. No buzzer, speaker, emitted sound, loudness, load/current, power supply, calibrated timing, electrical waveform or signal integrity, PCB copper, firmware-on-hardware, or physical behavior was modeled.</footer>
    </section>
  );
}

function LimitInterlockEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveLimitInterlockEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c es-sim-step-dir" aria-label="AVR modeled limit interlock evidence">
      <header><div><small>Scheduled input / polling response</small><strong>LIMIT interlock intent</strong></div><b>{evidence.responseCycles} cycles</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D7 LIMIT low</b>requested cycle {evidence.requestedCycle} · applied {evidence.appliedCycle}</span>
        <span><b>D2 STEP transitions</b>{canonicalTransitionCycles(evidence.stepTransitions)}</span>
        <span><b>D4 ENABLE high</b>disabled intent at cycle {evidence.reactionCycle}</span>
        <span><b>Polling response</b>{evidence.appliedCycle}→{evidence.reactionCycle} · {evidence.responseCycles} modeled cycles</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.clockHz.toLocaleString()} Hz modeled AVR clock · exact cycles, not calibrated response time</strong>
      <footer>One scheduled avr8js D7 input and polling firmware output intent only. No physical switch/contact/bounce, voltage threshold, interrupt or real-time deadline, safety-rated stop, driver shutdown, motor motion, PCB copper, or hardware was modeled.</footer>
    </section>
  );
}

function QuadratureDetentEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveQuadratureDetentEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c es-sim-step-dir" aria-label="AVR modeled quadrature detent evidence">
      <header><div><small>Four scheduled input phases / firmware latches</small><strong>Quadrature detent intent</strong></div><b>{evidence.direction}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D2/D3 states</b>{evidence.inputStateSequence}</span>
        <span><b>Requested / applied</b>{canonicalGpioInputEventCycles(evidence.inputEvents)}</span>
        <span><b>D5 direction latch</b>{evidence.directionLatchLevel ? 'high' : 'low'} · fixture-defined {evidence.direction}</span>
        <span><b>D6 completion latch</b>high at modeled cycle {evidence.completionCycle}</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.clockHz.toLocaleString()} Hz modeled AVR clock · exact cycles, not calibrated timing</strong>
      <footer>One clean fixture-scheduled D2/D3 phase order and firmware latch intent only. No contact/bounce, skipped or illegal states, encoder shaft, mechanical direction, acceleration, voltage/current, interrupts, PCB copper, or physical hardware was modeled.</footer>
    </section>
  );
}

function ButtonDebounceEvidenceCard({ result }: { result: SimResult }) {
  const evidence = deriveButtonDebounceEvidence(result);
  if (!evidence) return null;
  return (
    <section className="es-sim-i2c es-sim-step-dir" aria-label="AVR modeled button debounce evidence">
      <header><div><small>Scheduled input profile / firmware latches</small><strong>Button debounce intent</strong></div><b>{evidence.profile}</b></header>
      <div className="es-sim-i2c-commands">
        <span><b>D7 states</b>{evidence.inputStateSequence}</span>
        <span><b>Requested / applied</b>{canonicalButtonInputEvents(evidence.inputEvents)}</span>
        <span><b>D5 bounce-seen</b>{evidence.bounceObserved ? `high at modeled cycle ${evidence.bounceObservedCycle}` : 'remained low'}</span>
        <span><b>D4 press accepted</b>high at modeled cycle {evidence.acceptedCycle} · {evidence.responseCycles} cycles after final input</span>
      </div>
      <strong className="es-sim-i2c-ack">{evidence.clockHz.toLocaleString()} Hz modeled AVR clock · 64 consecutive firmware polls, not calibrated debounce time</strong>
      <footer>One bounded fixture-defined D7 transition profile and polling-firmware latch intent only. No contact physics, analog waveform, pull-up resistance, general debounce proof, interrupt behavior, safety function, PCB copper, or physical hardware was modeled.</footer>
    </section>
  );
}

function NeoPixelFrameEvidenceCard({ result }: { result: SimResult }) {
  const frames = (result.peripheralEvents ?? []).filter((event) => event.kind === 'neopixel-frame-intent');
  if (frames.length !== 1) return null;
  const frame = frames[0];
  const [g, r, b] = frame.bytes;
  return (
    <section className="es-sim-i2c es-sim-neopixel" aria-label="AVR modeled NeoPixel frame evidence">
      <header>
        <div><small>Fixture-decoded controller pulse intent</small><strong>NeoPixel frame intent</strong></div>
        <span className="es-sim-neopixel-swatch" style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }} aria-label={`Byte-value swatch RGB ${r} ${g} ${b}; not emitted light`} />
      </header>
      <div className="es-sim-i2c-commands">
        <span><b>GRB bytes</b>{canonicalNeoPixelFrameBytes(frame.bytes)}</span>
        <span><b>D6 bits</b>{frame.bitCount}</span>
        <span><b>Modeled cycles</b>{frame.frameStartCycle}→{frame.frameEndCycle}</span>
        <span><b>High widths</b>0={frame.zeroHighCycles} · 1={frame.oneHighCycles}</span>
      </div>
      <strong className="es-sim-i2c-ack">Byte-value swatch only · no attached pixel or emitted light was simulated</strong>
      <footer>One exact fixture-only D6 pulse decode. No calibrated WS2812 timing, electrical waveform, voltage/current, signal integrity, reset/latch compatibility, pixel response, chain behavior, PCB copper, or physical hardware was modeled.</footer>
    </section>
  );
}

function stimulusForFixture(fixture: FirmwareFixtureId | undefined): Record<string, unknown> {
  if (fixture === 'avr-adc-threshold' || fixture === 'avr-adc-pwm-controller-intent') return { adc0_voltage: AVR_ADC_THRESHOLD_DEFAULT_VOLTAGE };
  if (fixture === 'avr-uart-command-response') return { uart0_rx_byte: AVR_UART_COMMAND_DEFAULT_BYTE };
  if (fixture === 'avr-limit-interlock-intent') return { limit_trip_ms: AVR_LIMIT_INTERLOCK_DEFAULT_TRIP_MS };
  if (fixture === 'avr-quadrature-detent-intent') return { encoder_direction: AVR_QUADRATURE_DEFAULT_DIRECTION };
  if (fixture === 'avr-button-debounce-intent') return { button_bounce: AVR_BUTTON_DEBOUNCE_DEFAULT_BOUNCE };
  if (fixture === 'avr-int0-interrupt-intent') return { int0_falling_cycle: AVR_INT0_DEFAULT_FALLING_CYCLE };
  if (fixture === 'avr-timer1-pulse-counter-intent') return { timer1_pulse_count: AVR_TIMER1_PULSE_COUNTER_DEFAULT_COUNT };
  if (fixture === 'avr-pcint-mask-intent') return { pcint_profile: AVR_PCINT_MASK_DEFAULT_PROFILE };
  return {};
}

export function SimulationPanel({
  circuitJson,
  sourceIdentity,
  runAvailability,
  readFile,
  result,
  onResult,
  onClear,
  agentSnapshot,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onAgentProviderChange,
  onAskAgent,
}: Props) {
  const [mode, setMode] = useState<SimMode>('auto');
  const [mcu, setMcu] = useState<McuTarget>('avr');
  const [durationMs, setDurationMs] = useState(1000);
  const [firmware, setFirmware] = useState('');
  const [firmwareSource, setFirmwareSource] = useState<'fixture' | 'input'>('input');
  const [fixture, setFixture] = useState<FirmwareFixtureId | undefined>();
  const [running, setRunning] = useState(false);
  const [stimulus, setStimulus] = useState<Record<string, unknown>>({});

  const detectedMcu = useMemo(() => detectMcu(circuitJson), [circuitJson]);
  const canvasFeedback = useMemo(() => deriveCanvasFeedback(circuitJson, result), [circuitJson, result]);
  const fixtureOptions = useMemo(() => firmwareFixtureOptions(mcu), [mcu]);
  const selectedFixture = fixture ? getFirmwareFixture(fixture) : undefined;

  useEffect(() => {
    if (!detectedMcu) return;
    setMcu(detectedMcu);
    const preferred = preferredFirmwareFixture(detectedMcu, circuitJson);
    if (preferred) {
      setFixture(preferred);
      setFirmwareSource('fixture');
      setDurationMs(getFirmwareFixture(preferred)?.defaultDurationMs ?? 1000);
      setStimulus(stimulusForFixture(preferred));
    }
  }, [circuitJson, detectedMcu]);

  // Interactive parts for logical mode (switches/buttons/pots) + live LED state.
  const liveStates = useMemo(
    () => (mode === 'logical' || mode === 'auto' ? computePartStates(circuitJson, stimulus) : []),
    [circuitJson, stimulus, mode],
  );
  const inputs = liveStates.filter((s) => s.kind === 'switch' || s.kind === 'potentiometer');
  const leds = liveStates.filter((s) => s.kind === 'led');

  const run = useCallback(async () => {
    if (!runAvailability.allowed) return;
    const runSourceIdentity = sourceIdentity;
    onClear();
    setRunning(true);
    try {
      const r = await simulate(
        { circuitJson, readFile },
        {
          mode,
          mcu,
          durationMs,
          fixture: firmwareSource === 'fixture' ? fixture : undefined,
          firmware: firmwareSource === 'input' ? firmware.trim() || undefined : undefined,
          stimulus,
        },
      );
      onResult(r, runSourceIdentity);
    } finally {
      setRunning(false);
    }
  }, [circuitJson, readFile, mode, mcu, durationMs, firmware, firmwareSource, fixture, stimulus, onClear, onResult, runAvailability.allowed, sourceIdentity]);

  // Auto-run cheap logical sims as stimulus changes; never auto-run heavy engines.
  useEffect(() => {
    const effective = mode === 'auto' && !detectedMcu ? 'logical' : mode;
    if (effective === 'logical') void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stimulus]);

  const showMcuControls = mode === 'mcu' || (mode === 'auto' && !!detectedMcu);

  return (
    <div className="es-sim">
      <div className="es-sim-controls">
        <label className="es-sim-field">
          Engine
          <select value={mode} onChange={(e) => setMode(e.target.value as SimMode)}>
            <option value="auto">Auto{detectedMcu ? ` (MCU: ${detectedMcu})` : ''}</option>
            <option value="logical">Logical (interactive)</option>
            <option value="analog">Analog (ngspice)</option>
            <option value="mcu">MCU firmware</option>
          </select>
        </label>

        {showMcuControls && (
          <>
            <label className="es-sim-field">
              MCU
              <select value={mcu} onChange={(e) => {
                const next = e.target.value as McuTarget;
                const preferred = preferredFirmwareFixture(next);
                setMcu(next);
                setFixture(preferred);
                setFirmwareSource(preferred ? 'fixture' : 'input');
                setStimulus(stimulusForFixture(preferred));
                if (preferred) setDurationMs(getFirmwareFixture(preferred)?.defaultDurationMs ?? 1000);
              }}>
                <option value="avr">AVR (Uno/avr8js)</option>
                <option value="rp2040">RP2040 (Pico/rp2040js)</option>
                <option value="esp32">ESP32 (QEMU backend)</option>
              </select>
            </label>
            <label className="es-sim-field">
              Firmware source
              <select value={firmwareSource} onChange={(e) => {
                const next = e.target.value as 'fixture' | 'input';
                setFirmwareSource(next);
                setStimulus(next === 'fixture' ? stimulusForFixture(fixture) : {});
              }}>
                {fixtureOptions.length > 0 && <option value="fixture">Bundled fixture</option>}
                <option value="input">{mcu === 'avr' ? 'AVR demo / Intel HEX' : 'Base64 firmware input'}</option>
              </select>
            </label>
            {firmwareSource === 'fixture' && fixtureOptions.length > 0 ? (
              <label className="es-sim-field es-sim-field-grow">
                Fixture
                <select value={fixture} onChange={(e) => {
                  const next = e.target.value as FirmwareFixtureId;
                  setFixture(next);
                  setDurationMs(getFirmwareFixture(next)?.defaultDurationMs ?? durationMs);
                  setStimulus(stimulusForFixture(next));
                }}>
                  {fixtureOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
            ) : (
              <label className="es-sim-field es-sim-field-grow">
                {mcu === 'avr' ? 'Intel HEX (blank runs built-in AVR blink)' : 'Base64 firmware'}
                <input
                  value={firmware}
                  onChange={(e) => setFirmware(e.target.value)}
                  placeholder={mcu === 'avr' ? 'blank = bundled AVR blink; or paste Intel HEX' : 'paste byte-safe base64; binary workspace paths are agent-only'}
                />
              </label>
            )}
          </>
        )}

        <label className="es-sim-field">
          Duration (ms)
          <input
            type="number"
            min={1}
            value={durationMs}
            onChange={(e) => setDurationMs(Math.max(1, Number(e.target.value) || 0))}
          />
        </label>

        <button
          className="es-sim-run"
          onClick={run}
          disabled={running || !runAvailability.allowed}
          title={runAvailability.allowed ? 'Run against the latest successful projection' : runAvailability.reason}
        >
          {running ? 'Running…' : 'Run'}
        </button>
        {result && <button className="es-sim-clear" onClick={onClear} disabled={running}>Clear feedback</button>}
      </div>

      {showMcuControls && firmwareSource === 'fixture' && selectedFixture && (
        <div className="es-sim-fixture" aria-label="Bundled firmware fixture provenance">
          <strong>{selectedFixture.label}</strong>
          <span>{selectedFixture.description}</span>
          <code>{selectedFixture.id} · sha256 {selectedFixture.sha256}</code>
          <small>Reviewable source: {selectedFixture.sourcePath}</small>
          <small>No runtime download or compiler. Fixture limitations:</small>
          {selectedFixture.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && (fixture === 'avr-adc-threshold' || fixture === 'avr-adc-pwm-controller-intent') && (
        <div className="es-sim-adc-control" aria-label="AVR ADC0 modeled stimulus">
          <label>
            <strong>Modeled ADC0 input</strong>
            <input
              type="range"
              min={0}
              max={5}
              step={0.01}
              value={Number(stimulus.adc0_voltage ?? AVR_ADC_THRESHOLD_DEFAULT_VOLTAGE)}
              onChange={(event) => setStimulus({ adc0_voltage: Number(event.target.value) })}
            />
          </label>
          <label>
            Voltage
            <input
              type="number"
              min={0}
              max={5}
              step={0.01}
              value={Number(stimulus.adc0_voltage ?? AVR_ADC_THRESHOLD_DEFAULT_VOLTAGE)}
              onChange={(event) => {
                const voltage = Number(event.target.value);
                if (Number.isFinite(voltage)) setStimulus({ adc0_voltage: Math.min(5, Math.max(0, voltage)) });
              }}
            />
            V
          </label>
          <small>This value is injected into avr8js channel ADC0. Changing it never runs firmware automatically.{fixture === 'avr-adc-pwm-controller-intent' ? ' Firmware maps it to clamped D6 PWM controller intent.' : ''}</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-uart-command-response' && (
        <div className="es-sim-adc-control" aria-label="AVR USART0 explicit RX command">
          <label>
            <strong>Explicit USART0 RX byte</strong>
            <select
              value={Number(stimulus.uart0_rx_byte ?? AVR_UART_COMMAND_DEFAULT_BYTE)}
              onChange={(event) => setStimulus({ uart0_rx_byte: Number(event.target.value) })}
            >
              <option value={0x31}>ON · “1” · 0x31</option>
              <option value={0x30}>OFF · “0” · 0x30</option>
              <option value={0x58}>Unknown · “X” · 0x58</option>
            </select>
          </label>
          <small>Run explicitly to schedule this one byte through avr8js. Changing it never runs firmware automatically.</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-limit-interlock-intent' && (
        <div className="es-sim-adc-control" aria-label="AVR modeled active-low limit input">
          <label>
            <strong>Modeled D7 LIMIT assertion</strong>
            <input
              type="range"
              min={0.05}
              max={1.5}
              step={0.0000625}
              value={Number(stimulus.limit_trip_ms ?? AVR_LIMIT_INTERLOCK_DEFAULT_TRIP_MS)}
              onChange={(event) => setStimulus({ limit_trip_ms: Number(event.target.value) })}
            />
          </label>
          <label>
            Trip time
            <input
              type="number"
              min={0.05}
              max={1.5}
              step={0.0000625}
              value={Number(stimulus.limit_trip_ms ?? AVR_LIMIT_INTERLOCK_DEFAULT_TRIP_MS)}
              onChange={(event) => {
                const tripMs = Number(event.target.value);
                if (Number.isFinite(tripMs)) setStimulus({ limit_trip_ms: Math.min(1.5, Math.max(0.05, tripMs)) });
              }}
            />
            ms
          </label>
          <small>Run explicitly to schedule one high→low D7 input through avr8js. Changing this value never runs firmware automatically.</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-quadrature-detent-intent' && (
        <div className="es-sim-adc-control" aria-label="AVR modeled quadrature direction">
          <label>
            <strong>One clean modeled detent</strong>
            <select
              value={Number(stimulus.encoder_direction ?? AVR_QUADRATURE_DEFAULT_DIRECTION)}
              onChange={(event) => setStimulus({ encoder_direction: Number(event.target.value) })}
            >
              <option value={1}>CW · D2/A leads D3/B</option>
              <option value={-1}>CCW · D3/B leads D2/A</option>
            </select>
          </label>
          <small>Run explicitly to schedule four ordered D2/D3 phase changes through avr8js. Changing direction never runs firmware automatically. CW/CCW are fixture-defined lead-order labels, not mechanical motion.</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-button-debounce-intent' && (
        <div className="es-sim-adc-control" aria-label="AVR modeled button input profile">
          <label>
            <strong>Fixture-defined D7 press profile</strong>
            <select
              value={Number(stimulus.button_bounce ?? AVR_BUTTON_DEBOUNCE_DEFAULT_BOUNCE)}
              onChange={(event) => setStimulus({ button_bounce: Number(event.target.value) })}
            >
              <option value={0}>Clean · one falling edge</option>
              <option value={1}>Bouncy · five bounded edges</option>
            </select>
          </label>
          <small>Run explicitly to schedule the selected D7 edge list through avr8js. Changing the profile never runs firmware automatically. This is deterministic emulator stimulus, not contact physics.</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-int0-interrupt-intent' && (
        <div className="es-sim-adc-control" aria-label="AVR modeled INT0 falling-edge cycle">
          <label>
            <strong>Fixture-only D2 falling edge</strong>
            <input
              type="number"
              min={500}
              max={8000}
              step={1}
              value={Number(stimulus.int0_falling_cycle ?? AVR_INT0_DEFAULT_FALLING_CYCLE)}
              onChange={(event) => {
                const cycle = Number(event.target.value);
                if (Number.isSafeInteger(cycle)) setStimulus({ int0_falling_cycle: Math.min(8000, Math.max(500, cycle)) });
              }}
            />
            modeled cycle
          </label>
          <small>Run explicitly to schedule one D2 high→low input through avr8js. Changing the cycle never runs firmware automatically. Requested/applied/vector cycles are emulator evidence, not a latency guarantee.</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-timer1-pulse-counter-intent' && (
        <div className="es-sim-adc-control" aria-label="AVR modeled Timer1 external pulse count">
          <label>
            <strong>Fixture-only D5/T1 rising pulses</strong>
            <input
              type="number"
              min={1}
              max={8}
              step={1}
              value={Number(stimulus.timer1_pulse_count ?? AVR_TIMER1_PULSE_COUNTER_DEFAULT_COUNT)}
              onChange={(event) => {
                const count = Number(event.target.value);
                if (Number.isSafeInteger(count)) setStimulus({ timer1_pulse_count: Math.min(8, Math.max(1, count)) });
              }}
            />
            modeled pulses
          </label>
          <small>Run explicitly to schedule 1–8 clean D5 rising edges through avr8js. Changing the count never runs firmware automatically. This is bounded counter intent, not a frequency, RPM/tachometer, missed-pulse, or electrical model.</small>
        </div>
      )}

      {showMcuControls && firmwareSource === 'fixture' && fixture === 'avr-pcint-mask-intent' && (
        <div className="es-sim-adc-control" aria-label="AVR modeled PCINT2 mask profile">
          <label>
            <strong>Fixture-only PCINT2 profile</strong>
            <select
              value={Number(stimulus.pcint_profile ?? AVR_PCINT_MASK_DEFAULT_PROFILE)}
              onChange={(event) => setStimulus({ pcint_profile: Number(event.target.value) === 0 ? 0 : 1 })}
            >
              <option value={0}>Masked D7 only · no vector</option>
              <option value={1}>Masked D7 then enabled D4</option>
            </select>
          </label>
          <small>Run explicitly to inject the selected bounded profile through avr8js. Changing the profile never runs firmware automatically. This proves mask selectivity in the emulator, not physical switch/contact or interrupt timing.</small>
        </div>
      )}

      {/* Interactive logical stimulus + live indicators */}
      {(mode === 'logical' || (mode === 'auto' && !detectedMcu)) && (inputs.length > 0 || leds.length > 0) && (
        <div className="es-sim-interactive">
          {inputs.map((p) =>
            p.kind === 'switch' ? (
              <button
                key={p.name}
                className={stimulus[p.name] ? 'es-sim-toggle es-sim-toggle-on' : 'es-sim-toggle'}
                onClick={() => setStimulus((s) => ({ ...s, [p.name]: !s[p.name] }))}
              >
                {p.name}: {stimulus[p.name] ? 'pressed' : 'open'}
              </button>
            ) : (
              <label key={p.name} className="es-sim-pot">
                {p.name}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={Number(stimulus[p.name] ?? 0.5)}
                  onChange={(e) => setStimulus((s) => ({ ...s, [p.name]: Number(e.target.value) }))}
                />
              </label>
            ),
          )}
          {leds.map((p) => (
            <span key={p.name} className={p.state.on ? 'es-sim-led es-sim-led-on' : 'es-sim-led'} title={p.name}>
              ● {p.name}
            </span>
          ))}
        </div>
      )}

      {result && (
        <div className="es-sim-results">
          <div className="es-sim-meta">
            <span className={result.ok ? 'es-sim-badge es-sim-ok' : 'es-sim-badge es-sim-err'}>
              {result.engine}
            </span>
            <span>{result.durationMs}ms wall</span>
            {result.simulatedMs != null && <span>· {result.simulatedMs.toFixed(1)}ms simulated</span>}
            {result.error && <span className="es-sim-error">· {result.error}</span>}
            {result.ok && <span>· canvas evidence persists until rerun or clear</span>}
          </div>

          {agentSnapshot && (
            <AgentRequestCard
              key={agentSnapshot.targetKey}
              targetKey={agentSnapshot.targetKey}
              title={`Debug agent · ${result.engine}`}
              description="Starts a visibly named session with bounded evidence from this exact completed run. Selection and typing never rerun simulation, send, or change the design."
              defaultRequest={SIMULATION_DEBUG_DEFAULT_REQUEST}
              requestPresets={buildSimulationRequestPresets({ engine: result.engine, fixtureId: result.firmwareFixture?.id, resultOk: result.ok })}
              agentAvailability={agentAvailability}
              agentProviderPreference={agentProviderPreference}
              agentRequestStatus={agentRequestStatus}
              onAgentProviderChange={onAgentProviderChange}
              onAskAgent={onAskAgent}
            />
          )}

          <Scope traces={result.traces} />

          <SpiEvidenceCard events={result.peripheralEvents ?? []} omitted={result.peripheralEventsOmitted} />
          <AdcEvidenceCard result={result} />
          <I2cEvidenceCard result={result} />
          <UartEvidenceCard result={result} />
          <ServoPulseEvidenceCard result={result} />
          <Timer2ToneEvidenceCard result={result} />
          <StepDirEvidenceCard result={result} />
          <LimitInterlockEvidenceCard result={result} />
          <QuadratureDetentEvidenceCard result={result} />
          <ButtonDebounceEvidenceCard result={result} />
          <NeoPixelFrameEvidenceCard result={result} />
          <EepromRoundtripEvidenceCard result={result} />
          <WatchdogResetEvidenceCard result={result} />
          <Int0InterruptEvidenceCard result={result} />
          <Timer1PulseCounterEvidenceCard result={result} />
          <PcintMaskEvidenceCard result={result} />

          {result.ok && canvasFeedback && (
            <div className="es-sim-evidence-note">
              <strong>{result.mode === 'mcu' ? 'MCU activity evidence' : 'Logical model feedback'}</strong>
              <span>
                {result.mode === 'mcu'
                  ? result.firmwareFixture?.id === 'avr-spi-pixel-palette'
                    ? 'Only the exact MCU owning D10/D11/D13 may be highlighted. SPI bytes are shown separately; pixel intent, pins, nets, external LEDs, loads, PCB copper, voltage, and current were not simulated.'
                    : result.firmwareFixture?.id === 'avr-adc-pwm-controller-intent'
                      ? 'Only the exact MCU and D6 Timer0 controller-output identity may be highlighted. ADC0/PWM numeric evidence is shown separately; the A0 input, sensor/load intent, fan/motor response, analog behavior, electrical waveform, and PCB copper are not highlighted or simulated.'
                    : result.firmwareFixture?.id === 'avr-adc-threshold'
                      ? 'Only the exact MCU owning A0/D6 may be highlighted. ADC0 stimulus/evidence is shown separately; A0/D6 pins, nets, sensor/output intent, analog behavior, and PCB copper are not highlighted or electrically simulated.'
                      : result.firmwareFixture?.id === 'avr-i2c-display-intent'
                        ? 'Only the exact MCU owning A4/A5 may be highlighted. TWI0 write intent is shown separately; A4/A5 pins, nets, display intent, ACK response, bus waveforms/timing, pull-ups, and PCB copper are not highlighted or electrically simulated.'
                        : result.firmwareFixture?.id === 'avr-uart-command-response'
                          ? 'Only the exact MCU and D6 output identity may be highlighted. USART0 evidence is shown separately; D0/RX, D1/TX, external serial devices, wire waveform, calibrated baud timing, USB serial, and PCB copper are not highlighted or electrically simulated.'
                          : result.firmwareFixture?.id === 'avr-servo-pulse-intent'
                            ? 'Only the exact MCU and D9 Timer1/OC1A controller-output identity may be highlighted. Exact pulse cycles are shown separately; no servo, angle/position, load/current, calibrated timing, electrical waveform, or PCB copper is highlighted or simulated.'
                          : result.firmwareFixture?.id === 'avr-timer2-tone-intent'
                            ? 'Only the exact MCU and D3 Timer2/OC2B controller-output identity may be highlighted. Exact toggle cycles are shown separately; no buzzer, speaker, emitted sound, loudness, load/current, calibrated timing, electrical waveform, or PCB copper is highlighted or simulated.'
                          : result.firmwareFixture?.id === 'avr-step-dir-intent'
                            ? 'Only the exact MCU and D2 STEP identity may be highlighted. D3/D4 levels are shown separately; the driver, motor, motion, mechanics, voltage/current, and PCB copper are not highlighted or simulated.'
                            : result.firmwareFixture?.id === 'avr-limit-interlock-intent'
                              ? 'Only the exact MCU and D7 modeled LIMIT input identity may be highlighted. D2/D4 response evidence is shown separately; no switch, safety circuit, driver, motor, motion, voltage/current, or PCB copper is highlighted or simulated.'
                              : result.firmwareFixture?.id === 'avr-quadrature-detent-intent'
                                ? 'Only the exact MCU and D2/D3 modeled input identities may be highlighted. D5/D6 latch evidence is shown separately; no encoder, contacts, bounce, mechanical motion/direction, voltage/current, or PCB copper is highlighted or simulated.'
                                : result.firmwareFixture?.id === 'avr-button-debounce-intent'
                                  ? 'Only the exact MCU and D7 modeled input identity may be highlighted. D4/D5 latch evidence is shown separately; no physical button, contact physics, analog waveform, safety behavior, voltage/current, or PCB copper is highlighted or simulated.'
                                  : result.firmwareFixture?.id === 'avr-neopixel-frame-intent'
                                    ? 'Only the exact MCU and D6 controller-output identity may be highlighted. GRB byte intent is shown separately; no pixel, emitted light/color, electrical waveform, calibrated protocol timing, voltage/current, or PCB copper is highlighted or simulated.'
                                    : result.firmwareFixture?.id === 'avr-eeprom-roundtrip-intent'
                                      ? 'Only the exact MCU and D6 firmware-success identity may be highlighted. EEPROM cycles are shown separately; retention, endurance, wear, power-loss safety, atomicity, electrical behavior, and PCB copper are not highlighted or simulated.'
                                      : result.firmwareFixture?.id === 'avr-watchdog-reset-intent'
                                        ? 'Only the exact MCU and D6 firmware reset-observed identity may be highlighted. Reset/MCUSR cycles are shown separately; timeout calibration, oscillator tolerance, brownout/reset-pin/bootloader behavior, startup safety, electrical behavior, and PCB copper are not highlighted or simulated.'
                                        : result.firmwareFixture?.id === 'avr-int0-interrupt-intent'
                                          ? 'Only the exact MCU and D2 modeled INT0 input identity may be highlighted. Vector-entry and D5/D6 latch cycles are shown separately; no switch/sensor, electrical edge, calibrated latency, priority/nesting, or PCB copper is highlighted or simulated.'
                                          : result.firmwareFixture?.id === 'avr-timer1-pulse-counter-intent'
                                            ? 'Only the exact MCU and D5 modeled Timer1 counter-input identity may be highlighted. TCNT1/D6/D7 evidence is shown separately; no frequency, RPM/tachometer, missed-pulse, electrical-edge, or PCB-copper behavior is highlighted or simulated.'
                                          : result.firmwareFixture?.id === 'avr-pcint-mask-intent'
                                            ? 'Only the exact MCU and D7 masked-input identity may be highlighted, plus D4 for the enabled profile. PCMSK2/vector/D5/D6 evidence is shown separately; no simultaneous-edge, bounce/noise, electrical, calibrated-latency, or PCB-copper behavior is highlighted or simulated.'
                    : 'Only an exactly mapped MCU, MCU pin, and schematic net are highlighted. External LEDs, loads, PCB copper, voltage, and current were not simulated.'
                  : 'Only exact source components with a positive logical state are highlighted; this is heuristic feedback, not an electrical solution.'}
              </span>
              {canvasFeedback.diagnostics.map((diagnostic) => <small key={diagnostic}>{diagnostic}</small>)}
            </div>
          )}

          {result.firmwareFixture && (
            <div className="es-sim-fixture es-sim-fixture-result">
              <strong>Ran bundled fixture · {result.firmwareFixture.id}</strong>
              <code>sha256 {result.firmwareFixture.sha256}</code>
              <small>Source: {result.firmwareFixture.sourcePath}</small>
              {result.firmwareFixture.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}
            </div>
          )}

          {result.serial.length > 0 && (
            <div className="es-sim-serial">
              <div className="es-sim-serial-title">Serial monitor</div>
              <div className="es-sim-serial-body">
                {result.serial.map((l, i) => (
                  <div key={i} className="es-sim-serial-line">
                    <span className="es-sim-serial-t">{l.t.toFixed(3)}ms</span>
                    <span className="es-sim-serial-text">{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.notes.length > 0 && (
            <ul className="es-sim-notes">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
