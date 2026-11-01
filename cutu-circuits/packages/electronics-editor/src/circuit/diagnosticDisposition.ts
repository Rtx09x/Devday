import type { ElectronicsEditorAPI } from '../editorApi.ts';
import {
  canonicalJson,
  circuitJsonFingerprint,
  sha256Text,
  writeTrackedExport,
  type TextFileSystem,
} from './artifactFreshness.ts';
import { inspectEvaluatorDiagnostics, type EvaluatorDiagnostic } from './evaluatorDiagnostics.ts';

export const DIAGNOSTIC_DISPOSITION_SCHEMA = 'cutucircuits-electronics/diagnostic-disposition@1' as const;
export const DIAGNOSTIC_DISPOSITION_GENERATOR = 'electronics-diagnostic-disposition@1' as const;
export const DIAGNOSTIC_DISPOSITION_SCHEMA_PATH = 'schemas/electronics.diagnostic-disposition.schema.v1.json';
export const MAX_DIAGNOSTIC_DISPOSITION_REASON_BYTES = 2_000;
export const MAX_DIAGNOSTIC_DISPOSITION_BYTES = 32 * 1024;

export type DiagnosticDispositionKind = 'accepted-risk' | 'deferred' | 'documented-intent' | 'suspected-false-positive';

export interface DiagnosticDispositionArtifact {
  schema: typeof DIAGNOSTIC_DISPOSITION_SCHEMA;
  generator: typeof DIAGNOSTIC_DISPOSITION_GENERATOR;
  schemaPath: typeof DIAGNOSTIC_DISPOSITION_SCHEMA_PATH;
  design: {
    sourceSha256: string;
    circuitJsonSha256: string;
    sourceOrigin: 'editor-buffer';
    persistenceState: 'unknown';
  };
  diagnostic: EvaluatorDiagnostic;
  disposition: { kind: DiagnosticDispositionKind; reason: string };
  scope: {
    proves: 'reviewer-authored-disposition-for-one-exact-snapshot-diagnostic';
    doesNotProve: string[];
  };
}

export interface CreateDiagnosticDispositionResult {
  status: 'created' | 'refused' | 'incomplete';
  output_path: string;
  manifest_path: string;
  sourceStableBeforeWrite: boolean;
  sourceStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  artifact_sha256?: string;
  diagnostic?: EvaluatorDiagnostic;
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

const DOES_NOT_PROVE = [
  'that the diagnostic is fixed, ignored by the evaluator, or safe to ignore',
  'electrical correctness, ERC, DRC, DFM, clearance, routing, or fabrication readiness',
  'fabricator or manufacturing acceptance, physical hardware behavior, or offline validation',
  'manifest authenticity or resistance to coordinated artifact and manifest edits',
  'atomic no-clobber, symlink confinement, rollback, or freshness after return',
];

const encoder = new TextEncoder();

function validatePath(value: unknown, label: string, suffix: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error(`${label} must be an explicit canonical workspace-relative path.`);
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error(`${label} must be lexical workspace-relative with forward slashes.`);
  if (value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${label} must not contain empty, dot, or dot-dot segments.`);
  if (!value.endsWith(suffix)) throw new Error(`${label} must end with ${suffix}.`);
  if (encoder.encode(value).byteLength > 1_024) throw new Error(`${label} must be at most 1024 UTF-8 bytes.`);
  return value;
}

function exactText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} must be a non-empty, trimmed, control-free string.`);
  }
  if (encoder.encode(value).byteLength > maxBytes) throw new Error(`${label} must be at most ${maxBytes} UTF-8 bytes.`);
  return value;
}

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string { return path.slice(0, path.lastIndexOf('/')); }

function base(outputPath: string, manifestPath: string): CreateDiagnosticDispositionResult {
  return {
    status: 'refused', output_path: outputPath, manifest_path: manifestPath,
    sourceStableBeforeWrite: false, sourceStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed', nonAtomicNoClobber: true, symlinkConfinement: 'unproven',
  };
}

