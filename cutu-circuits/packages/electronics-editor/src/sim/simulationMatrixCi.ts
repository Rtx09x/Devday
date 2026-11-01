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
import { SIMULATION_PROJECTION_SCHEMA } from '../circuit/simulationProjection.ts';
import { parseSimulationMatrixArtifact } from './simulationMatrixArtifact.ts';
import { runFirmwareTest, type AssertionResult } from './testHarness.ts';
import type { FirmwareFixtureId } from './types.ts';
import type { NormalizedFixtureStimulus } from './fixtureStimulus.ts';

export const SIMULATION_MATRIX_REPORT_SCHEMA = 'cutucircuits-electronics/simulation-matrix-report@1' as const;
export const SIMULATION_MATRIX_REPORT_GENERATOR = 'electronics-simulation-matrix-report@1' as const;

export interface SimulationMatrixCiCaseReport {
  id: string;
  name: string;
  status: 'passed' | 'failed';
  stimulus: NormalizedFixtureStimulus;
  simulatedMs?: number;
  simError?: string;
  assertions: { passed: number; failed: number; results: AssertionResult[] };
}

export interface SimulationMatrixCiReport {
  schema: typeof SIMULATION_MATRIX_REPORT_SCHEMA;
  generator: typeof SIMULATION_MATRIX_REPORT_GENERATOR;
  status: 'passed' | 'failed';
  matrix: { path: string; manifestPath: string; sha256: string; manifestSha256: string; name: string };
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
    caseIsolation: 'fresh-emulator-per-case';
  };
  aggregate: {
    cases: { total: number; passed: number; failed: number };
    assertions: { total: number; passed: number; failed: number };
  };
  cases: SimulationMatrixCiCaseReport[];
  scope: {
    proves: 'repeatable-headless-emulator-case-assertions-for-pinned-inputs';
    doesNotProve: string[];
  };
}

