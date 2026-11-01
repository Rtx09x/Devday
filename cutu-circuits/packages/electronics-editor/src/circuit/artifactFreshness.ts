import type { AnyCircuitElement } from './circuitJson';
import { canonicalSimulationProjection, SIMULATION_PROJECTION_SCHEMA } from './simulationProjection.ts';

export const ARTIFACT_FRESHNESS_SCHEMA = 'cutucircuits-electronics/export-freshness@1' as const;
export const EXPORTER_REVISION = 'electronics-exporters@1' as const;
export const CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA = 'canonical-circuit-json@1' as const;
export type CircuitFingerprintSchema = typeof CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA | typeof SIMULATION_PROJECTION_SCHEMA;

export type ExportKind = 'bom' | 'image' | 'netlist' | 'fab' | 'kicad' | 'enclosure' | 'design-review'
  | 'simulation-test' | 'simulation-report' | 'simulation-matrix' | 'simulation-matrix-report'
  | 'part-contribution-draft' | 'diagnostic-disposition';

export interface TextFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
}

export interface TrackedExportArtifact {
  path: string;
  text: string;
}

export interface ArtifactFreshnessManifest {
  schema: typeof ARTIFACT_FRESHNESS_SCHEMA;
  exporterRevision: string;
  export: {
    kind: ExportKind;
    options: unknown;
    sha256: string;
  };
  source: { sha256: string };
  circuitJson: { sha256: string; fingerprintSchema?: CircuitFingerprintSchema };
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  scope: {
    proves: 'freshness-and-provenance-of-emitted-text-files';
    doesNotProve: string[];
  };
}

export type ArtifactFreshnessState =
  | 'fresh'
  | 'design_changed'
  | 'artifacts_missing'
  | 'artifacts_modified'
  | 'exporter_revision_changed'
  | 'malformed_or_unsupported';

export interface ArtifactFreshnessResult {
  state: ArtifactFreshnessState;
  fresh: boolean;
  manifestPath: string;
  kind?: ExportKind;
  details: string[];
  artifacts?: { checked: number; missing: string[]; modified: string[] };
  readOnly: true;
  scope: 'freshness-and-provenance-of-emitted-text-files';
}

const DOES_NOT_PROVE = [
  'ERC or DRC',
  'DFM or fabrication acceptance',
  'manufacturing correctness',
  'manufacturing acceptance',
  'fabricator acceptance',
  'KiCad application validation',
  'physical validation',
  'offline validation',
  'manifest authenticity or resistance to coordinated manifest and artifact edits',
];

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = canonicalValue(record[key]);
    }
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function circuitJsonFingerprint(
  circuitJson: AnyCircuitElement[],
  schema: CircuitFingerprintSchema = CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA,
): Promise<string> {
  const projection = schema === SIMULATION_PROJECTION_SCHEMA
    ? canonicalSimulationProjection(circuitJson)
    : circuitJson;
  return sha256Text(canonicalJson(projection));
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function normalizedAbsoluteLike(path: string): string {
  const normalized = normalizeSlashes(path);
  const prefix = normalized.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`Path escapes its root: ${path}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `${prefix}${parts.join('/')}` || (prefix || '.');
}

function pathKey(path: string): string {
  const normalized = normalizedAbsoluteLike(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function manifestDir(path: string): string {
  const normalized = normalizedAbsoluteLike(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '.' : normalized.slice(0, index) || '/';
}

function artifactRelativePath(manifestPath: string, artifactPath: string): string {
  const dir = normalizedAbsoluteLike(manifestDir(manifestPath));
  const artifact = normalizedAbsoluteLike(artifactPath);
  if (dir === '.' && !artifact.startsWith('/') && !/^[A-Za-z]:\//.test(artifact)) {
    validateRelativeArtifactPath(artifact);
    return artifact;
  }
  const prefix = dir === '/' ? '/' : `${dir}/`;
  if (!artifact.startsWith(prefix) || artifact === dir) {
    throw new Error(`Artifact path must stay beneath the manifest directory: ${artifactPath}`);
  }
  const relative = artifact.slice(prefix.length);
  validateRelativeArtifactPath(relative);
  return relative;
}

function validateRelativeArtifactPath(path: string): void {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Unsupported artifact path: ${path}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Artifact path escapes or is not canonical: ${path}`);
  }
}

export function resolveManifestArtifactPath(manifestPath: string, relativePath: string): string {
  validateRelativeArtifactPath(relativePath);
  const resolved = normalizedAbsoluteLike(`${manifestDir(manifestPath)}/${relativePath}`);
  artifactRelativePath(manifestPath, resolved);
  return resolved;
}

