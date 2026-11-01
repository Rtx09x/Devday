import { SIMULATION_PROJECTION_SCHEMA } from '../circuit/simulationProjection.ts';
import { normalizeFixtureStimulus, type NormalizedFixtureStimulus } from './fixtureStimulus.ts';
import { getFirmwareFixture } from './firmwareFixtures.ts';
import {
  SIMULATION_MATRIX_REPORT_GENERATOR,
  SIMULATION_MATRIX_REPORT_SCHEMA,
} from './simulationMatrixCi.ts';
import { validateAssertions, type AssertionResult } from './testHarness.ts';
import type { FirmwareFixtureId } from './types.ts';

export interface SimulationMatrixReportCaseSummary {
  id: string;
  name: string;
  status: 'passed' | 'failed';
  stimulus: NormalizedFixtureStimulus;
  simulatedMs?: number;
  passed: number;
  failed: number;
  results: AssertionResult[];
}

export interface SimulationMatrixReportSummary {
  status: 'passed' | 'failed';
  name: string;
  matrixPath: string;
  circuitPath: string;
  engine: 'rp2040js' | 'avr8js';
  fixture: FirmwareFixtureId;
  durationMs: number;
  cases: { total: number; passed: number; failed: number };
  assertions: { total: number; passed: number; failed: number };
  caseResults: SimulationMatrixReportCaseSummary[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} must be a bounded control-free string.`);
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function counts(value: unknown, label: string, minTotal: number, maxTotal: number) {
  const record = object(value, label);
  const total = integer(record.total, `${label} total`, minTotal, maxTotal);
  const passed = integer(record.passed, `${label} passed`, 0, maxTotal);
  const failed = integer(record.failed, `${label} failed`, 0, maxTotal);
  if (passed + failed !== total) throw new Error(`${label} counts do not add up.`);
  return { total, passed, failed };
}

function parseResults(value: unknown, passed: number, failed: number, label: string): AssertionResult[] {
  if (!Array.isArray(value) || value.length !== passed + failed || value.length > 32) {
    throw new Error(`${label} results do not match their counts.`);
  }
  const canonical = validateAssertions(value.map((raw, index) => {
    const result = object(raw, `${label} result ${index}`);
    if (typeof result.pass !== 'boolean' || typeof result.detail !== 'string' || result.detail.length > 1024) {
      throw new Error(`${label} result ${index} is malformed.`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof result.actual) && result.actual !== null) {
      throw new Error(`${label} result ${index} actual value is unsupported.`);
    }
    return {
      type: result.type,
      ...(result.target === undefined ? {} : { target: result.target }),
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.tolerance === undefined ? {} : { tolerance: result.tolerance }),
    };
  }));
  const results = value.map((raw, index) => {
    const result = raw as Record<string, unknown>;
    return { ...canonical[index], pass: result.pass as boolean, actual: result.actual, detail: result.detail as string };
  });
  if (results.filter((result) => result.pass).length !== passed || results.filter((result) => !result.pass).length !== failed) {
    throw new Error(`${label} pass/fail flags do not match their counts.`);
  }
  return results;
}

export function parseSimulationMatrixReportSummary(reportText: string): SimulationMatrixReportSummary {
  let value: unknown;
  try { value = JSON.parse(reportText); } catch { throw new Error('Simulation Matrix report is not valid JSON.'); }
  const report = object(value, 'Simulation Matrix report');
  if (report.schema !== SIMULATION_MATRIX_REPORT_SCHEMA || report.generator !== SIMULATION_MATRIX_REPORT_GENERATOR) {
    throw new Error('Simulation Matrix report schema or generator is unsupported.');
  }
  if (report.status !== 'passed' && report.status !== 'failed') throw new Error('Simulation Matrix report status is unsupported.');
  const matrix = object(report.matrix, 'Simulation Matrix report matrix');
  const circuit = object(report.circuit, 'Simulation Matrix report circuit');
  const simulation = object(report.simulation, 'Simulation Matrix report simulation');
  const aggregate = object(report.aggregate, 'Simulation Matrix report aggregate');
  if (circuit.simulationProjectionSchema !== SIMULATION_PROJECTION_SCHEMA) throw new Error('Simulation Matrix report projection schema is unsupported.');
  if (simulation.caseIsolation !== 'fresh-emulator-per-case') throw new Error('Simulation Matrix report case isolation is unsupported.');
  const fixture = typeof simulation.fixture === 'string' ? getFirmwareFixture(simulation.fixture) : undefined;
  const expectedEngine = fixture?.mcu === 'avr' ? 'avr8js' : fixture?.mcu === 'rp2040' ? 'rp2040js' : undefined;
  if (!fixture || simulation.engine !== expectedEngine) throw new Error('Simulation Matrix report engine or fixture is unsupported or mismatched.');
  const caseCounts = counts(aggregate.cases, 'Simulation Matrix report case', 2, 8);
  const assertionCounts = counts(aggregate.assertions, 'Simulation Matrix report assertion', 2, 64);
  if (!Array.isArray(report.cases) || report.cases.length !== caseCounts.total) throw new Error('Simulation Matrix report cases do not match aggregate counts.');
  const ids = new Set<string>();
  const caseResults = report.cases.map((raw, index): SimulationMatrixReportCaseSummary => {
    const entry = object(raw, `Simulation Matrix report case ${index}`);
    const id = text(entry.id, `Simulation Matrix report case ${index} ID`, 48);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) throw new Error('Simulation Matrix report case IDs must be unique canonical lowercase slugs.');
    ids.add(id);
    if (entry.status !== 'passed' && entry.status !== 'failed') throw new Error(`Simulation Matrix report case ${id} status is unsupported.`);
    const assertions = object(entry.assertions, `Simulation Matrix report case ${id} assertions`);
    const passed = integer(assertions.passed, `Simulation Matrix report case ${id} passed assertions`, 0, 32);
    const failed = integer(assertions.failed, `Simulation Matrix report case ${id} failed assertions`, 0, 32);
    if (passed + failed < 1 || passed + failed > 32) throw new Error(`Simulation Matrix report case ${id} must contain 1 to 32 assertions.`);
    const results = parseResults(assertions.results, passed, failed, `Simulation Matrix report case ${id}`);
    if ((entry.status === 'passed') !== (failed === 0)) throw new Error(`Simulation Matrix report case ${id} status does not match its assertions.`);
    const simulatedMs = entry.simulatedMs;
    if (simulatedMs != null && (typeof simulatedMs !== 'number' || !Number.isFinite(simulatedMs) || simulatedMs < 0 || simulatedMs > 10_000)) {
      throw new Error(`Simulation Matrix report case ${id} simulated duration is invalid.`);
    }
    return {
      id,
      name: text(entry.name, `Simulation Matrix report case ${id} name`, 128),
      status: entry.status,
      stimulus: normalizeFixtureStimulus(fixture.id, entry.stimulus),
      ...(simulatedMs == null ? {} : { simulatedMs }),
      passed,
      failed,
      results,
    };
  });
  const derivedCases = {
    total: caseResults.length,
    passed: caseResults.filter((entry) => entry.status === 'passed').length,
    failed: caseResults.filter((entry) => entry.status === 'failed').length,
  };
  const derivedAssertions = {
    total: caseResults.reduce((sum, entry) => sum + entry.passed + entry.failed, 0),
    passed: caseResults.reduce((sum, entry) => sum + entry.passed, 0),
    failed: caseResults.reduce((sum, entry) => sum + entry.failed, 0),
  };
  if (JSON.stringify(derivedCases) !== JSON.stringify(caseCounts) || JSON.stringify(derivedAssertions) !== JSON.stringify(assertionCounts)) {
    throw new Error('Simulation Matrix report aggregate counts do not match its cases.');
  }
  if ((report.status === 'passed') !== (caseCounts.failed === 0)) throw new Error('Simulation Matrix report status does not match its case results.');
  const durationMs = integer(simulation.durationMs, 'Simulation Matrix report duration', 1, 10_000);
  return {
    status: report.status,
    name: text(matrix.name, 'Simulation Matrix report name', 128),
    matrixPath: text(matrix.path, 'Simulation Matrix report matrix path', 1024),
    circuitPath: text(circuit.path, 'Simulation Matrix report circuit path', 1024),
    engine: expectedEngine as 'rp2040js' | 'avr8js',
    fixture: fixture.id,
    durationMs,
    cases: caseCounts,
    assertions: assertionCounts,
    caseResults,
  };
}
