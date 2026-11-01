import type { ElectronicsEditorAPI } from '../editorApi.ts';
import {
  canonicalJson,
  circuitJsonFingerprint,
  sha256Text,
  writeTrackedExport,
  type TextFileSystem,
} from '../circuit/artifactFreshness.ts';
import { validateCanonicalWorkspaceRelativePath } from '../circuit/designReviewPacket.ts';
import { SIMULATION_PROJECTION_SCHEMA } from '../circuit/simulationProjection.ts';
import { getFirmwareFixture } from './firmwareFixtures.ts';
import { normalizeFixtureStimulus, type NormalizedFixtureStimulus } from './fixtureStimulus.ts';
import { validateAssertions, type Assertion } from './testHarness.ts';
import type { FirmwareFixtureId, McuTarget } from './types.ts';

export const SIMULATION_MATRIX_SCHEMA = 'cutucircuits-electronics/simulation-matrix@1' as const;
export const SIMULATION_MATRIX_GENERATOR = 'electronics-simulation-matrix@1' as const;
export const MIN_SIMULATION_MATRIX_CASES = 2;
export const MAX_SIMULATION_MATRIX_CASES = 8;
export const MAX_SIMULATION_MATRIX_ASSERTIONS = 64;

export interface SimulationMatrixCase {
  id: string;
  name: string;
  stimulus: NormalizedFixtureStimulus;
  assertions: Assertion[];
}

export interface SimulationMatrixArtifact {
  schema: typeof SIMULATION_MATRIX_SCHEMA;
  generator: typeof SIMULATION_MATRIX_GENERATOR;
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
  };
  cases: SimulationMatrixCase[];
  scope: {
    proves: 'repeatable-emulator-case-assertions-against-one-exact-design-revision';
    doesNotProve: string[];
  };
}

export interface CreateSimulationMatrixResult {
  status: 'created' | 'refused' | 'incomplete';
  output_path: string;
  manifest_path: string;
  sourceStableBeforeWrite: boolean;
  sourceStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  matrix_sha256?: string;
  source_sha256?: string;
  circuit_json_sha256?: string;
  circuit_json_fingerprint_schema?: typeof SIMULATION_PROJECTION_SCHEMA;
  simulation_projection_sha256?: string;
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

export interface SimulationMatrixAgentGrant {
  baseline: string;
  fixture: FirmwareFixtureId;
  consumed: boolean;
}

export function createSimulationMatrixAgentGrant(baseline: string, fixture: FirmwareFixtureId): SimulationMatrixAgentGrant {
  return { baseline, fixture, consumed: false };
}

export function consumeSimulationMatrixAgentGrant(
  grant: SimulationMatrixAgentGrant,
  currentSource: string,
  fixture: unknown,
): SimulationMatrixAgentGrant {
  if (grant.consumed) throw new Error('The Scenario matrix create attempt was already consumed. Select the intent again.');
  if (grant.baseline !== currentSource) throw new Error('The circuit changed after Scenario matrix started. Run the fixture and select the intent again.');
  if (fixture !== grant.fixture) throw new Error(`Scenario matrix permits only the exact observed fixture ${grant.fixture}.`);
  return { ...grant, consumed: true };
}

const DOES_NOT_PROVE = [
  'physical-board or attached-peripheral behavior',
  'UART voltage, wire waveform, calibrated baud, framing, noise, buffering, cable, USB serial, host, or external-device behavior',
  'timing fidelity outside the named emulator evidence',
  'PCB copper continuity or routing correctness',
  'ERC, DRC, DFM, fabrication, or manufacturing correctness',
  'KiCad application validation',
  'offline validation',
  'manifest authenticity or resistance to coordinated manifest and artifact edits',
];

function strictObject(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} has unsupported field(s): ${unknown.join(', ')}.`);
  return record;
}

function cleanName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 128
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} must be a non-empty control-free string no longer than 128 characters.`);
  }
  return value;
}

