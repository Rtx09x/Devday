import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import type { SimResult } from './types.ts';
import { deriveStepDirIntentEvidence } from './stepDirIntent.ts';
import { deriveLimitInterlockEvidence } from './limitInterlockIntent.ts';
import { deriveQuadratureDetentEvidence } from './quadratureDetentIntent.ts';
import { deriveButtonDebounceEvidence } from './buttonDebounceIntent.ts';
import { deriveServoPulseIntentEvidence } from './servoPulseIntent.ts';
import { deriveTimer2ToneIntentEvidence } from './timer2ToneIntent.ts';
import { deriveAdcPwmControllerIntentEvidence } from './adcPwmControllerIntent.ts';
import { deriveEepromRoundtripIntentEvidence } from './eepromRoundtripIntent.ts';
import { deriveWatchdogResetIntentEvidence } from './watchdogResetIntent.ts';
import { deriveInt0InterruptIntentEvidence } from './int0InterruptIntent.ts';
import { deriveTimer1PulseCounterIntentEvidence } from './timer1PulseCounterIntent.ts';
import { derivePcintMaskIntentEvidence } from './pcintMaskIntent.ts';

export type CanvasFeedbackKind = 'logical-on' | 'logical-powered' | 'mcu-activity';

export interface CanvasFeedbackComponent {
  sourceComponentId: string;
  kind: CanvasFeedbackKind;
  label: string;
}

