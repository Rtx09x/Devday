import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import {
  EXPORTER_REVISION,
  canonicalJson,
  circuitJsonFingerprint,
  parseArtifactFreshnessManifest,
  resolveManifestArtifactPath,
  sha256Text,
  writeTrackedExport,
  type TextFileSystem,
} from '../circuit/artifactFreshness.ts';
import { validateCanonicalWorkspaceRelativePath } from '../circuit/designReviewPacket.ts';
import { parseSimulationTestArtifact } from './simulationTestArtifact.ts';
import { runFirmwareTest, type TestReport } from './testHarness.ts';
import { SIMULATION_PROJECTION_SCHEMA } from '../circuit/simulationProjection.ts';
import { SIMULATION_REPORT_GENERATOR, SIMULATION_REPORT_SCHEMA } from './simulationReport.ts';
import type { FirmwareFixtureId } from './types.ts';
import type { NormalizedFixtureStimulus } from './fixtureStimulus.ts';

export { SIMULATION_REPORT_GENERATOR, SIMULATION_REPORT_SCHEMA } from './simulationReport.ts';

export interface SimulationCiReport {
  schema: typeof SIMULATION_REPORT_SCHEMA;
  generator: typeof SIMULATION_REPORT_GENERATOR;
  status: 'passed' | 'failed';
  test: { path: string; manifestPath: string; sha256: string; manifestSha256: string; name: string };
  circuit: {
    path: string;
    sourceSha256: string;
    pinnedEditorCircuitJsonSha256: string;
    headlessCircuitJsonSha256: string;
    simulationProjectionSchema: typeof SIMULATION_PROJECTION_SCHEMA;
    simulationProjectionSha256: string;
  };
  simulation: {
    engine: 'rp2040js' | 'avr8js';
    fixture: FirmwareFixtureId;
    fixtureSha256: string;
    fixtureSourcePath: string;
    durationMs: number;
    stimulus: NormalizedFixtureStimulus;
    simulatedMs?: number;
  };
  assertions: { passed: number; failed: number; results: TestReport['results'] };
  scope: {
    proves: 'repeatable-headless-emulator-assertions-for-pinned-inputs';
    doesNotProve: string[];
  };
}