export interface SimulationMatrixCiResult {
  status: 'created-passed' | 'created-failed' | 'refused' | 'incomplete';
  exitCode: 0 | 1 | 2 | 3;
  circuit_path: string;
  matrix_path: string;
  matrix_manifest_path: string;
  report_path: string;
  report_manifest_path: string;
  sourceStableThroughRun: boolean;
  inputsStableBeforeReport: boolean;
  inputsStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  report_sha256?: string;
  summary?: {
    name: string;
    engine: 'rp2040js' | 'avr8js';
    fixture: FirmwareFixtureId;
    cases: { total: number; passed: number; failed: number };
    assertions: { total: number; passed: number; failed: number };
    caseResults: Array<{ id: string; status: 'passed' | 'failed'; passed: number; failed: number }>;
  };
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

const DOES_NOT_PROVE = [
  'physical-board or attached-peripheral behavior',
  'UART voltage, wire waveform, calibrated baud, framing, noise, buffering, cable, USB serial, host, or external-device behavior',
  'hardware timing fidelity',
  'PCB copper continuity or routing correctness',
  'ERC, DRC, DFM, fabrication, or manufacturing correctness',
  'KiCad application validation',
  'offline validation',
  'automatic CI integration or baseline updates',
  'manifest authenticity or resistance to coordinated edits',
];

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function base(input: {
  circuitPath: string;
  matrixPath: string;
  matrixManifestPath: string;
  reportPath: string;
  reportManifestPath: string;
}): SimulationMatrixCiResult {
  return {
    status: 'refused', exitCode: 2,
    circuit_path: input.circuitPath, matrix_path: input.matrixPath,
    matrix_manifest_path: input.matrixManifestPath,
    report_path: input.reportPath, report_manifest_path: input.reportManifestPath,
    sourceStableThroughRun: false, inputsStableBeforeReport: false, inputsStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed', nonAtomicNoClobber: true, symlinkConfinement: 'unproven',
  };
}

export async function runSimulationMatrixCi(input: {
  fs: TextFileSystem;
  workspacePath: string;
  circuitPath: unknown;
  matrixPath: unknown;
  matrixManifestPath: unknown;
  reportPath: unknown;
  reportManifestPath: unknown;
  evaluate: (source: string) => Promise<{ ok: boolean; circuitJson: AnyCircuitElement[]; error?: string }>;
}): Promise<SimulationMatrixCiResult> {
  let paths = {
    circuitPath: typeof input.circuitPath === 'string' ? input.circuitPath : '',
    matrixPath: typeof input.matrixPath === 'string' ? input.matrixPath : '',
    matrixManifestPath: typeof input.matrixManifestPath === 'string' ? input.matrixManifestPath : '',
    reportPath: typeof input.reportPath === 'string' ? input.reportPath : '',
    reportManifestPath: typeof input.reportManifestPath === 'string' ? input.reportManifestPath : '',
  };
  try {
    if (!input.workspacePath) throw new Error('workspacePath must be an explicit non-empty path.');
    paths = {
      circuitPath: validateCanonicalWorkspaceRelativePath(input.circuitPath, 'circuit_path', '.circuit.tsx'),
      matrixPath: validateCanonicalWorkspaceRelativePath(input.matrixPath, 'matrix_path', '.electronics.simulation-matrix.json'),
      matrixManifestPath: validateCanonicalWorkspaceRelativePath(input.matrixManifestPath, 'matrix_manifest_path', '.freshness.json'),
      reportPath: validateCanonicalWorkspaceRelativePath(input.reportPath, 'report_path', '.electronics.simulation-matrix-report.json'),
      reportManifestPath: validateCanonicalWorkspaceRelativePath(input.reportManifestPath, 'report_manifest_path', '.freshness.json'),
    };
    if (new Set(Object.values(paths)).size !== 5) throw new Error('Circuit, matrix, input manifest, report, and report manifest paths must be distinct.');
    const absolute = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, joinWorkspace(input.workspacePath, value)])) as Record<keyof typeof paths, string>;
    const currentBase = base(paths);
    for (const key of ['circuitPath', 'matrixPath', 'matrixManifestPath'] as const) {
      if (!(await input.fs.fileExists(absolute[key]))) return { ...currentBase, refusal: { code: 'input-missing', message: `Required explicit input does not exist: ${paths[key]}` } };
    }
    for (const parent of new Set([parentPath(absolute.reportPath), parentPath(absolute.reportManifestPath)])) {
      if (!(await input.fs.fileExists(parent))) return { ...currentBase, refusal: { code: 'parent-missing-or-unevidenced', message: `A report destination parent must already exist as far as fileExists can evidence: ${parent}` } };
    }
    if (await input.fs.fileExists(absolute.reportPath) || await input.fs.fileExists(absolute.reportManifestPath)) {
      return { ...currentBase, refusal: { code: 'path-exists', message: 'The report or completed-manifest destination already exists; overwrite-anyway is never offered.' } };
    }
    const [source, matrixText, matrixManifestText] = await Promise.all([
      input.fs.readFile(absolute.circuitPath), input.fs.readFile(absolute.matrixPath), input.fs.readFile(absolute.matrixManifestPath),
    ]);
    const artifact = parseSimulationMatrixArtifact(matrixText);
    const evaluation = await input.evaluate(source);
    if (!evaluation.ok) return { ...currentBase, refusal: { code: 'evaluation-failed', message: evaluation.error ?? 'The explicit circuit source failed headless evaluation.' } };
    const unchanged = async () => (
      await input.fs.readFile(absolute.circuitPath) === source
      && await input.fs.readFile(absolute.matrixPath) === matrixText
      && await input.fs.readFile(absolute.matrixManifestPath) === matrixManifestText
    );
    if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-before-run', message: 'A circuit, matrix, or matrix-manifest input changed during evaluation; no simulation or output write was attempted.' } };
    const manifest = parseArtifactFreshnessManifest(matrixManifestText, absolute.matrixManifestPath);
    if ('state' in manifest) return { ...currentBase, refusal: { code: 'manifest-malformed', message: manifest.details.join(' ') } };
    const [sourceSha256, circuitJsonSha256, projectionSha256, matrixSha256, matrixManifestSha256] = await Promise.all([
      sha256Text(source), sha256Text(canonicalJson(evaluation.circuitJson)),
      circuitJsonFingerprint(evaluation.circuitJson, SIMULATION_PROJECTION_SCHEMA),
      sha256Text(matrixText), sha256Text(matrixManifestText),
    ]);
    const exportFingerprint = await sha256Text(canonicalJson({
      kind: manifest.export.kind, options: manifest.export.options, exporterRevision: manifest.exporterRevision,
    }));
    const manifestArtifactPath = manifest.artifacts.length === 1
      ? resolveManifestArtifactPath(absolute.matrixManifestPath, manifest.artifacts[0].path)
      : undefined;
    const manifestMatches = manifest.exporterRevision === EXPORTER_REVISION
      && manifest.export.kind === 'simulation-matrix'
      && manifest.export.sha256 === exportFingerprint
      && manifest.source.sha256 === sourceSha256
      && manifest.circuitJson.fingerprintSchema === SIMULATION_PROJECTION_SCHEMA
      && manifest.circuitJson.sha256 === artifact.design.simulationProjectionSha256
      && manifestArtifactPath === absolute.matrixPath
      && manifest.artifacts[0]?.sha256 === matrixSha256
      && manifest.artifacts[0]?.bytes === new TextEncoder().encode(matrixText).byteLength;
    if (!manifestMatches) return { ...currentBase, refusal: { code: 'manifest-provenance-mismatch', message: 'The input manifest does not exactly bind this source, simulation matrix, pinned editor projection, exporter revision, and export options.' } };
    if (artifact.design.sourceSha256 !== sourceSha256
      || artifact.design.simulationProjectionSchema !== SIMULATION_PROJECTION_SCHEMA
      || artifact.design.simulationProjectionSha256 !== projectionSha256) {
      return { ...currentBase, refusal: { code: 'design-projection-mismatch', message: 'The exact source or normalized graph-preserving simulation projection differs from the pinned matrix.' } };
    }
    if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-before-run', message: 'An explicit input changed immediately before the first case.' } };
    const expectedEngine = artifact.simulation.mcu === 'avr' ? 'avr8js' as const : 'rp2040js' as const;
    const caseReports: SimulationMatrixCiCaseReport[] = [];
    for (const matrixCase of artifact.cases) {
      if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-during-run', message: `An explicit input changed before case ${matrixCase.id}; no report was emitted.` } };
      const runReport = await runFirmwareTest(
        { circuitJson: evaluation.circuitJson, code: source },
        {
          mode: 'mcu', mcu: artifact.simulation.mcu, fixture: artifact.simulation.fixture,
          durationMs: artifact.simulation.durationMs, stimulus: matrixCase.stimulus,
        },
        matrixCase.assertions,
      );
      if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-during-run', message: `An explicit input changed during or after case ${matrixCase.id}; no report was emitted.` } };
      if (runReport.engine !== expectedEngine
        || runReport.firmwareFixture?.id !== artifact.simulation.fixture
        || runReport.firmwareFixture.sha256 !== artifact.simulation.fixtureSha256
        || runReport.firmwareFixture.sourcePath !== artifact.simulation.fixtureSourcePath
        || canonicalJson(runReport.modeledStimulus ?? {}) !== canonicalJson(matrixCase.stimulus)) {
        return { ...currentBase, sourceStableThroughRun: true, refusal: { code: 'runtime-provenance-mismatch', message: `Case ${matrixCase.id} did not report the exact pinned engine, fixture, and normalized stimulus provenance.` } };
      }
      caseReports.push({
        id: matrixCase.id, name: matrixCase.name, status: runReport.pass ? 'passed' : 'failed',
        stimulus: matrixCase.stimulus,
        ...(runReport.simulatedMs == null ? {} : { simulatedMs: runReport.simulatedMs }),
        ...(runReport.simError ? { simError: runReport.simError } : {}),
        assertions: { passed: runReport.passed, failed: runReport.failed, results: runReport.results },
      });
    }
    if (!(await unchanged())) return { ...currentBase, refusal: { code: 'inputs-changed-after-run', message: 'An explicit input changed after the final case; no report was emitted.' } };
    const passedCases = caseReports.filter((entry) => entry.status === 'passed').length;
    const passedAssertions = caseReports.reduce((sum, entry) => sum + entry.assertions.passed, 0);
    const failedAssertions = caseReports.reduce((sum, entry) => sum + entry.assertions.failed, 0);
    const runStatus = passedCases === caseReports.length ? 'passed' as const : 'failed' as const;
    const report: SimulationMatrixCiReport = {
      schema: SIMULATION_MATRIX_REPORT_SCHEMA,
      generator: SIMULATION_MATRIX_REPORT_GENERATOR,
      status: runStatus,
      matrix: {
        path: paths.matrixPath, manifestPath: paths.matrixManifestPath,
        sha256: matrixSha256, manifestSha256: matrixManifestSha256, name: artifact.name,
      },
      circuit: {
        path: paths.circuitPath, sourceSha256,
        pinnedEditorCircuitJsonSha256: artifact.design.circuitJsonSha256,
        headlessCircuitJsonSha256: circuitJsonSha256,
        simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA,
        simulationProjectionSha256: projectionSha256,
      },
      simulation: {
        engine: expectedEngine, fixture: artifact.simulation.fixture,
        fixtureSha256: artifact.simulation.fixtureSha256,
        fixtureSourcePath: artifact.simulation.fixtureSourcePath,
        durationMs: artifact.simulation.durationMs,
        caseIsolation: 'fresh-emulator-per-case',
      },
      aggregate: {
        cases: { total: caseReports.length, passed: passedCases, failed: caseReports.length - passedCases },
        assertions: { total: passedAssertions + failedAssertions, passed: passedAssertions, failed: failedAssertions },
      },
      cases: caseReports,
      scope: { proves: 'repeatable-headless-emulator-case-assertions-for-pinned-inputs', doesNotProve: DOES_NOT_PROVE },
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
        kind: 'simulation-matrix-report',
        options: {
          schema: SIMULATION_MATRIX_REPORT_SCHEMA, generator: SIMULATION_MATRIX_REPORT_GENERATOR,
          matrixSha256, matrixManifestSha256, fixtureSha256: artifact.simulation.fixtureSha256,
        },
        circuitFingerprintSchema: SIMULATION_PROJECTION_SCHEMA,
        artifacts: [{ path: absolute.reportPath, text: reportText }],
      });
      return {
        ...currentBase,
        status: runStatus === 'passed' ? 'created-passed' : 'created-failed',
        exitCode: runStatus === 'passed' ? 0 : 1,
        sourceStableThroughRun: true, inputsStableBeforeReport, inputsStableBeforeManifest,
        report_sha256: reportSha256,
        summary: {
          name: artifact.name,
          engine: expectedEngine,
          fixture: artifact.simulation.fixture,
          cases: report.aggregate.cases,
          assertions: report.aggregate.assertions,
          caseResults: caseReports.map((entry) => ({
            id: entry.id,
            status: entry.status,
            passed: entry.assertions.passed,
            failed: entry.assertions.failed,
          })),
        },
      };
    } catch (error) {
      return {
        ...currentBase,
        status: writeStage === 'none' ? 'refused' : 'incomplete', exitCode: writeStage === 'none' ? 2 : 3,
        sourceStableThroughRun: true, inputsStableBeforeReport, inputsStableBeforeManifest,
        report_sha256: reportSha256,
        ...(writeStage === 'none' ? {} : {
          cleanup: { automatic: false as const, pathsThatMayExist: writeStage === 'report' ? [paths.reportPath] : [paths.reportPath, paths.reportManifestPath] },
        }),
        refusal: { code: writeStage === 'none' ? 'write-refused' : 'write-failed', message: error instanceof Error ? error.message : String(error) },
      };
    }
  } catch (error) {
    return { ...base(paths), refusal: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } };
  }
}