export interface CanvasFeedback {
  engine: string;
  components: CanvasFeedbackComponent[];
  sourcePortIds: string[];
  connectivityKeys: string[];
  diagnostics: string[];
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const normalized = (value: string): string => value.trim().toUpperCase();

/**
 * Convert completed simulation evidence into exact Circuit JSON identities.
 * Missing or ambiguous joins are deliberately suppressed instead of guessed.
 */
export function deriveCanvasFeedback(
  elements: AnyCircuitElement[],
  result: SimResult | null | undefined,
): CanvasFeedback | null {
  if (!result?.ok) return null;

  const feedback: CanvasFeedback = {
    engine: result.engine,
    components: [],
    sourcePortIds: [],
    connectivityKeys: [],
    diagnostics: [],
  };

  if (result.mode === 'logical') {
    const sourceIds = new Set(elements
      .filter((element) => element.type === 'source_component')
      .map((element) => str(element.source_component_id))
      .filter((id): id is string => Boolean(id)));
    for (const part of result.parts) {
      const sourceComponentId = part.sourceComponentId;
      const kind = part.kind === 'led' && part.state.on === true
        ? 'logical-on'
        : part.kind === 'chip' && part.state.powered === true
          ? 'logical-powered'
          : undefined;
      if (!kind) continue;
      if (!sourceComponentId || !sourceIds.has(sourceComponentId)) {
        feedback.diagnostics.push(`Skipped ${part.name}: exact source component identity is unavailable.`);
        continue;
      }
      feedback.components.push({ sourceComponentId, kind, label: part.name });
    }
    return feedback;
  }

  if (result.mode !== 'mcu' || (result.engine !== 'avr8js' && result.engine !== 'rp2040js')) return feedback;

  const ports = elements.filter((element) => element.type === 'source_port');
  if (result.firmwareFixture?.id === 'avr-spi-pixel-palette') {
    const required = new Set(['D10', 'D11', 'D13']);
    const owners = new Map<string, Set<string>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = str(port.name);
      if (!owner || !name || !required.has(normalized(name))) continue;
      const names = owners.get(owner) ?? new Set<string>();
      names.add(normalized(name));
      owners.set(owner, names);
    }
    const matches = [...owners.entries()].filter(([, names]) => names.size === required.size);
    if (matches.length === 1 && (result.peripheralEvents ?? []).some((event) => event.kind === 'spi-transfer' && event.controller === 'SPI0')) {
      feedback.components.push({ sourceComponentId: matches[0][0], kind: 'mcu-activity', label: 'SPI0 TX' });
      feedback.diagnostics.push('SPI palette feedback marks only the exact MCU owning D10/D11/D13. Pixel intent, pins, nets, and PCB copper are not highlighted as external behavior.');
    } else {
      feedback.diagnostics.push(`Skipped SPI palette canvas feedback: expected one exact D10/D11/D13 MCU owner, found ${matches.length}.`);
    }
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-adc-pwm-controller-intent') {
    const evidence = deriveAdcPwmControllerIntentEvidence(result);
    if (!evidence) {
      feedback.diagnostics.push('Skipped ADC→PWM canvas feedback because the exact ADC0/D6 modeled-cycle evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_ADC_PWM_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const ownedPorts = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? ''));
    const a0Ports = ownedPorts.filter((port) => normalized(str(port.name) ?? '') === 'A0');
    const d6Ports = ownedPorts.filter((port) => normalized(str(port.name) ?? '') === 'D6');
    const d6Traces = result.traces.filter((trace) => trace.name === 'D6'
      && trace.origin?.family === 'avr' && trace.origin.port === 'D' && trace.origin.bit === 6);
    if (expectedOwners.size !== 1 || a0Ports.length !== 1 || d6Ports.length !== 1 || d6Traces.length !== 1) {
      feedback.diagnostics.push(`Skipped ADC→PWM canvas feedback: expected one exact fixture MCU, A0 port, D6 port, and D6 trace; found ${expectedOwners.size}/${a0Ports.length}/${d6Ports.length}/${d6Traces.length}.`);
      return feedback;
    }
    const d6Port = d6Ports[0];
    const sourcePortId = str(d6Port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(d6Port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped ADC→PWM canvas feedback: D6 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId: [...expectedOwners][0], kind: 'mcu-activity', label: 'ADC0 → D6 PWM controller intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('ADC→PWM feedback marks only the exact MCU and D6 controller-output identity. A0 input, sensor/load intent, fan/motor response, analog behavior, electrical waveform, and PCB copper are not highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-adc-threshold') {
    const required = new Set(['A0', 'D6']);
    const owners = new Map<string, Set<string>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = str(port.name);
      if (!owner || !name || !required.has(normalized(name))) continue;
      const names = owners.get(owner) ?? new Set<string>();
      names.add(normalized(name));
      owners.set(owner, names);
    }
    const matches = [...owners.entries()].filter(([, names]) => names.size === required.size);
    const hasCompleteSample = (result.peripheralEvents ?? []).some((event) => event.kind === 'adc-sample' && event.controller === 'ADC0');
    if (matches.length === 1 && hasCompleteSample) {
      feedback.components.push({ sourceComponentId: matches[0][0], kind: 'mcu-activity', label: 'ADC0 sample' });
      feedback.diagnostics.push('ADC threshold feedback marks only the exact MCU owning A0/D6. Pins, nets, sensor/output intent, analog behavior, and PCB copper are not highlighted as external behavior.');
    } else {
      feedback.diagnostics.push(`Skipped ADC threshold canvas feedback: expected one exact A0/D6 MCU owner and one complete ADC0 sample; found ${matches.length} owner(s).`);
    }
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-i2c-display-intent') {
    const required = new Set(['A4', 'A5']);
    const owners = new Map<string, Set<string>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = str(port.name);
      if (!owner || !name || !required.has(normalized(name))) continue;
      const names = owners.get(owner) ?? new Set<string>();
      names.add(normalized(name));
      owners.set(owner, names);
    }
    const matches = [...owners.entries()].filter(([, names]) => names.size === required.size);
    const hasCompleteIntent = (result.peripheralEvents ?? []).some((event) => event.kind === 'i2c-write-intent' && event.controller === 'TWI0');
    if (matches.length === 1 && hasCompleteIntent) {
      feedback.components.push({ sourceComponentId: matches[0][0], kind: 'mcu-activity', label: 'TWI0 write intent' });
      feedback.diagnostics.push('I2C feedback marks only the exact MCU owning A4/A5. Pins, nets, display intent, ACK response, bus behavior, and PCB copper are not highlighted as external behavior.');
    } else {
      feedback.diagnostics.push(`Skipped I2C canvas feedback: expected one exact A4/A5 MCU owner and one complete TWI0 write intent; found ${matches.length} owner(s).`);
    }
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-uart-command-response') {
    const required = new Set(['D0', 'D1', 'D6']);
    const owners = new Map<string, Map<string, AnyCircuitElement>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = normalized(str(port.name) ?? '');
      if (!owner || !required.has(name)) continue;
      const named = owners.get(owner) ?? new Map<string, AnyCircuitElement>();
      if (named.has(name)) named.set(name, {} as AnyCircuitElement);
      else named.set(name, port);
      owners.set(owner, named);
    }
    const matches = [...owners.entries()].filter(([, named]) => named.size === required.size
      && [...required].every((name) => named.get(name)?.type === 'source_port'));
    const hasExchange = (result.peripheralEvents ?? []).some((event) => event.kind === 'uart-rx-injected' && event.controller === 'USART0')
      && (result.peripheralEvents ?? []).some((event) => event.kind === 'uart-tx' && event.controller === 'USART0');
    if (matches.length === 1 && hasExchange) {
      const [sourceComponentId, named] = matches[0];
      const port = named.get('D6')!;
      const sourcePortId = str(port.source_port_id);
      if (sourcePortId) {
        feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'USART0 command / D6 output' });
        feedback.sourcePortIds.push(sourcePortId);
        const connectedTrace = elements.find((element) => element.type === 'source_trace'
          && Array.isArray(element.connected_source_port_ids)
          && element.connected_source_port_ids.includes(sourcePortId));
        const key = str(port.subcircuit_connectivity_map_key) ?? str(connectedTrace?.subcircuit_connectivity_map_key);
        if (key) feedback.connectivityKeys.push(key);
        feedback.diagnostics.push('UART command feedback marks only the exact MCU and D6 output identity. D0/RX, D1/TX, external serial devices, wire behavior, and PCB copper are not highlighted.');
      }
    } else {
      feedback.diagnostics.push(`Skipped UART command canvas feedback: expected one exact D0/D1/D6 MCU owner and one complete USART0 exchange; found ${matches.length} owner(s).`);
    }
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-servo-pulse-intent') {
    const servoEvidence = deriveServoPulseIntentEvidence(result);
    if (!servoEvidence) {
      feedback.diagnostics.push('Skipped Timer1 servo-pulse canvas feedback because the exact D9 modeled-cycle evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_SERVO_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const d9Ports = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === 'D9');
    const d9Traces = result.traces.filter((trace) => trace.name === 'D9'
      && trace.origin?.family === 'avr' && trace.origin.port === 'B' && trace.origin.bit === 1);
    if (expectedOwners.size !== 1 || d9Ports.length !== 1 || d9Traces.length !== 1) {
      feedback.diagnostics.push(`Skipped Timer1 servo-pulse canvas feedback: expected one exact fixture MCU, D9 source port, and D9 trace; found ${expectedOwners.size}/${d9Ports.length}/${d9Traces.length}.`);
      return feedback;
    }
    const port = d9Ports[0];
    const sourceComponentId = str(port.source_component_id)!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped Timer1 servo-pulse canvas feedback: D9 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D9 Timer1 servo-pulse intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('Timer1 servo-pulse feedback marks only the exact MCU and D9 controller-output identity. No servo, angle/position, load/current, electrical waveform, calibrated timing, or PCB copper is highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-timer2-tone-intent') {
    const toneEvidence = deriveTimer2ToneIntentEvidence(result);
    if (!toneEvidence) {
      feedback.diagnostics.push('Skipped Timer2 tone-intent canvas feedback because the exact D3 modeled-cycle evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_TIMER2_TONE_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const d3Ports = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === 'D3');
    const d3Traces = result.traces.filter((trace) => trace.name === 'D3'
      && trace.origin?.family === 'avr' && trace.origin.port === 'D' && trace.origin.bit === 3);
    if (expectedOwners.size !== 1 || d3Ports.length !== 1 || d3Traces.length !== 1) {
      feedback.diagnostics.push(`Skipped Timer2 tone-intent canvas feedback: expected one exact fixture MCU, D3 source port, and D3 trace; found ${expectedOwners.size}/${d3Ports.length}/${d3Traces.length}.`);
      return feedback;
    }
    const port = d3Ports[0];
    const sourceComponentId = str(port.source_component_id)!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped Timer2 tone-intent canvas feedback: D3 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D3 Timer2 tone intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('Timer2 tone-intent feedback marks only the exact MCU and D3 controller-output identity. No buzzer, speaker, emitted sound, loudness, load/current, electrical waveform, calibrated timing, or PCB copper is highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-step-dir-intent') {
    const stepDirEvidence = deriveStepDirIntentEvidence(result);
    if (!stepDirEvidence) {
      feedback.diagnostics.push('Skipped Step/Dir canvas feedback because the exact three-pulse D2/D3/D4 fixture evidence was incomplete or malformed.');
      return feedback;
    }
    const required = new Set(['D2', 'D3', 'D4']);
    const owners = new Map<string, Map<string, AnyCircuitElement>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = normalized(str(port.name) ?? '');
      if (!owner || !required.has(name)) continue;
      const named = owners.get(owner) ?? new Map<string, AnyCircuitElement>();
      if (named.has(name)) named.set(name, {} as AnyCircuitElement);
      else named.set(name, port);
      owners.set(owner, named);
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_STEP_DIR_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const matches = [...owners.entries()].filter(([owner, named]) => expectedOwners.has(owner)
      && named.size === required.size
      && [...required].every((name) => named.get(name)?.type === 'source_port'));
    const d2Trace = result.traces.filter((trace) => trace.name === 'D2'
      && trace.origin?.family === 'avr' && trace.origin.port === 'D' && trace.origin.bit === 2);
    if (matches.length === 1 && d2Trace.length === 1) {
      const [sourceComponentId, named] = matches[0];
      const port = named.get('D2')!;
      const sourcePortId = str(port.source_port_id);
      if (sourcePortId) {
        const connectedTraces = elements.filter((element) => element.type === 'source_trace'
          && Array.isArray(element.connected_source_port_ids)
          && element.connected_source_port_ids.includes(sourcePortId));
        const keys = new Set([
          str(port.subcircuit_connectivity_map_key),
          ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
        ].filter((value): value is string => Boolean(value)));
        if (keys.size !== 1) {
          feedback.diagnostics.push(`Skipped Step/Dir canvas feedback: D2 resolved to ${keys.size} exact connectivity key(s), expected one.`);
          return feedback;
        }
        feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D2 STEP pulse intent' });
        feedback.sourcePortIds.push(sourcePortId);
        feedback.connectivityKeys.push([...keys][0]);
        feedback.diagnostics.push('Step/Dir feedback marks only the exact MCU and D2 STEP identity. D3/D4 levels remain numeric evidence; the driver, motor, motion, and PCB copper are not highlighted or simulated.');
      }
    } else {
      feedback.diagnostics.push(`Skipped Step/Dir canvas feedback: expected one exact D2/D3/D4 MCU owner and one exact D2 trace; found ${matches.length} owner(s) and ${d2Trace.length} D2 trace(s).`);
    }
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-limit-interlock-intent') {
    const interlockEvidence = deriveLimitInterlockEvidence(result);
    if (!interlockEvidence) {
      feedback.diagnostics.push('Skipped LIMIT interlock canvas feedback because the exact D7 input and D2/D4 response evidence was incomplete or malformed.');
      return feedback;
    }
    const required = new Set(['D2', 'D4', 'D7']);
    const owners = new Map<string, Map<string, AnyCircuitElement>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = normalized(str(port.name) ?? '');
      if (!owner || !required.has(name)) continue;
      const named = owners.get(owner) ?? new Map<string, AnyCircuitElement>();
      if (named.has(name)) named.set(name, {} as AnyCircuitElement);
      else named.set(name, port);
      owners.set(owner, named);
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_LIMIT_INTERLOCK_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const matches = [...owners.entries()].filter(([owner, named]) => expectedOwners.has(owner)
      && named.size === required.size
      && [...required].every((name) => named.get(name)?.type === 'source_port'));
    if (matches.length === 1) {
      const [sourceComponentId, named] = matches[0];
      const port = named.get('D7')!;
      const sourcePortId = str(port.source_port_id);
      if (sourcePortId) {
        const connectedTraces = elements.filter((element) => element.type === 'source_trace'
          && Array.isArray(element.connected_source_port_ids)
          && element.connected_source_port_ids.includes(sourcePortId));
        const keys = new Set([
          str(port.subcircuit_connectivity_map_key),
          ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
        ].filter((value): value is string => Boolean(value)));
        if (keys.size !== 1) {
          feedback.diagnostics.push(`Skipped LIMIT interlock canvas feedback: D7 resolved to ${keys.size} exact connectivity key(s), expected one.`);
          return feedback;
        }
        feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D7 modeled LIMIT input' });
        feedback.sourcePortIds.push(sourcePortId);
        feedback.connectivityKeys.push([...keys][0]);
        feedback.diagnostics.push('LIMIT interlock feedback marks only the exact MCU and D7 modeled input identity. D2/D4 response remains numeric evidence; no switch, safety circuit, driver, motor, motion, or PCB copper is highlighted or simulated.');
      }
    } else {
      feedback.diagnostics.push(`Skipped LIMIT interlock canvas feedback: expected one exact D2/D4/D7 fixture MCU owner; found ${matches.length}.`);
    }
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-quadrature-detent-intent') {
    const quadratureEvidence = deriveQuadratureDetentEvidence(result);
    if (!quadratureEvidence) {
      feedback.diagnostics.push('Skipped quadrature canvas feedback because the exact four D2/D3 input phases and D5/D6 latch evidence were incomplete or malformed.');
      return feedback;
    }
    const required = new Set(['D2', 'D3', 'D5', 'D6']);
    const owners = new Map<string, Map<string, AnyCircuitElement>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = normalized(str(port.name) ?? '');
      if (!owner || !required.has(name)) continue;
      const named = owners.get(owner) ?? new Map<string, AnyCircuitElement>();
      if (named.has(name)) named.set(name, {} as AnyCircuitElement);
      else named.set(name, port);
      owners.set(owner, named);
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_QUADRATURE_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const matches = [...owners.entries()].filter(([owner, named]) => expectedOwners.has(owner)
      && named.size === required.size
      && [...required].every((name) => named.get(name)?.type === 'source_port'));
    if (matches.length !== 1) {
      feedback.diagnostics.push(`Skipped quadrature canvas feedback: expected one exact D2/D3/D5/D6 fixture MCU owner; found ${matches.length}.`);
      return feedback;
    }
    const [sourceComponentId, named] = matches[0];
    const resolved = ['D2', 'D3'].map((name) => {
      const port = named.get(name)!;
      const sourcePortId = str(port.source_port_id);
      const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
        && Array.isArray(element.connected_source_port_ids)
        && element.connected_source_port_ids.includes(sourcePortId)) : [];
      const keys = new Set([
        str(port.subcircuit_connectivity_map_key),
        ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
      ].filter((value): value is string => Boolean(value)));
      return { name, sourcePortId, keys };
    });
    if (resolved.some((entry) => !entry.sourcePortId || entry.keys.size !== 1)) {
      feedback.diagnostics.push(`Skipped quadrature canvas feedback: D2/D3 input identities require one source port and one exact connectivity key each; resolved ${resolved.map((entry) => `${entry.name}:${entry.sourcePortId ? entry.keys.size : 0}`).join(', ')}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: `D2/D3 ${quadratureEvidence.direction} quadrature input intent` });
    for (const entry of resolved) {
      feedback.sourcePortIds.push(entry.sourcePortId!);
      feedback.connectivityKeys.push([...entry.keys][0]);
    }
    feedback.diagnostics.push('Quadrature feedback marks only the exact MCU and D2/D3 modeled input identities. D5/D6 latches remain numeric evidence; no encoder, contact behavior, motion, mechanical direction, or PCB copper is highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-button-debounce-intent') {
    const debounceEvidence = deriveButtonDebounceEvidence(result);
    if (!debounceEvidence) {
      feedback.diagnostics.push('Skipped button-debounce canvas feedback because the exact D7 input profile and D4/D5 latch evidence were incomplete or malformed.');
      return feedback;
    }
    const required = new Set(['D4', 'D5', 'D7']);
    const owners = new Map<string, Map<string, AnyCircuitElement>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = normalized(str(port.name) ?? '');
      if (!owner || !required.has(name)) continue;
      const named = owners.get(owner) ?? new Map<string, AnyCircuitElement>();
      if (named.has(name)) named.set(name, {} as AnyCircuitElement);
      else named.set(name, port);
      owners.set(owner, named);
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_BUTTON_DEBOUNCE_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const matches = [...owners.entries()].filter(([owner, named]) => expectedOwners.has(owner)
      && named.size === required.size
      && [...required].every((name) => named.get(name)?.type === 'source_port'));
    if (matches.length !== 1) {
      feedback.diagnostics.push(`Skipped button-debounce canvas feedback: expected one exact D4/D5/D7 fixture MCU owner; found ${matches.length}.`);
      return feedback;
    }
    const [sourceComponentId, named] = matches[0];
    const port = named.get('D7')!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped button-debounce canvas feedback: D7 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: `D7 ${debounceEvidence.profile} button input intent` });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('Button-debounce feedback marks only the exact MCU and D7 modeled input identity. D4/D5 latches remain numeric evidence; no button, contact physics, analog waveform, safety behavior, or PCB copper is highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-neopixel-frame-intent') {
    const frames = (result.peripheralEvents ?? []).filter((event) => event.kind === 'neopixel-frame-intent');
    if (frames.length !== 1) {
      feedback.diagnostics.push(`Skipped NeoPixel frame canvas feedback: expected one exact fixture-derived frame event; found ${frames.length}.`);
      return feedback;
    }
    const required = new Set(['D6']);
    const owners = new Map<string, Map<string, AnyCircuitElement>>();
    for (const port of ports) {
      const owner = str(port.source_component_id);
      const name = normalized(str(port.name) ?? '');
      if (!owner || !required.has(name)) continue;
      const named = owners.get(owner) ?? new Map<string, AnyCircuitElement>();
      if (named.has(name)) named.set(name, {} as AnyCircuitElement);
      else named.set(name, port);
      owners.set(owner, named);
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_NEOPIXEL_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const matches = [...owners.entries()].filter(([owner, named]) => expectedOwners.has(owner)
      && named.size === 1 && named.get('D6')?.type === 'source_port');
    if (matches.length !== 1) {
      feedback.diagnostics.push(`Skipped NeoPixel frame canvas feedback: expected one exact D6 fixture MCU owner; found ${matches.length}.`);
      return feedback;
    }
    const [sourceComponentId, named] = matches[0];
    const port = named.get('D6')!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped NeoPixel frame canvas feedback: D6 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D6 NeoPixel byte/pulse intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('NeoPixel frame feedback marks only the exact MCU and D6 controller-output identity. The context component, pixel response, emitted light/color, electrical waveform, calibrated timing, and PCB copper are not highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-eeprom-roundtrip-intent') {
    const evidence = deriveEepromRoundtripIntentEvidence(result);
    if (!evidence) {
      feedback.diagnostics.push('Skipped EEPROM round-trip canvas feedback because exact write/read and D6 success evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_EEPROM_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const d6Ports = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === 'D6');
    const d6Traces = result.traces.filter((trace) => trace.name === 'D6'
      && trace.origin?.family === 'avr' && trace.origin.port === 'D' && trace.origin.bit === 6);
    if (expectedOwners.size !== 1 || d6Ports.length !== 1 || d6Traces.length !== 1) {
      feedback.diagnostics.push(`Skipped EEPROM round-trip canvas feedback: expected one exact fixture MCU, D6 source port, and D6 trace; found ${expectedOwners.size}/${d6Ports.length}/${d6Traces.length}.`);
      return feedback;
    }
    const port = d6Ports[0];
    const sourceComponentId = str(port.source_component_id)!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped EEPROM round-trip canvas feedback: D6 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D6 EEPROM round-trip success intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('EEPROM feedback marks only the exact MCU and D6 firmware-success identity. EEPROM retention/endurance, power-loss safety, attached indicators, electrical behavior, and PCB copper are not highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-watchdog-reset-intent') {
    const evidence = deriveWatchdogResetIntentEvidence(result);
    if (!evidence) {
      feedback.diagnostics.push('Skipped watchdog-reset canvas feedback because exact reset/MCUSR and D5/D6 evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_WATCHDOG_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const d6Ports = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === 'D6');
    const d6Traces = result.traces.filter((trace) => trace.name === 'D6'
      && trace.origin?.family === 'avr' && trace.origin.port === 'D' && trace.origin.bit === 6);
    if (expectedOwners.size !== 1 || d6Ports.length !== 1 || d6Traces.length !== 1) {
      feedback.diagnostics.push(`Skipped watchdog-reset canvas feedback: expected one exact fixture MCU, D6 source port, and D6 trace; found ${expectedOwners.size}/${d6Ports.length}/${d6Traces.length}.`);
      return feedback;
    }
    const port = d6Ports[0];
    const sourceComponentId = str(port.source_component_id)!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped watchdog-reset canvas feedback: D6 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D6 watchdog reset-observed intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('Watchdog feedback marks only the exact MCU and D6 firmware reset-observed identity. Timeout calibration, brownout/reset-pin/bootloader behavior, startup safety, attached indicators, electrical behavior, and PCB copper are not highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-int0-interrupt-intent') {
    const evidence = deriveInt0InterruptIntentEvidence(result);
    if (!evidence) {
      feedback.diagnostics.push('Skipped INT0 canvas feedback because exact D2 input/vector-entry and D5/D6 ISR evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_INT0_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const d2Ports = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === 'D2');
    if (expectedOwners.size !== 1 || d2Ports.length !== 1) {
      feedback.diagnostics.push(`Skipped INT0 canvas feedback: expected one exact fixture MCU and D2 source port; found ${expectedOwners.size}/${d2Ports.length}.`);
      return feedback;
    }
    const port = d2Ports[0];
    const sourceComponentId = str(port.source_component_id)!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped INT0 canvas feedback: D2 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: 'D2 INT0 falling-edge intent' });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('INT0 feedback marks only the exact MCU and D2 modeled interrupt-input identity. D5/D6 latches remain numeric evidence; no switch/sensor, electrical edge, latency guarantee, priority/nesting, or PCB copper is highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-timer1-pulse-counter-intent') {
    const evidence = deriveTimer1PulseCounterIntentEvidence(result);
    if (!evidence) {
      feedback.diagnostics.push('Skipped Timer1 pulse-counter canvas feedback because exact D5 input/count/read and D6/D7 latch evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_PULSE_COUNTER_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const d5Ports = ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === 'D5');
    if (expectedOwners.size !== 1 || d5Ports.length !== 1) {
      feedback.diagnostics.push(`Skipped Timer1 pulse-counter canvas feedback: expected one exact fixture MCU and D5 source port; found ${expectedOwners.size}/${d5Ports.length}.`);
      return feedback;
    }
    const port = d5Ports[0];
    const sourceComponentId = str(port.source_component_id)!;
    const sourcePortId = str(port.source_port_id);
    const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId)) : [];
    const keys = new Set([
      str(port.subcircuit_connectivity_map_key),
      ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key)),
    ].filter((value): value is string => Boolean(value)));
    if (!sourcePortId || keys.size !== 1) {
      feedback.diagnostics.push(`Skipped Timer1 pulse-counter canvas feedback: D5 requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
      return feedback;
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: `D5/T1 ${evidence.countedPulseCount}-pulse counter intent` });
    feedback.sourcePortIds.push(sourcePortId);
    feedback.connectivityKeys.push([...keys][0]);
    feedback.diagnostics.push('Timer1 pulse-counter feedback marks only the exact MCU and D5 modeled counter-input identity. D6/D7 latches remain numeric evidence; no frequency, RPM/tachometer, missed-pulse, electrical-edge, or PCB-copper behavior is highlighted or simulated.');
    return feedback;
  }
  if (result.firmwareFixture?.id === 'avr-pcint-mask-intent') {
    const evidence = derivePcintMaskIntentEvidence(result);
    if (!evidence) {
      feedback.diagnostics.push('Skipped PCINT mask canvas feedback because exact PCMSK2 input/vector/latch evidence was incomplete or malformed.');
      return feedback;
    }
    const expectedOwners = new Set(elements.filter((element) => element.type === 'source_component'
      && str(element.name) === 'ATMEGA328P_PCINT_MASK_EMU')
      .map((element) => str(element.source_component_id))
      .filter((value): value is string => Boolean(value)));
    const aliases = evidence.profile === 1 ? ['D7', 'D4'] : ['D7'];
    const selectedPorts = aliases.map((alias) => ports.filter((port) => expectedOwners.has(str(port.source_component_id) ?? '')
      && normalized(str(port.name) ?? '') === alias));
    if (expectedOwners.size !== 1 || selectedPorts.some((matches) => matches.length !== 1)) {
      feedback.diagnostics.push(`Skipped PCINT mask canvas feedback: expected one exact fixture MCU and ${aliases.join('/')} source port(s); found ${expectedOwners.size}/${selectedPorts.map((matches) => matches.length).join('/')}.`);
      return feedback;
    }
    const sourceComponentId = [...expectedOwners][0];
    const resolved: Array<{ sourcePortId: string; key: string }> = [];
    for (const [index, matches] of selectedPorts.entries()) {
      const port = matches[0];
      const sourcePortId = str(port.source_port_id);
      const connectedTraces = sourcePortId ? elements.filter((element) => element.type === 'source_trace'
        && Array.isArray(element.connected_source_port_ids)
        && element.connected_source_port_ids.includes(sourcePortId)) : [];
      const keys = new Set([str(port.subcircuit_connectivity_map_key), ...connectedTraces.map((trace) => str(trace.subcircuit_connectivity_map_key))]
        .filter((value): value is string => Boolean(value)));
      if (!sourcePortId || keys.size !== 1) {
        feedback.diagnostics.push(`Skipped PCINT mask canvas feedback: ${aliases[index]} requires one source port and one exact connectivity key; resolved ${sourcePortId ? keys.size : 0}.`);
        return feedback;
      }
      resolved.push({ sourcePortId, key: [...keys][0] });
    }
    feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: evidence.profile === 1 ? 'D7 masked + D4 enabled PCINT2 intent' : 'D7 masked PCINT2 intent' });
    feedback.sourcePortIds.push(...resolved.map((item) => item.sourcePortId));
    feedback.connectivityKeys.push(...resolved.map((item) => item.key));
    feedback.diagnostics.push('PCINT mask feedback marks only the exact MCU and modeled D7 masked input, plus D4 enabled input for profile 1. D5/D6 latches remain numeric evidence; no simultaneous-edge, bounce/noise, electrical, latency, PCB-copper, or hardware behavior is highlighted or simulated.');
    return feedback;
  }

  const seenComponents = new Set<string>();
  const seenPorts = new Set<string>();
  const seenNets = new Set<string>();
  for (const trace of result.traces) {
    if (trace.origin?.family !== 'avr' && trace.origin?.family !== 'rp2040') continue;
    const active = trace.v.some((value, index) => index > 0 && value !== trace.v[index - 1]);
    if (!active) continue;
    const aliases = new Set(trace.origin.aliases.map(normalized));
    const matches = ports.filter((port) => {
      const candidates = [str(port.name), ...(Array.isArray(port.port_hints) ? port.port_hints : [])]
        .filter((value): value is string => typeof value === 'string');
      return candidates.some((candidate) => aliases.has(normalized(candidate)));
    });
    if (matches.length !== 1) {
      feedback.diagnostics.push(
        `Skipped ${trace.name}: expected one exact Circuit JSON port, found ${matches.length}.`,
      );
      continue;
    }
    const port = matches[0];
    const sourcePortId = str(port.source_port_id);
    const sourceComponentId = str(port.source_component_id);
    if (!sourcePortId || !sourceComponentId) {
      feedback.diagnostics.push(`Skipped ${trace.name}: matched port lacks stable source identity.`);
      continue;
    }
    if (!seenComponents.has(sourceComponentId)) {
      seenComponents.add(sourceComponentId);
      feedback.components.push({ sourceComponentId, kind: 'mcu-activity', label: trace.name });
    }
    if (!seenPorts.has(sourcePortId)) {
      seenPorts.add(sourcePortId);
      feedback.sourcePortIds.push(sourcePortId);
    }
    const connectedTrace = elements.find((element) => element.type === 'source_trace'
      && Array.isArray(element.connected_source_port_ids)
      && element.connected_source_port_ids.includes(sourcePortId));
    const key = str(port.subcircuit_connectivity_map_key)
      ?? str(connectedTrace?.subcircuit_connectivity_map_key);
    if (key && !seenNets.has(key)) {
      seenNets.add(key);
      feedback.connectivityKeys.push(key);
    }
  }
  return feedback;
}