export function manifestPathFor(outputDir: string, circuitBase: string, kind: ExportKind): string {
  return `${outputDir}/${circuitBase}-${kind}.freshness.json`;
}

export async function writeTrackedExport(input: {
  fs: Pick<TextFileSystem, 'writeFile'>;
  manifestPath: string;
  source: string;
  circuitJson: AnyCircuitElement[];
  kind: ExportKind;
  options: unknown;
  artifacts: TrackedExportArtifact[];
  circuitFingerprintSchema?: CircuitFingerprintSchema;
  assertSourceCurrent?: () => void;
}): Promise<{ files: string[]; manifestPath: string; manifest: ArtifactFreshnessManifest }> {
  if (!input.artifacts.length) throw new Error('Tracked export requires at least one emitted text artifact.');
  const manifestKey = pathKey(input.manifestPath);
  const seen = new Set<string>();
  const normalized = input.artifacts.map((artifact) => {
    const path = normalizedAbsoluteLike(artifact.path);
    const key = pathKey(path);
    if (key === manifestKey) throw new Error('An artifact cannot overwrite its freshness manifest.');
    if (seen.has(key)) throw new Error(`Duplicate artifact path: ${artifact.path}`);
    seen.add(key);
    return { ...artifact, path, relativePath: artifactRelativePath(input.manifestPath, path) };
  });
  const options = canonicalValue(input.options);
  const artifactRecords = await Promise.all(normalized.map(async (artifact) => ({
    path: artifact.relativePath,
    sha256: await sha256Text(artifact.text),
    bytes: new TextEncoder().encode(artifact.text).byteLength,
  })));
  artifactRecords.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: ArtifactFreshnessManifest = {
    schema: ARTIFACT_FRESHNESS_SCHEMA,
    exporterRevision: EXPORTER_REVISION,
    export: {
      kind: input.kind,
      options,
      sha256: await sha256Text(canonicalJson({
        kind: input.kind,
        options,
        exporterRevision: EXPORTER_REVISION,
      })),
    },
    source: { sha256: await sha256Text(input.source) },
    circuitJson: {
      sha256: await circuitJsonFingerprint(input.circuitJson, input.circuitFingerprintSchema),
      fingerprintSchema: input.circuitFingerprintSchema ?? CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA,
    },
    artifacts: artifactRecords,
    scope: {
      proves: 'freshness-and-provenance-of-emitted-text-files',
      doesNotProve: DOES_NOT_PROVE,
    },
  };
  input.assertSourceCurrent?.();
  for (const artifact of normalized) await input.fs.writeFile(artifact.path, artifact.text);
  input.assertSourceCurrent?.();
  await input.fs.writeFile(input.manifestPath, `${canonicalJson(manifest)}\n`);
  return { files: normalized.map((artifact) => artifact.path), manifestPath: input.manifestPath, manifest };
}

function malformed(manifestPath: string, detail: string): ArtifactFreshnessResult {
  return {
    state: 'malformed_or_unsupported', fresh: false, manifestPath,
    details: [detail], readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
  };
}

export function parseArtifactFreshnessManifest(text: string, manifestPath: string): ArtifactFreshnessManifest | ArtifactFreshnessResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return malformed(manifestPath, 'Manifest is not valid JSON.'); }
  if (!value || typeof value !== 'object') return malformed(manifestPath, 'Manifest root must be an object.');
  const item = value as Partial<ArtifactFreshnessManifest>;
  if (item.schema !== ARTIFACT_FRESHNESS_SCHEMA) return malformed(manifestPath, 'Manifest schema is unsupported.');
  if (typeof item.exporterRevision !== 'string' || !item.export || !item.source || !item.circuitJson || !Array.isArray(item.artifacts)) {
    return malformed(manifestPath, 'Manifest is missing required provenance fields.');
  }
  const kinds: ExportKind[] = [
    'bom', 'image', 'netlist', 'fab', 'kicad', 'enclosure', 'design-review',
    'simulation-test', 'simulation-report', 'simulation-matrix', 'simulation-matrix-report',
    'part-contribution-draft', 'diagnostic-disposition',
  ];
  if (!kinds.includes(item.export.kind as ExportKind)) return malformed(manifestPath, 'Manifest export kind is unsupported.');
  const hashes = [item.export.sha256, item.source.sha256, item.circuitJson.sha256];
  if (item.circuitJson.fingerprintSchema != null
    && item.circuitJson.fingerprintSchema !== CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA
    && item.circuitJson.fingerprintSchema !== SIMULATION_PROJECTION_SCHEMA) {
    return malformed(manifestPath, 'Manifest Circuit JSON fingerprint schema is unsupported.');
  }
  const seen = new Set<string>();
  try {
    for (const artifact of item.artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || !Number.isInteger(artifact.bytes) || artifact.bytes < 0) throw new Error('Manifest has an invalid artifact record.');
      validateRelativeArtifactPath(artifact.path);
      const key = pathKey(resolveManifestArtifactPath(manifestPath, artifact.path));
      if (seen.has(key)) throw new Error(`Manifest has duplicate artifact path: ${artifact.path}`);
      seen.add(key);
      hashes.push(artifact.sha256);
    }
  } catch (error) {
    return malformed(manifestPath, (error as Error).message);
  }
  if (!item.artifacts.length || hashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    return malformed(manifestPath, 'Manifest has missing artifacts or invalid SHA-256 fingerprints.');
  }
  return item as ArtifactFreshnessManifest;
}

