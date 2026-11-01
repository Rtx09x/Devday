import type { ElectronicsEditorAPI } from '../editorApi.ts';
import {
  canonicalJson,
  circuitJsonFingerprint,
  checkArtifactFreshnessSnapshot,
  sha256Text,
  writeTrackedExport,
  type TextFileSystem,
} from '../circuit/artifactFreshness.ts';
import { validateCanonicalWorkspaceRelativePath } from '../circuit/designReviewPacket.ts';
import { getFirmwareFixture } from './firmwareFixtures.ts';
import { validateAssertions, type Assertion, type TestReport } from './testHarness.ts';
import { SIMULATION_PROJECTION_SCHEMA } from '../circuit/simulationProjection.ts';
import type { FirmwareFixtureId, McuTarget } from './types.ts';
import { normalizeFixtureStimulus, type NormalizedFixtureStimulus } from './fixtureStimulus.ts';

export const SIMULATION_TEST_SCHEMA = 'cutucircuits-electronics/simulation-test@2' as const;
export const SIMULATION_TEST_GENERATOR = 'electronics-simulation-test@2' as const;
const LEGACY_SIMULATION_TEST_SCHEMA = 'cutucircuits-electronics/simulation-test@1' as const;
const LEGACY_SIMULATION_TEST_GENERATOR = 'electronics-simulation-test@1' as const;

export interface SimulationTestArtifact {
  schema: typeof SIMULATION_TEST_SCHEMA;
  generator: typeof SIMULATION_TEST_GENERATOR;
  name: string;
  design: {
    sourceOrigin: 'editor-buffer';
    persistenceState: 'unknown';
    sourceSha256: string;
    circuitJsonSha256: string;
    simulationProjectionSchema: typeof SIMULATION_PROJECTION_SCHEMA;
    simulationProjectionSha256: string;
  };
  simulation: {
    mode: 'mcu';
    mcu: Exclude<McuTarget, 'esp32'>;
    fixture: FirmwareFixtureId;
    fixtureSha256: string;
    fixtureSourcePath: string;
    durationMs: number;
    stimulus: NormalizedFixtureStimulus;
  };
  assertions: Assertion[];
  scope: {
    proves: 'repeatable-emulator-assertions-against-one-exact-design-revision';
    doesNotProve: string[];
  };
}

export interface CreateSimulationTestResult {
  status: 'created' | 'refused' | 'incomplete';
  output_path: string;
  manifest_path: string;
  sourceStableBeforeWrite: boolean;
  sourceStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  test_sha256?: string;
  source_sha256?: string;
  circuit_json_sha256?: string;
  circuit_json_fingerprint_schema?: typeof SIMULATION_PROJECTION_SCHEMA;
  simulation_projection_sha256?: string;
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

export type RunSimulationTestResult = {
  status: 'passed' | 'failed' | 'refused';
  test_path: string;
  manifest_path: string;
  readOnly: true;
  sourceStableThroughRun: boolean;
  freshnessAtStart: 'fresh' | 'not-checked';
  freshAtReturn: 'not-guaranteed';
  report?: TestReport;
  refusal?: { code: string; message: string };
};

const DOES_NOT_PROVE = [
  'physical-board or attached-peripheral behavior',
  'timing fidelity outside the emulator evidence',
  'ERC, DRC, DFM, fabrication, or manufacturing correctness',
  'KiCad application validation',
  'offline validation',
  'manifest authenticity or resistance to coordinated manifest and artifact edits',
];

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 128
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('name must be a non-empty control-free string no longer than 128 characters.');
  }
  return value;
}

function duration(value: unknown, fallback: number): number {
  const result = value == null ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1 || result > 10_000) {
    throw new Error('duration_ms must be an integer from 1 to 10000.');
  }
  return result;
}

