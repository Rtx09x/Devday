import { SIMULATION_PROJECTION_SCHEMA } from '../circuit/simulationProjection.ts';
import { validateAssertions, type AssertionResult } from './testHarness.ts';
import { getFirmwareFixture } from './firmwareFixtures.ts';
import type { FirmwareFixtureId } from './types.ts';
import { normalizeFixtureStimulus, type NormalizedFixtureStimulus } from './fixtureStimulus.ts';

export const SIMULATION_REPORT_SCHEMA = 'cutucircuits-electronics/simulation-report@2' as const;
export const SIMULATION_REPORT_GENERATOR = 'electronics-simulation-report@2' as const;
const LEGACY_SIMULATION_REPORT_SCHEMA = 'cutucircuits-electronics/simulation-report@1' as const;
const LEGACY_SIMULATION_REPORT_GENERATOR = 'electronics-simulation-report@1' as const;

export interface SimulationReportSummary {
  status: 'passed' | 'failed';
  name: string;
  testPath: string;
  circuitPath: string;
  engine: 'rp2040js' | 'avr8js';
  fixture: FirmwareFixtureId;
  durationMs: number;
  stimulus: NormalizedFixtureStimulus;
  simulatedMs?: number;
  passed: number;
  failed: number;
  results: AssertionResult[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} must be a bounded control-free string.`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 32) throw new Error(`${label} must be an integer from 0 to 32.`);
  return value;
}

function duration(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error(`${label} must be an integer from 1 to 10000.`);
  return value;
}

export function parseSimulationReportSummary(reportText: string): SimulationReportSummary {
  let value: unknown;
  try { value = JSON.parse(reportText); } catch { throw new Error('Simulation report is not valid JSON.'); }
  const report = object(value, 'Simulation report');
  const legacy = report.schema === LEGACY_SIMULATION_REPORT_SCHEMA && report.generator === LEGACY_SIMULATION_REPORT_GENERATOR;
  if (!legacy && (report.schema !== SIMULATION_REPORT_SCHEMA || report.generator !== SIMULATION_REPORT_GENERATOR)) throw new Error('Simulation report schema or generator is unsupported.');
  if (report.status !== 'passed' && report.status !== 'failed') throw new Error('Simulation report status is unsupported.');
  const test = object(report.test, 'Simulation report test');
  const circuit = object(report.circuit, 'Simulation report circuit');
  const simulation = object(report.simulation, 'Simulation report simulation');
  const assertions = object(report.assertions, 'Simulation report assertions');
  if (circuit.simulationProjectionSchema !== SIMULATION_PROJECTION_SCHEMA) throw new Error('Simulation report projection schema is unsupported.');
  const fixture = typeof simulation.fixture === 'string' ? getFirmwareFixture(simulation.fixture) : undefined;
  const expectedEngine = fixture?.mcu === 'avr' ? 'avr8js' : fixture?.mcu === 'rp2040' ? 'rp2040js' : undefined;
  if (!fixture || simulation.engine !== expectedEngine) throw new Error('Simulation report engine or fixture is unsupported or mismatched.');
  if (legacy && (fixture.id === 'avr-adc-threshold' || fixture.id === 'avr-adc-pwm-controller-intent' || fixture.id === 'avr-uart-command-response' || fixture.id === 'avr-limit-interlock-intent' || fixture.id === 'avr-quadrature-detent-intent' || fixture.id === 'avr-button-debounce-intent' || fixture.id === 'avr-int0-interrupt-intent' || fixture.id === 'avr-timer1-pulse-counter-intent' || fixture.id === 'avr-pcint-mask-intent')) throw new Error('Input-driven simulation reports require schema v2 with explicit modeled stimulus.');
  const stimulus = normalizeFixtureStimulus(fixture.id, legacy ? undefined : simulation.stimulus);
  const engine = expectedEngine as 'avr8js' | 'rp2040js';
  const passed = count(assertions.passed, 'Simulation report passed count');
  const failed = count(assertions.failed, 'Simulation report failed count');
  if (!Array.isArray(assertions.results) || assertions.results.length !== passed + failed || assertions.results.length > 32) throw new Error('Simulation report assertion results do not match their counts.');
  const canonicalAssertions = validateAssertions(assertions.results.map((raw, index) => {
    const result = object(raw, `Simulation report result ${index}`);
    if (typeof result.pass !== 'boolean' || typeof result.detail !== 'string' || result.detail.length > 1024) throw new Error(`Simulation report result ${index} is malformed.`);
    if (!['string', 'number', 'boolean'].includes(typeof result.actual) && result.actual !== null) throw new Error(`Simulation report result ${index} actual value is unsupported.`);
    return { type: result.type, ...(result.target === undefined ? {} : { target: result.target }), ...(result.value === undefined ? {} : { value: result.value }), ...(result.tolerance === undefined ? {} : { tolerance: result.tolerance }) };
  }));
  const results = assertions.results.map((raw, index) => {
    const result = raw as Record<string, unknown>;
    return { ...canonicalAssertions[index], pass: result.pass as boolean, actual: result.actual, detail: result.detail as string };
  });
  if (results.filter((result) => result.pass).length !== passed || results.filter((result) => !result.pass).length !== failed) throw new Error('Simulation report pass/fail flags do not match their counts.');
  const durationMs = duration(simulation.durationMs, 'Simulation report duration');
  const simulatedMs = simulation.simulatedMs;
  if (simulatedMs != null && (typeof simulatedMs !== 'number' || !Number.isFinite(simulatedMs) || simulatedMs < 0 || simulatedMs > 10_000)) throw new Error('Simulation report simulated duration is invalid.');
  return {
    status: report.status,
    name: text(test.name, 'Simulation report test name', 128),
    testPath: text(test.path, 'Simulation report test path', 1024),
    circuitPath: text(circuit.path, 'Simulation report circuit path', 1024),
    engine, fixture: fixture.id, durationMs, stimulus,
    ...(simulatedMs == null ? {} : { simulatedMs }),
    passed, failed, results,
  };
}