function caseId(value: unknown, index: number): string {
  if (typeof value !== 'string' || value.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`cases[${index}].id must be a canonical lowercase slug no longer than 48 characters.`);
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

function exactHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function normalizeSimulationMatrixCases(fixture: FirmwareFixtureId, value: unknown): SimulationMatrixCase[] {
  if (!Array.isArray(value) || value.length < MIN_SIMULATION_MATRIX_CASES || value.length > MAX_SIMULATION_MATRIX_CASES) {
    throw new Error(`cases must contain ${MIN_SIMULATION_MATRIX_CASES} to ${MAX_SIMULATION_MATRIX_CASES} explicit ordered cases.`);
  }
  const seenIds = new Set<string>();
  const seenTuples = new Set<string>();
  let assertionCount = 0;
  const cases = value.map((raw, index): SimulationMatrixCase => {
    const record = strictObject(raw, `cases[${index}]`, ['id', 'name', 'stimulus', 'assertions']);
    const id = caseId(record.id, index);
    if (seenIds.has(id)) throw new Error(`cases[${index}].id duplicates canonical case ID ${id}.`);
    seenIds.add(id);
    const stimulus = normalizeFixtureStimulus(fixture, record.stimulus);
    const assertions = validateAssertions(record.assertions);
    assertionCount += assertions.length;
    if (assertionCount > MAX_SIMULATION_MATRIX_ASSERTIONS) {
      throw new Error(`cases may contain at most ${MAX_SIMULATION_MATRIX_ASSERTIONS} assertions in total.`);
    }
    const tuple = canonicalJson({ stimulus, assertions });
    if (seenTuples.has(tuple)) throw new Error(`cases[${index}] duplicates an earlier normalized stimulus/assertion tuple.`);
    seenTuples.add(tuple);
    return { id, name: cleanName(record.name, `cases[${index}].name`), stimulus, assertions };
  });
  return cases;
}

export function parseSimulationMatrixArtifact(text: string): SimulationMatrixArtifact {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Simulation matrix is not valid JSON.'); }
  const item = strictObject(value, 'Simulation matrix', ['schema', 'generator', 'name', 'design', 'simulation', 'cases', 'scope']);
  if (item.schema !== SIMULATION_MATRIX_SCHEMA || item.generator !== SIMULATION_MATRIX_GENERATOR) {
    throw new Error('Simulation matrix schema or generator is unsupported.');
  }
  const design = strictObject(item.design, 'design', [
    'sourceOrigin', 'persistenceState', 'sourceSha256', 'circuitJsonSha256',
    'simulationProjectionSchema', 'simulationProjectionSha256',
  ]);
  if (design.sourceOrigin !== 'editor-buffer' || design.persistenceState !== 'unknown'
    || design.simulationProjectionSchema !== SIMULATION_PROJECTION_SCHEMA) {
    throw new Error('Simulation matrix design origin or projection schema is unsupported.');
  }
  const simulation = strictObject(item.simulation, 'simulation', [
    'mode', 'mcu', 'fixture', 'fixtureSha256', 'fixtureSourcePath', 'durationMs',
  ]);
  const fixture = typeof simulation.fixture === 'string' ? getFirmwareFixture(simulation.fixture) : undefined;
  if (!fixture || fixture.mcu === 'esp32' || simulation.mode !== 'mcu' || simulation.mcu !== fixture.mcu) {
    throw new Error('Simulation matrix fixture or MCU family is unsupported or mismatched.');
  }
  if (simulation.fixtureSha256 !== fixture.sha256 || simulation.fixtureSourcePath !== fixture.sourcePath) {
    throw new Error('Bundled fixture provenance differs from the recorded matrix. Recreate it explicitly.');
  }
  const scope = strictObject(item.scope, 'scope', ['proves', 'doesNotProve']);
  if (scope.proves !== 'repeatable-emulator-case-assertions-against-one-exact-design-revision'
    || !Array.isArray(scope.doesNotProve) || scope.doesNotProve.some((entry) => typeof entry !== 'string')) {
    throw new Error('Simulation matrix scope is malformed.');
  }
  return {
    schema: SIMULATION_MATRIX_SCHEMA,
    generator: SIMULATION_MATRIX_GENERATOR,
    name: cleanName(item.name, 'name'),
    design: {
      sourceOrigin: 'editor-buffer', persistenceState: 'unknown',
      sourceSha256: exactHash(design.sourceSha256, 'design.sourceSha256'),
      circuitJsonSha256: exactHash(design.circuitJsonSha256, 'design.circuitJsonSha256'),
      simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA,
      simulationProjectionSha256: exactHash(design.simulationProjectionSha256, 'design.simulationProjectionSha256'),
    },
    simulation: {
      mode: 'mcu', mcu: fixture.mcu, fixture: fixture.id,
      fixtureSha256: fixture.sha256, fixtureSourcePath: fixture.sourcePath,
      durationMs: duration(simulation.durationMs, fixture.defaultDurationMs),
    },
    cases: normalizeSimulationMatrixCases(fixture.id, item.cases),
    scope: {
      proves: 'repeatable-emulator-case-assertions-against-one-exact-design-revision',
      doesNotProve: [...scope.doesNotProve] as string[],
    },
  };
}

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function baseCreate(outputPath: string, manifestPath: string): CreateSimulationMatrixResult {
  return {
    status: 'refused', output_path: outputPath, manifest_path: manifestPath,
    sourceStableBeforeWrite: false, sourceStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed', nonAtomicNoClobber: true, symlinkConfinement: 'unproven',
  };
}

export async function createSimulationMatrixArtifact(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot'>;
  fs: TextFileSystem;
  workspacePath: string;
  outputPath: unknown;
  manifestPath: unknown;
  name: unknown;
  fixture: unknown;
  durationMs?: unknown;
  cases: unknown;
}): Promise<CreateSimulationMatrixResult> {
  let outputRelative = typeof input.outputPath === 'string' ? input.outputPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  try {
    if (!input.workspacePath) throw new Error('A workspace must be open before creating a workspace-local simulation matrix.');
    outputRelative = validateCanonicalWorkspaceRelativePath(input.outputPath, 'output_path', '.electronics.simulation-matrix.json');
    manifestRelative = validateCanonicalWorkspaceRelativePath(input.manifestPath, 'manifest_path', '.freshness.json');
    if (outputRelative === manifestRelative) throw new Error('Simulation matrix and manifest paths must be distinct.');
    if (typeof input.fixture !== 'string') throw new Error('fixture must be one explicit supported bundled fixture ID.');
    const fixture = getFirmwareFixture(input.fixture);
    if (!fixture || fixture.mcu === 'esp32') throw new Error('fixture must be one explicit supported bundled fixture ID.');
    const durationMs = duration(input.durationMs, fixture.defaultDurationMs);
    const cases = normalizeSimulationMatrixCases(fixture.id, input.cases);
    const outputAbsolute = joinWorkspace(input.workspacePath, outputRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const base = baseCreate(outputRelative, manifestRelative);
    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return { ...base, refusal: { code: 'snapshot-failed', message: `The copied editor source failed evaluation: ${snapshot.evalError}` } };
    if (input.api.getCode() !== snapshot.source) return { ...base, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed before any intentional write.' } };
    const [sourceSha256, circuitJsonSha256, projectionSha256] = await Promise.all([
      sha256Text(snapshot.source), sha256Text(canonicalJson(snapshot.circuitJson)),
      circuitJsonFingerprint(snapshot.circuitJson, SIMULATION_PROJECTION_SCHEMA),
    ]);
    const artifact: SimulationMatrixArtifact = {
      schema: SIMULATION_MATRIX_SCHEMA, generator: SIMULATION_MATRIX_GENERATOR,
      name: cleanName(input.name, 'name'),
      design: {
        sourceOrigin: 'editor-buffer', persistenceState: 'unknown', sourceSha256, circuitJsonSha256,
        simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA, simulationProjectionSha256: projectionSha256,
      },
      simulation: {
        mode: 'mcu', mcu: fixture.mcu, fixture: fixture.id, fixtureSha256: fixture.sha256,
        fixtureSourcePath: fixture.sourcePath, durationMs,
      },
      cases,
      scope: { proves: 'repeatable-emulator-case-assertions-against-one-exact-design-revision', doesNotProve: DOES_NOT_PROVE },
    };
    const text = `${canonicalJson(artifact)}\n`;
    const matrixSha256 = await sha256Text(text);
    const provenance = {
      matrix_sha256: matrixSha256, source_sha256: sourceSha256, circuit_json_sha256: circuitJsonSha256,
      circuit_json_fingerprint_schema: SIMULATION_PROJECTION_SCHEMA, simulation_projection_sha256: projectionSha256,
    };
    if (input.api.getCode() !== snapshot.source) {
      return { ...base, ...provenance, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed while the matrix was assembled; no intentional write was attempted.' } };
    }
    for (const parent of new Set([parentPath(outputAbsolute), parentPath(manifestAbsolute)])) {
      if (!(await input.fs.fileExists(parent))) {
        return { ...base, ...provenance, refusal: { code: 'parent-missing-or-unevidenced', message: `Destination parent does not exist as far as fileExists can evidence: ${parent}` } };
      }
    }
    if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) {
      return { ...base, ...provenance, refusal: { code: 'path-exists', message: 'The simulation matrix or manifest already exists; overwrite-anyway is never offered.' } };
    }
    let writeStage: 'none' | 'matrix' | 'manifest' = 'none';
    let sourceStableBeforeWrite = false;
    let sourceStableBeforeManifest = false;
    const guardedFs = {
      writeFile: async (path: string, content: string) => {
        if (path === outputAbsolute) {
          if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) throw new Error('A destination appeared after the non-atomic preflight; no intentional matrix write was attempted.');
          sourceStableBeforeWrite = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeWrite) throw new Error('The editor-buffer source changed immediately before matrix write.');
          writeStage = 'matrix';
        } else {
          if (await input.fs.fileExists(manifestAbsolute)) throw new Error('The manifest destination appeared after the non-atomic preflight; it was not knowingly overwritten.');
          sourceStableBeforeManifest = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeManifest) throw new Error('The editor-buffer source changed immediately before matrix manifest write.');
          writeStage = 'manifest';
        }
        await input.fs.writeFile(path, content);
      },
    };
    try {
      await writeTrackedExport({
        fs: guardedFs, manifestPath: manifestAbsolute, source: snapshot.source, circuitJson: snapshot.circuitJson,
        kind: 'simulation-matrix',
        options: { schema: SIMULATION_MATRIX_SCHEMA, generator: SIMULATION_MATRIX_GENERATOR, fixture: fixture.id, caseCount: cases.length },
        circuitFingerprintSchema: SIMULATION_PROJECTION_SCHEMA,
        artifacts: [{ path: outputAbsolute, text }],
        assertSourceCurrent: () => { if (input.api.getCode() !== snapshot.source) throw new Error('The editor-buffer source changed during simulation-matrix emission.'); },
      });
      return { ...base, ...provenance, status: 'created', sourceStableBeforeWrite, sourceStableBeforeManifest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (writeStage === 'none') return { ...base, ...provenance, sourceStableBeforeWrite, sourceStableBeforeManifest, refusal: { code: 'write-refused', message } };
      return {
        ...base, ...provenance, status: 'incomplete', sourceStableBeforeWrite, sourceStableBeforeManifest,
        cleanup: { automatic: false, pathsThatMayExist: writeStage === 'matrix' ? [outputRelative] : [outputRelative, manifestRelative] },
        refusal: { code: 'write-failed', message },
      };
    }
  } catch (error) {
    return { ...baseCreate(outputRelative, manifestRelative), refusal: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } };
  }
}