export async function createDiagnosticDisposition(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot'>;
  fs: Pick<TextFileSystem, 'writeFile' | 'fileExists'>;
  workspacePath: string;
  diagnosticId: unknown;
  disposition: unknown;
  reason: unknown;
  outputPath: unknown;
  manifestPath: unknown;
}): Promise<CreateDiagnosticDispositionResult> {
  let outputRelative = typeof input.outputPath === 'string' ? input.outputPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  try {
    if (!input.workspacePath) throw new Error('A workspace must be open before creating a diagnostic disposition.');
    outputRelative = validatePath(input.outputPath, 'output_path', '.electronics.diagnostic-disposition.json');
    manifestRelative = validatePath(input.manifestPath, 'manifest_path', '.freshness.json');
    if (outputRelative === manifestRelative) throw new Error('Diagnostic disposition and manifest paths must be distinct.');
    const diagnosticId = exactText(input.diagnosticId, 'diagnostic_id', 512);
    if (!['accepted-risk', 'deferred', 'documented-intent', 'suspected-false-positive'].includes(String(input.disposition))) {
      throw new Error('disposition must be exactly accepted-risk, deferred, documented-intent, or suspected-false-positive.');
    }
    const disposition = input.disposition as DiagnosticDispositionKind;
    const reason = exactText(input.reason, 'reason', MAX_DIAGNOSTIC_DISPOSITION_REASON_BYTES);
    const outputAbsolute = joinWorkspace(input.workspacePath, outputRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const initial = base(outputRelative, manifestRelative);

    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return { ...initial, refusal: { code: 'snapshot-failed', message: `The copied editor source failed evaluation: ${snapshot.evalError}` } };
    if (input.api.getCode() !== snapshot.source) return { ...initial, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed after the diagnostic snapshot.' } };
    const report = inspectEvaluatorDiagnostics(snapshot.circuitJson);
    const matches = report.diagnostics.filter((diagnostic) => diagnostic.id === diagnosticId);
    if (matches.length !== 1) {
      return { ...initial, refusal: { code: matches.length ? 'diagnostic-ambiguous' : 'diagnostic-missing', message: matches.length ? 'The requested diagnostic ID is ambiguous in the bounded exact report.' : `Diagnostic ${diagnosticId} is not present in the bounded exact snapshot; ${report.summary.omitted} diagnostic(s) were omitted.` } };
    }
    const diagnostic = matches[0];
    const artifact: DiagnosticDispositionArtifact = {
      schema: DIAGNOSTIC_DISPOSITION_SCHEMA,
      generator: DIAGNOSTIC_DISPOSITION_GENERATOR,
      schemaPath: DIAGNOSTIC_DISPOSITION_SCHEMA_PATH,
      design: {
        sourceSha256: await sha256Text(snapshot.source),
        circuitJsonSha256: await circuitJsonFingerprint(snapshot.circuitJson),
        sourceOrigin: snapshot.sourceOrigin,
        persistenceState: snapshot.persistenceState,
      },
      diagnostic,
      disposition: { kind: disposition, reason },
      scope: { proves: 'reviewer-authored-disposition-for-one-exact-snapshot-diagnostic', doesNotProve: DOES_NOT_PROVE },
    };
    const artifactText = `${JSON.stringify(JSON.parse(canonicalJson(artifact)), null, 2)}\n`;
    if (encoder.encode(artifactText).byteLength > MAX_DIAGNOSTIC_DISPOSITION_BYTES) {
      return { ...initial, diagnostic, refusal: { code: 'artifact-too-large', message: `The disposition exceeds ${MAX_DIAGNOSTIC_DISPOSITION_BYTES} UTF-8 bytes.` } };
    }
    const artifactSha256 = await sha256Text(artifactText);
    for (const parent of new Set([parentPath(outputAbsolute), parentPath(manifestAbsolute)])) {
      if (!(await input.fs.fileExists(parent))) return { ...initial, diagnostic, artifact_sha256: artifactSha256, refusal: { code: 'parent-missing-or-unevidenced', message: `Destination parent does not exist as far as fileExists can evidence: ${parent}` } };
    }
    if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) {
      return { ...initial, diagnostic, artifact_sha256: artifactSha256, refusal: { code: 'path-exists', message: 'The disposition or manifest already exists; overwrite-anyway is never offered.' } };
    }

    let stage: 'none' | 'artifact' | 'manifest' = 'none';
    let sourceStableBeforeWrite = false;
    let sourceStableBeforeManifest = false;
    const guardedFs = {
      writeFile: async (path: string, text: string) => {
        if (path === outputAbsolute) {
          if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) throw new Error('A destination appeared after the non-atomic preflight; no disposition was knowingly overwritten.');
          sourceStableBeforeWrite = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeWrite) throw new Error('The editor-buffer source changed immediately before disposition write.');
          stage = 'artifact';
        } else {
          if (await input.fs.fileExists(manifestAbsolute)) throw new Error('The manifest destination appeared after preflight; it was not knowingly overwritten.');
          sourceStableBeforeManifest = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeManifest) throw new Error('The editor-buffer source changed immediately before disposition manifest write.');
          stage = 'manifest';
        }
        await input.fs.writeFile(path, text);
      },
    };
    try {
      await writeTrackedExport({
        fs: guardedFs, manifestPath: manifestAbsolute, source: snapshot.source,
        circuitJson: snapshot.circuitJson, kind: 'diagnostic-disposition',
        options: { schemaVersion: 1, diagnosticId: diagnostic.id, idSource: diagnostic.idSource, disposition },
        artifacts: [{ path: outputAbsolute, text: artifactText }],
        assertSourceCurrent: () => { if (input.api.getCode() !== snapshot.source) throw new Error('The editor-buffer source changed during diagnostic-disposition emission.'); },
      });
      return { ...initial, status: 'created', diagnostic, artifact_sha256: artifactSha256, sourceStableBeforeWrite, sourceStableBeforeManifest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stage === 'none') return { ...initial, diagnostic, artifact_sha256: artifactSha256, sourceStableBeforeWrite, sourceStableBeforeManifest, refusal: { code: 'write-refused', message } };
      return {
        ...initial, status: 'incomplete', diagnostic, artifact_sha256: artifactSha256,
        sourceStableBeforeWrite, sourceStableBeforeManifest,
        cleanup: { automatic: false, pathsThatMayExist: stage === 'artifact' ? [outputRelative] : [outputRelative, manifestRelative] },
        refusal: { code: 'write-failed', message },
      };
    }
  } catch (error) {
    return { ...base(outputRelative, manifestRelative), refusal: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } };
  }
}