function baseCreate(outputPath: string, manifestPath: string): CreateSimulationTestResult {
  return {
    status: 'refused', output_path: outputPath, manifest_path: manifestPath,
    sourceStableBeforeWrite: false, sourceStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed', nonAtomicNoClobber: true, symlinkConfinement: 'unproven',
  };
}

function strictObject(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} has unsupported field(s): ${unknown.join(', ')}.`);
  return record;
}

export function parseSimulationTestArtifact(text: string): SimulationTestArtifact {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Simulation test is not valid JSON.'); }
  const item = strictObject(value, 'Simulation test', ['schema', 'generator', 'name', 'design', 'simulation', 'assertions', 'scope']);
  const legacy = item.schema === LEGACY_SIMULATION_TEST_SCHEMA && item.generator === LEGACY_SIMULATION_TEST_GENERATOR;
  if (!legacy && (item.schema !== SIMULATION_TEST_SCHEMA || item.generator !== SIMULATION_TEST_GENERATOR)) throw new Error('Simulation test schema or generator is unsupported.');
  const design = strictObject(item.design, 'design', ['sourceOrigin', 'persistenceState', 'sourceSha256', 'circuitJsonSha256', 'simulationProjectionSchema', 'simulationProjectionSha256']);
  if (design.sourceOrigin !== 'editor-buffer' || design.persistenceState !== 'unknown') throw new Error('Simulation test design origin is unsupported.');
  if (typeof design.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(design.sourceSha256)
    || typeof design.circuitJsonSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(design.circuitJsonSha256)
    || design.simulationProjectionSchema !== SIMULATION_PROJECTION_SCHEMA
    || typeof design.simulationProjectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(design.simulationProjectionSha256)) throw new Error('Simulation test design fingerprints are invalid.');
  const simulation = strictObject(item.simulation, 'simulation', legacy
    ? ['mode', 'mcu', 'fixture', 'fixtureSha256', 'fixtureSourcePath', 'durationMs']
    : ['mode', 'mcu', 'fixture', 'fixtureSha256', 'fixtureSourcePath', 'durationMs', 'stimulus']);
  const fixture = getFirmwareFixture(String(simulation.fixture));
  if (simulation.mode !== 'mcu' || !fixture || fixture.mcu === 'esp32' || simulation.mcu !== fixture.mcu) throw new Error('Simulation test fixture or MCU family is unsupported or mismatched.');
  if (simulation.fixtureSha256 !== fixture.sha256 || simulation.fixtureSourcePath !== fixture.sourcePath) throw new Error('Bundled fixture provenance differs from the recorded regression. Recreate it explicitly.');
  if (legacy && (fixture.id === 'avr-adc-threshold' || fixture.id === 'avr-adc-pwm-controller-intent' || fixture.id === 'avr-uart-command-response' || fixture.id === 'avr-limit-interlock-intent' || fixture.id === 'avr-quadrature-detent-intent' || fixture.id === 'avr-button-debounce-intent' || fixture.id === 'avr-int0-interrupt-intent' || fixture.id === 'avr-timer1-pulse-counter-intent' || fixture.id === 'avr-pcint-mask-intent')) throw new Error('This input-driven fixture requires simulation-test schema v2 with explicit normalized stimulus.');
  const stimulus = normalizeFixtureStimulus(fixture.id, legacy ? undefined : simulation.stimulus);
  const scope = strictObject(item.scope, 'scope', ['proves', 'doesNotProve']);
  if (scope.proves !== 'repeatable-emulator-assertions-against-one-exact-design-revision'
    || !Array.isArray(scope.doesNotProve) || scope.doesNotProve.some((entry) => typeof entry !== 'string')) throw new Error('Simulation test scope is malformed.');
  return {
    schema: SIMULATION_TEST_SCHEMA,
    generator: SIMULATION_TEST_GENERATOR,
    name: cleanName(item.name),
    design: {
      sourceOrigin: 'editor-buffer', persistenceState: 'unknown',
      sourceSha256: design.sourceSha256, circuitJsonSha256: design.circuitJsonSha256,
      simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA,
      simulationProjectionSha256: design.simulationProjectionSha256,
    },
    simulation: {
      mode: 'mcu', mcu: fixture.mcu, fixture: fixture.id,
      fixtureSha256: fixture.sha256, fixtureSourcePath: fixture.sourcePath,
      durationMs: duration(simulation.durationMs, fixture.defaultDurationMs), stimulus,
    },
    assertions: validateAssertions(item.assertions),
    scope: {
      proves: 'repeatable-emulator-assertions-against-one-exact-design-revision',
      doesNotProve: [...scope.doesNotProve] as string[],
    },
  };
}

export async function createSimulationTestArtifact(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot'>;
  fs: TextFileSystem;
  workspacePath: string;
  outputPath: unknown;
  manifestPath: unknown;
  name: unknown;
  assertions: unknown;
  fixture: unknown;
  stimulus?: unknown;
  durationMs?: unknown;
}): Promise<CreateSimulationTestResult> {
  let outputRelative = typeof input.outputPath === 'string' ? input.outputPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  try {
    if (!input.workspacePath) throw new Error('A workspace must be open before creating a workspace-local simulation test.');
    outputRelative = validateCanonicalWorkspaceRelativePath(input.outputPath, 'output_path', '.electronics.simulation-test.json');
    manifestRelative = validateCanonicalWorkspaceRelativePath(input.manifestPath, 'manifest_path', '.freshness.json');
    if (outputRelative === manifestRelative) throw new Error('Simulation test and manifest paths must be distinct.');
    const name = cleanName(input.name);
    const assertions = validateAssertions(input.assertions);
    if (typeof input.fixture !== 'string') throw new Error('fixture must be one explicit supported bundled fixture ID.');
    const fixture = getFirmwareFixture(input.fixture);
    if (!fixture || fixture.mcu === 'esp32') throw new Error('fixture must be one explicit supported bundled fixture ID.');
    const durationMs = duration(input.durationMs, fixture.defaultDurationMs);
    const stimulus = normalizeFixtureStimulus(fixture.id, input.stimulus);
    const outputAbsolute = joinWorkspace(input.workspacePath, outputRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const base = baseCreate(outputRelative, manifestRelative);
    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return { ...base, refusal: { code: 'snapshot-failed', message: `The copied editor source failed evaluation: ${snapshot.evalError}` } };
    if (input.api.getCode() !== snapshot.source) return { ...base, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed before any intentional write.' } };
    const [sourceSha256, circuitJsonSha256, projectionSha256] = await Promise.all([
      sha256Text(snapshot.source), sha256Text(canonicalJson(snapshot.circuitJson)), circuitJsonFingerprint(snapshot.circuitJson, SIMULATION_PROJECTION_SCHEMA),
    ]);
    const artifact: SimulationTestArtifact = {
      schema: SIMULATION_TEST_SCHEMA, generator: SIMULATION_TEST_GENERATOR, name,
      design: {
        sourceOrigin: 'editor-buffer', persistenceState: 'unknown', sourceSha256, circuitJsonSha256,
        simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA, simulationProjectionSha256: projectionSha256,
      },
      simulation: {
        mode: 'mcu', mcu: fixture.mcu, fixture: fixture.id, fixtureSha256: fixture.sha256,
        fixtureSourcePath: fixture.sourcePath, durationMs,
        stimulus,
      },
      assertions,
      scope: { proves: 'repeatable-emulator-assertions-against-one-exact-design-revision', doesNotProve: DOES_NOT_PROVE },
    };
    const text = `${canonicalJson(artifact)}\n`;
    const testSha256 = await sha256Text(text);
    const provenance = { source_sha256: sourceSha256, circuit_json_sha256: circuitJsonSha256, circuit_json_fingerprint_schema: SIMULATION_PROJECTION_SCHEMA, simulation_projection_sha256: projectionSha256, test_sha256: testSha256 };
    if (input.api.getCode() !== snapshot.source) return { ...base, ...provenance, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed while the test was assembled; no intentional write was attempted.' } };
    for (const parent of new Set([parentPath(outputAbsolute), parentPath(manifestAbsolute)])) {
      if (!(await input.fs.fileExists(parent))) return { ...base, ...provenance, refusal: { code: 'parent-missing-or-unevidenced', message: `Destination parent does not exist as far as fileExists can evidence: ${parent}` } };
    }
    if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) return { ...base, ...provenance, refusal: { code: 'path-exists', message: 'The simulation test or manifest already exists; overwrite-anyway is never offered.' } };
    let writeStage: 'none' | 'test' | 'manifest' = 'none';
    let sourceStableBeforeWrite = false;
    let sourceStableBeforeManifest = false;
    const guardedFs = {
      writeFile: async (path: string, content: string) => {
        if (path === outputAbsolute) {
          if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) throw new Error('A destination appeared after the non-atomic preflight; no intentional test write was attempted.');
          sourceStableBeforeWrite = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeWrite) throw new Error('The editor-buffer source changed immediately before test write.');
          writeStage = 'test';
        } else {
          if (await input.fs.fileExists(manifestAbsolute)) throw new Error('The manifest destination appeared after the non-atomic preflight; it was not knowingly overwritten.');
          sourceStableBeforeManifest = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeManifest) throw new Error('The editor-buffer source changed immediately before manifest write.');
          writeStage = 'manifest';
        }
        await input.fs.writeFile(path, content);
      },
    };
    try {
      await writeTrackedExport({
        fs: guardedFs, manifestPath: manifestAbsolute, source: snapshot.source, circuitJson: snapshot.circuitJson,
        kind: 'simulation-test', options: { schema: SIMULATION_TEST_SCHEMA, generator: SIMULATION_TEST_GENERATOR, fixture: fixture.id },
        circuitFingerprintSchema: SIMULATION_PROJECTION_SCHEMA,
        artifacts: [{ path: outputAbsolute, text }],
        assertSourceCurrent: () => { if (input.api.getCode() !== snapshot.source) throw new Error('The editor-buffer source changed during simulation-test emission.'); },
      });
      return { ...base, ...provenance, status: 'created', sourceStableBeforeWrite, sourceStableBeforeManifest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (writeStage === 'none') return { ...base, ...provenance, sourceStableBeforeWrite, sourceStableBeforeManifest, refusal: { code: 'write-refused', message } };
      return { ...base, ...provenance, status: 'incomplete', sourceStableBeforeWrite, sourceStableBeforeManifest, cleanup: { automatic: false, pathsThatMayExist: writeStage === 'test' ? [outputRelative] : [outputRelative, manifestRelative] }, refusal: { code: 'write-failed', message } };
    }
  } catch (error) {
    return { ...baseCreate(outputRelative, manifestRelative), refusal: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function runSimulationTestArtifact(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot' | 'runTest'>;
  fs: Pick<TextFileSystem, 'readFile' | 'fileExists'>;
  workspacePath: string;
  testPath: unknown;
  manifestPath: unknown;
}): Promise<RunSimulationTestResult> {
  let testRelative = typeof input.testPath === 'string' ? input.testPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  const refused = (code: string, message: string, freshnessAtStart: 'fresh' | 'not-checked' = 'not-checked'): RunSimulationTestResult => ({
    status: 'refused', test_path: testRelative, manifest_path: manifestRelative, readOnly: true,
    sourceStableThroughRun: false, freshnessAtStart, freshAtReturn: 'not-guaranteed', refusal: { code, message },
  });
  try {
    if (!input.workspacePath) return refused('workspace-unavailable', 'A workspace must be open before running a workspace-local simulation test.');
    testRelative = validateCanonicalWorkspaceRelativePath(input.testPath, 'test_path', '.electronics.simulation-test.json');
    manifestRelative = validateCanonicalWorkspaceRelativePath(input.manifestPath, 'manifest_path', '.freshness.json');
    if (testRelative === manifestRelative) return refused('path-invalid', 'Simulation test and manifest paths must be distinct.');
    const testAbsolute = joinWorkspace(input.workspacePath, testRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    if (!(await input.fs.fileExists(testAbsolute)) || !(await input.fs.fileExists(manifestAbsolute))) return refused('path-missing', 'The explicit simulation test and completed freshness manifest must both exist.');
    const testTextBefore = await input.fs.readFile(testAbsolute);
    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return refused('snapshot-failed', `The copied editor source failed evaluation: ${snapshot.evalError}`);
    if (input.api.getCode() !== snapshot.source) return refused('source-changed', 'The editor-buffer source changed before provenance validation.');
    const freshness = await checkArtifactFreshnessSnapshot({ fs: input.fs, manifestPath: manifestAbsolute, source: snapshot.source, circuitJson: snapshot.circuitJson });
    if (!freshness.fresh) return refused('freshness-refused', freshness.details.join(' '));
    if (freshness.kind !== 'simulation-test' || freshness.recordedArtifactPaths?.length !== 1 || freshness.recordedArtifactPaths[0] !== testAbsolute) return refused('manifest-scope-mismatch', 'The manifest must record exactly this simulation-test artifact.', 'fresh');
    const testTextAfter = await input.fs.readFile(testAbsolute);
    if (testTextAfter !== testTextBefore || input.api.getCode() !== snapshot.source) return refused('changed-before-run', 'The test artifact or live source changed during validation; retry.', 'fresh');
    const artifact = parseSimulationTestArtifact(testTextAfter);
    const [sourceSha256, circuitJsonSha256, projectionSha256] = await Promise.all([
      sha256Text(snapshot.source), sha256Text(canonicalJson(snapshot.circuitJson)), circuitJsonFingerprint(snapshot.circuitJson, SIMULATION_PROJECTION_SCHEMA),
    ]);
    if (artifact.design.sourceSha256 !== sourceSha256 || artifact.design.circuitJsonSha256 !== circuitJsonSha256
      || artifact.design.simulationProjectionSha256 !== projectionSha256) return refused('design-mismatch', 'The test was pinned to a different exact source, Circuit JSON, or normalized simulation projection revision.', 'fresh');
    const report = await input.api.runTest({ mode: 'mcu', mcu: artifact.simulation.mcu, fixture: artifact.simulation.fixture, durationMs: artifact.simulation.durationMs, stimulus: artifact.simulation.stimulus }, artifact.assertions);
    const sourceStableThroughRun = input.api.getCode() === snapshot.source;
    if (!sourceStableThroughRun) return refused('source-changed-during-run', 'The editor-buffer source changed during simulation; the result was discarded.', 'fresh');
    const expectedEngine = artifact.simulation.mcu === 'avr' ? 'avr8js' : 'rp2040js';
    if (report.engine !== expectedEngine
      || report.firmwareFixture?.id !== artifact.simulation.fixture
      || report.firmwareFixture.sha256 !== artifact.simulation.fixtureSha256
      || report.firmwareFixture.sourcePath !== artifact.simulation.fixtureSourcePath
      || JSON.stringify(report.modeledStimulus ?? {}) !== JSON.stringify(artifact.simulation.stimulus)) {
      return refused('runtime-provenance-mismatch', 'The simulation result did not report the exact pinned engine and bundled fixture provenance.', 'fresh');
    }
    return {
      status: report.pass ? 'passed' : 'failed', test_path: testRelative, manifest_path: manifestRelative,
      readOnly: true, sourceStableThroughRun, freshnessAtStart: 'fresh', freshAtReturn: 'not-guaranteed', report,
    };
  } catch (error) {
    return refused('invalid-or-unsupported', error instanceof Error ? error.message : String(error));
  }
}