export async function checkArtifactFreshness(input: {
  fs: Pick<TextFileSystem, 'readFile' | 'fileExists'>;
  manifestPath: string;
  getSource: () => string;
  evaluate: () => Promise<{ circuitJson: AnyCircuitElement[]; evalError?: string }>;
}): Promise<ArtifactFreshnessResult> {
  const startSource = input.getSource();
  if (!(await input.fs.fileExists(input.manifestPath))) return malformed(input.manifestPath, 'Manifest does not exist.');
  let manifestText: string;
  try { manifestText = await input.fs.readFile(input.manifestPath); }
  catch (error) { return malformed(input.manifestPath, `Manifest could not be read: ${(error as Error).message}`); }
  const parsed = parseArtifactFreshnessManifest(manifestText, input.manifestPath);
  if ('state' in parsed) return parsed;
  const exportFingerprint = await sha256Text(canonicalJson({
    kind: parsed.export.kind,
    options: canonicalValue(parsed.export.options),
    exporterRevision: parsed.exporterRevision,
  }));
  if (exportFingerprint !== parsed.export.sha256) {
    return malformed(input.manifestPath, 'Manifest export identity fingerprint does not match its kind, options, and exporter revision.');
  }
  const evaluation = await input.evaluate();
  const endSource = input.getSource();
  if (startSource !== endSource) {
    return {
      state: 'design_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: ['Live editor source changed while the freshness check was running; retry against a stable editor state.'],
      readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
    };
  }
  if (evaluation.evalError) return malformed(input.manifestPath, `Current editor source could not be evaluated: ${evaluation.evalError}`);
  if (parsed.exporterRevision !== EXPORTER_REVISION) {
    return {
      state: 'exporter_revision_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: [`Manifest exporter revision ${parsed.exporterRevision} differs from current revision ${EXPORTER_REVISION}. Re-export the artifacts.`],
      readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
    };
  }
  const [sourceHash, circuitHash] = await Promise.all([
    sha256Text(startSource), circuitJsonFingerprint(evaluation.circuitJson, parsed.circuitJson.fingerprintSchema),
  ]);
  if (input.getSource() !== startSource) {
    return {
      state: 'design_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: ['Live editor source changed while fingerprints were being computed; retry against a stable editor state.'],
      readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
    };
  }
  const designDetails: string[] = [];
  if (sourceHash !== parsed.source.sha256) designDetails.push('The exact live editor source differs from the exported source.');
  if (circuitHash !== parsed.circuitJson.sha256) designDetails.push(`The freshly evaluated Circuit JSON fingerprint (${parsed.circuitJson.fingerprintSchema ?? CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA}) differs from the export.`);
  if (designDetails.length) {
    return {
      state: 'design_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: designDetails, readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
    };
  }
  const missing: string[] = [];
  const modified: string[] = [];
  for (const artifact of parsed.artifacts) {
    const path = resolveManifestArtifactPath(input.manifestPath, artifact.path);
    if (!(await input.fs.fileExists(path))) { missing.push(path); continue; }
    try {
      const text = await input.fs.readFile(path);
      if (await sha256Text(text) !== artifact.sha256) modified.push(path);
    } catch { missing.push(path); }
  }
  if (input.getSource() !== startSource) {
    return {
      state: 'design_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: ['Live editor source changed while artifacts were being checked; retry against a stable editor state.'],
      readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
    };
  }
  const artifacts = { checked: parsed.artifacts.length, missing, modified };
  if (missing.length) return {
    state: 'artifacts_missing', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
    details: [`${missing.length} recorded text artifact(s) are missing or unreadable.`], artifacts,
    readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
  };
  if (modified.length) return {
    state: 'artifacts_modified', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
    details: [`${modified.length} recorded text artifact(s) have different SHA-256 fingerprints.`], artifacts,
    readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
  };
  return {
    state: 'fresh', fresh: true, manifestPath: input.manifestPath, kind: parsed.export.kind,
    details: [`Current live source, Circuit JSON fingerprint (${parsed.circuitJson.fingerprintSchema ?? CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA}), exporter revision, and every recorded text artifact match the manifest.`], artifacts,
    readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files',
  };
}