export interface SimulationCiResult {
  status: 'created-passed' | 'created-failed' | 'refused' | 'incomplete';
  exitCode: 0 | 1 | 2 | 3;
  circuit_path: string;
  test_path: string;
  test_manifest_path: string;
  report_path: string;
  report_manifest_path: string;
  sourceStableThroughRun: boolean;
  inputsStableBeforeReport: boolean;
  inputsStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  report_sha256?: string;
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

const DOES_NOT_PROVE = [
  'physical-board or attached-peripheral behavior',
  'hardware timing fidelity',
  'PCB copper continuity or routing correctness',
  'ERC, DRC, DFM, fabrication, or manufacturing correctness',
  'KiCad application validation',
  'offline validation',
  'manifest authenticity or resistance to coordinated edits',
];

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function base(input: {
  circuitPath: string; testPath: string; testManifestPath: string; reportPath: string; reportManifestPath: string;
}): SimulationCiResult {
  return {
    status: 'refused', exitCode: 2,
    circuit_path: input.circuitPath, test_path: input.testPath, test_manifest_path: input.testManifestPath,
    report_path: input.reportPath, report_manifest_path: input.reportManifestPath,
    sourceStableThroughRun: false, inputsStableBeforeReport: false, inputsStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed', nonAtomicNoClobber: true, symlinkConfinement: 'unproven',
  };
}

export async function runSimulationTestCi(input: {
  fs: TextFileSystem;
  workspacePath: string;
  circuitPath: unknown;
  testPath: unknown;
  testManifestPath: unknown;
  reportPath: unknown;
  reportManifestPath: unknown;
  evaluate: (source: string) => Promise<{ ok: boolean; circuitJson: AnyCircuitElement[]; error?: string }>;
}): Promise<SimulationCiResult> {
  let paths = {
    circuitPath: typeof input.circuitPath === 'string' ? input.circuitPath : '',
    testPath: typeof input.testPath === 'string' ? input.testPath : '',
    testManifestPath: typeof input.testManifestPath === 'string' ? input.testManifestPath : '',
    reportPath: typeof input.reportPath === 'string' ? input.reportPath : '',
    reportManifestPath: typeof input.reportManifestPath === 'string' ? input.reportManifestPath : '',
  };
  try {
    if (!input.workspacePath) throw new Error('workspacePath must be an explicit non-empty path.');
    paths = {
      circuitPath: validateCanonicalWorkspaceRelativePath(input.circuitPath, 'circuit_path', '.circuit.tsx'),
      testPath: validateCanonicalWorkspaceRelativePath(input.testPath, 'test_path', '.electronics.simulation-test.json'),
      testManifestPath: validateCanonicalWorkspaceRelativePath(input.testManifestPath, 'test_manifest_path', '.freshness.json'),
      reportPath: validateCanonicalWorkspaceRelativePath(input.reportPath, 'report_path', '.electronics.simulation-report.json'),
      reportManifestPath: validateCanonicalWorkspaceRelativePath(input.reportManifestPath, 'report_manifest_path', '.freshness.json'),
    };
    if (new Set(Object.values(paths)).size !== 5) throw new Error('Circuit, test, input manifest, report, and report manifest paths must be distinct.');
    const absolute = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, joinWorkspace(input.workspacePath, value)])) as Record<keyof typeof paths, string>;
    const currentBase = base(paths);
    for (const key of ['circuitPath', 'testPath', 'testManifestPath'] as const) {
      if (!(await input.fs.fileExists(absolute[key]))) return { ...currentBase, refusal: { code: 'input-missing', message: `Required explicit input does not exist: ${paths[key]}` } };
    }
    for (const parent of new Set([parentPath(absolute.reportPath), parentPath(absolute.reportManifestPath)])) {
      if (!(await input.fs.fileExists(parent))) return { ...currentBase, refusal: { code: 'parent-missing-or-unevidenced', message: `A report destination parent must already exist as far as fileExists can evidence: ${parent}` } };
    }
    if (await input.fs.fileExists(absolute.reportPath) || await input.fs.fileExists(absolute.reportManifestPath)) {
      return { ...currentBase, refusal: { code: 'path-exists', message: 'The report or completed-manifest destination already exists; overwrite-anyway is never offered.' } };
    }
    const [source, testText, testManifestText] = await Promise.all([
      input.fs.readFile(absolute.circuitPath), input.fs.readFile(absolute.testPath), input.fs.readFile(absolute.testManifestPath),
    ]);
    const artifact = parseSimulationTestArtifact(testText);
    const evaluation = await input.evaluate(source);
    if (!evaluation.ok) return { ...currentBase, refusal: { code: 'evaluation-failed', message: evaluation.error ?? 'The explicit circuit source failed headless evaluation.' } };
    const unchanged = async () => (
      await input.fs.readFile(absolute.circuitPath) === source
      && await input.fs.readFile(absolute.testPath) === testText
      && await input.fs.readFile(absolute.testManifestPath) === testManifestText
    );
    if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-before-run', message: 'A circuit, test, or test-manifest input changed during evaluation; no simulation or output write was attempted.' } };
    const manifest = parseArtifactFreshnessManifest(testManifestText, absolute.testManifestPath);
    if ('state' in manifest) return { ...currentBase, refusal: { code: 'manifest-malformed', message: manifest.details.join(' ') } };
    const [sourceSha256, circuitJsonSha256, projectionSha256, testSha256, testManifestSha256] = await Promise.all([
      sha256Text(source), sha256Text(canonicalJson(evaluation.circuitJson)), circuitJsonFingerprint(evaluation.circuitJson, SIMULATION_PROJECTION_SCHEMA),
      sha256Text(testText), sha256Text(testManifestText),
    ]);
    const exportFingerprint = await sha256Text(canonicalJson({
      kind: manifest.export.kind, options: manifest.export.options, exporterRevision: manifest.exporterRevision,
    }));
    const manifestArtifactPath = manifest.artifacts.length === 1
      ? resolveManifestArtifactPath(absolute.testManifestPath, manifest.artifacts[0].path)
      : undefined;
    const manifestMatches = manifest.exporterRevision === EXPORTER_REVISION
      && manifest.export.kind === 'simulation-test'
      && manifest.export.sha256 === exportFingerprint
      && manifest.source.sha256 === sourceSha256
      && manifest.circuitJson.fingerprintSchema === SIMULATION_PROJECTION_SCHEMA
      && manifest.circuitJson.sha256 === artifact.design.simulationProjectionSha256
      && manifestArtifactPath === absolute.testPath
      && manifest.artifacts[0]?.sha256 === testSha256
      && manifest.artifacts[0]?.bytes === new TextEncoder().encode(testText).byteLength;
    if (!manifestMatches) return { ...currentBase, refusal: { code: 'manifest-provenance-mismatch', message: 'The input manifest does not exactly bind this source, simulation-test artifact, pinned editor projection, exporter revision, and export options.' } };
    if (artifact.design.sourceSha256 !== sourceSha256
      || artifact.design.simulationProjectionSchema !== SIMULATION_PROJECTION_SCHEMA
      || artifact.design.simulationProjectionSha256 !== projectionSha256) {
      return { ...currentBase, refusal: { code: 'design-projection-mismatch', message: 'The exact source or normalized graph-preserving simulation projection differs from the pinned regression.' } };
    }
    let sourceStableThroughRun = true;
    if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-before-run', message: 'An explicit input changed immediately before simulation.' } };
    const runReport = await runFirmwareTest(
      { circuitJson: evaluation.circuitJson, code: source },
      { mode: 'mcu', mcu: artifact.simulation.mcu, fixture: artifact.simulation.fixture, durationMs: artifact.simulation.durationMs, stimulus: artifact.simulation.stimulus },
      artifact.assertions,
    );
    sourceStableThroughRun = await unchanged();
    const expectedEngine = artifact.simulation.mcu === 'avr' ? 'avr8js' : 'rp2040js';
    if (runReport.engine !== expectedEngine
      || runReport.firmwareFixture?.id !== artifact.simulation.fixture
      || runReport.firmwareFixture.sha256 !== artifact.simulation.fixtureSha256
      || runReport.firmwareFixture.sourcePath !== artifact.simulation.fixtureSourcePath
      || JSON.stringify(runReport.modeledStimulus ?? {}) !== JSON.stringify(artifact.simulation.stimulus)) {
      return { ...currentBase, sourceStableThroughRun, refusal: { code: 'runtime-provenance-mismatch', message: 'The headless result did not report the exact pinned engine and bundled fixture provenance.' } };
    }
    if (!sourceStableThroughRun) return { ...currentBase, sourceStableThroughRun: false, refusal: { code: 'inputs-changed-after-run', message: 'An explicit input changed during or after simulation; the result was not emitted.' } };
    const runStatus = runReport.pass ? 'passed' as const : 'failed' as const;
    const report: SimulationCiReport = {
      schema: SIMULATION_REPORT_SCHEMA,
      generator: SIMULATION_REPORT_GENERATOR,
      status: runStatus,
      test: { path: paths.testPath, manifestPath: paths.testManifestPath, sha256: testSha256, manifestSha256: testManifestSha256, name: artifact.name },
      circuit: {
        path: paths.circuitPath, sourceSha256,
        pinnedEditorCircuitJsonSha256: artifact.design.circuitJsonSha256,
        headlessCircuitJsonSha256: circuitJsonSha256,
        simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA,
        simulationProjectionSha256: projectionSha256,
      },
      simulation: {
        engine: expectedEngine, fixture: artifact.simulation.fixture, fixtureSha256: artifact.simulation.fixtureSha256,
        fixtureSourcePath: artifact.simulation.fixtureSourcePath, durationMs: artifact.simulation.durationMs,
        stimulus: artifact.simulation.stimulus,
        ...(runReport.simulatedMs == null ? {} : { simulatedMs: runReport.simulatedMs }),
      },
      assertions: { passed: runReport.passed, failed: runReport.failed, results: runReport.results },
      scope: { proves: 'repeatable-headless-emulator-assertions-for-pinned-inputs', doesNotProve: DOES_NOT_PROVE },
    };
    const reportText = `${canonicalJson(report)}\n`;
    const reportSha256 = await sha256Text(reportText);
    let writeStage: 'none' | 'report' | 'manifest' = 'none';
    let inputsStableBeforeReport = false;
    let inputsStableBeforeManifest = false;
    const guardedFs = {
      writeFile: async (path: string, text: string) => {
        if (path === absolute.reportPath) {
          if (await input.fs.fileExists(absolute.reportPath) || await input.fs.fileExists(absolute.reportManifestPath)) throw new Error('A report destination appeared after the non-atomic preflight; no report write was attempted.');
          inputsStableBeforeReport = await unchanged();
          if (!inputsStableBeforeReport) throw new Error('An explicit input changed immediately before report write.');
          writeStage = 'report';
        } else {
          if (await input.fs.fileExists(absolute.reportManifestPath)) throw new Error('The report-manifest destination appeared after the non-atomic preflight; it was not knowingly overwritten.');
          inputsStableBeforeManifest = await unchanged();
          if (!inputsStableBeforeManifest) throw new Error('An explicit input changed immediately before report-manifest write.');
          writeStage = 'manifest';
        }
        await input.fs.writeFile(path, text);
      },
    };
    try {
      await writeTrackedExport({
        fs: guardedFs, manifestPath: absolute.reportManifestPath, source, circuitJson: evaluation.circuitJson,
        kind: 'simulation-report',
        options: { schema: SIMULATION_REPORT_SCHEMA, generator: SIMULATION_REPORT_GENERATOR, testSha256, testManifestSha256, fixtureSha256: artifact.simulation.fixtureSha256 },
        circuitFingerprintSchema: SIMULATION_PROJECTION_SCHEMA,
        artifacts: [{ path: absolute.reportPath, text: reportText }],
      });
      return {
        ...currentBase,
        status: runStatus === 'passed' ? 'created-passed' : 'created-failed',
        exitCode: runStatus === 'passed' ? 0 : 1,
        sourceStableThroughRun, inputsStableBeforeReport, inputsStableBeforeManifest, report_sha256: reportSha256,
      };
    } catch (error) {
      return {
        ...currentBase, status: writeStage === 'none' ? 'refused' : 'incomplete', exitCode: writeStage === 'none' ? 2 : 3,
        sourceStableThroughRun, inputsStableBeforeReport, inputsStableBeforeManifest, report_sha256: reportSha256,
        ...(writeStage === 'none' ? {} : { cleanup: { automatic: false as const, pathsThatMayExist: writeStage === 'report' ? [paths.reportPath] : [paths.reportPath, paths.reportManifestPath] } }),
        refusal: { code: writeStage === 'none' ? 'write-refused' : 'write-failed', message: error instanceof Error ? error.message : String(error) },
      };
    }
  } catch (error) {
    return { ...base(paths), refusal: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } };
  }
}