/** Compare one explicit manifest with an already-frozen source/Circuit JSON snapshot. */
export async function checkArtifactFreshnessSnapshot(input: {
  fs: Pick<TextFileSystem, 'readFile' | 'fileExists'>;
  manifestPath: string;
  source: string;
  circuitJson: AnyCircuitElement[];
}): Promise<ArtifactFreshnessResult & { recordedArtifactPaths?: string[] }> {
  if (!(await input.fs.fileExists(input.manifestPath))) {
    return malformed(input.manifestPath, 'Manifest does not exist.');
  }
  let manifestText: string;
  try { manifestText = await input.fs.readFile(input.manifestPath); }
  catch (error) { return malformed(input.manifestPath, `Manifest could not be read: ${(error as Error).message}`); }
  const parsed = parseArtifactFreshnessManifest(manifestText, input.manifestPath);
  if ('state' in parsed) return parsed;
  const recordedArtifactPaths = parsed.artifacts
    .map((artifact) => resolveManifestArtifactPath(input.manifestPath, artifact.path))
    .sort((a, b) => a.localeCompare(b));
  const exportFingerprint = await sha256Text(canonicalJson({
    kind: parsed.export.kind,
    options: canonicalValue(parsed.export.options),
    exporterRevision: parsed.exporterRevision,
  }));
  if (exportFingerprint !== parsed.export.sha256) {
    return { ...malformed(input.manifestPath, 'Manifest export identity fingerprint does not match its kind, options, and exporter revision.'), recordedArtifactPaths };
  }
  if (parsed.exporterRevision !== EXPORTER_REVISION) {
    return {
      state: 'exporter_revision_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: [`Manifest exporter revision ${parsed.exporterRevision} differs from current revision ${EXPORTER_REVISION}. Re-export the artifacts.`],
      readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files', recordedArtifactPaths,
    };
  }
  const [sourceHash, circuitHash] = await Promise.all([
    sha256Text(input.source), circuitJsonFingerprint(input.circuitJson, parsed.circuitJson.fingerprintSchema),
  ]);
  const designDetails: string[] = [];
  if (sourceHash !== parsed.source.sha256) designDetails.push('The exact frozen editor-buffer source differs from the exported source.');
  if (circuitHash !== parsed.circuitJson.sha256) designDetails.push(`The frozen Circuit JSON fingerprint (${parsed.circuitJson.fingerprintSchema ?? CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA}) differs from the export.`);
  if (designDetails.length) {
    return {
      state: 'design_changed', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
      details: designDetails, readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files', recordedArtifactPaths,
    };
  }
  const missing: string[] = [];
  const modified: string[] = [];
  for (const path of recordedArtifactPaths) {
    if (!(await input.fs.fileExists(path))) { missing.push(path); continue; }
    const record = parsed.artifacts.find((artifact) => resolveManifestArtifactPath(input.manifestPath, artifact.path) === path);
    try {
      const text = await input.fs.readFile(path);
      if (!record || await sha256Text(text) !== record.sha256) modified.push(path);
    } catch { missing.push(path); }
  }
  const artifacts = { checked: parsed.artifacts.length, missing, modified };
  if (missing.length) return {
    state: 'artifacts_missing', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
    details: [`${missing.length} recorded text artifact(s) are missing or unreadable.`], artifacts,
    readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files', recordedArtifactPaths,
  };
  if (modified.length) return {
    state: 'artifacts_modified', fresh: false, manifestPath: input.manifestPath, kind: parsed.export.kind,
    details: [`${modified.length} recorded text artifact(s) have different SHA-256 fingerprints.`], artifacts,
    readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files', recordedArtifactPaths,
  };
  return {
    state: 'fresh', fresh: true, manifestPath: input.manifestPath, kind: parsed.export.kind,
    details: [`Frozen editor-buffer source, Circuit JSON fingerprint (${parsed.circuitJson.fingerprintSchema ?? CANONICAL_CIRCUIT_FINGERPRINT_SCHEMA}), exporter revision, and every recorded text artifact matched during generation.`], artifacts,
    readOnly: true, scope: 'freshness-and-provenance-of-emitted-text-files', recordedArtifactPaths,
  };
}
