import { listComponents, type AnyCircuitElement } from './circuitJson.ts';
import {
  DEFAULT_PART_EVIDENCE_PATH,
  PART_EVIDENCE_SCHEMA_VERSION,
  checkPartEvidenceSources,
  parsePartEvidenceFile,
  resolvePartEvidenceFilePath,
  type LocalPartEvidenceRecord,
  type PartEvidenceFile,
} from './partEvidence.ts';
import {
  canonicalJson,
  EXPORTER_REVISION,
  parseArtifactFreshnessManifest,
  resolveManifestArtifactPath,
  sha256Text,
  writeTrackedExport,
  type TextFileSystem,
} from './artifactFreshness.ts';
import type { ElectronicsEditorAPI } from '../editorApi.ts';

export const MAX_PART_EVIDENCE_CANDIDATE_SOURCES = 8;
export const MAX_PART_EVIDENCE_CANDIDATE_TEXT_BYTES = 512;
export const PART_EVIDENCE_SCHEMA_PATH = 'schemas/electronics.parts.schema.v1.json';
export const PART_CONTRIBUTION_DRAFT_SCHEMA = 'cutucircuits-electronics/part-contribution-draft@1' as const;
export const PART_CONTRIBUTION_DRAFT_GENERATOR = 'electronics-part-contribution-draft@1' as const;
export const PART_CONTRIBUTION_DRAFT_SCHEMA_PATH = 'schemas/electronics.part-contribution-draft.schema.v1.json';
export const MAX_PART_CONTRIBUTION_DRAFT_BYTES = 16 * 1024;
export const MAX_PART_CONTRIBUTION_PATH_BYTES = 1024;

export interface PartEvidenceCandidateRequest {
  sourceComponentId: string;
  ref: string;
  manufacturer?: string;
  notes?: string;
  evidence: Array<{ source: string; notes?: string }>;
}

export interface PartEvidenceCandidateGrant {
  baseline: string;
  sourceComponentId: string;
  ref: string;
  mpn: string;
  footprint: string;
}

export interface PartEvidenceCandidateResult {
  schemaVersion: 1;
  schemaPath: string;
  parserAuthority: string;
  selected: { sourceComponentId: string; ref: string; mpn: string; footprint: string };
  target: { requestedPath: string; resolvedPath: string; state: 'loaded' | 'missing' };
  collision: 'new' | 'exact-duplicate' | 'conflict';
  pathPresence: { total: number; present: number; missing: number; sources: Array<{ source: string; state: 'present' | 'missing'; notes?: string }> };
  checks: { parserCompatible: true; selectedMetadataMatches: true; allPathsPresent: boolean };
  omissions: { sourceCount: 0; fields: [] };
  canonicalRecordJson: string;
  limitations: string[];
}

export interface CreatePartEvidenceDraftResult {
  status: 'created' | 'refused' | 'incomplete';
  output_path: string;
  manifest_path: string;
  sourceStableBeforeWrite: boolean;
  sourceStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  draft_sha256?: string;
  candidate?: PartEvidenceCandidateResult;
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

export interface PartEvidenceContributionDraft {
  schema: typeof PART_CONTRIBUTION_DRAFT_SCHEMA;
  generator: typeof PART_CONTRIBUTION_DRAFT_GENERATOR;
  selected: PartEvidenceCandidateResult['selected'];
  candidate: {
    partRecordSchemaVersion: 1;
    record: LocalPartEvidenceRecord;
  };
  localObservations: {
    collisionTarget: {
      path: typeof DEFAULT_PART_EVIDENCE_PATH;
      state: PartEvidenceCandidateResult['target']['state'];
      collision: PartEvidenceCandidateResult['collision'];
    };
    evidencePathPresence: PartEvidenceCandidateResult['pathPresence']['sources'];
  };
  scope: {
    proves: 'canonical-local-part-record-draft-and-path-presence-observation';
    doesNotProve: string[];
  };
}

export interface PartEvidenceContributionReviewResult {
  state: 'consistent_current_observations' | 'local_observations_changed' | 'artifact_missing'
    | 'artifact_modified' | 'exporter_revision_changed' | 'malformed_or_unsupported';
  draft_path: string;
  manifest_path: string;
  draft?: PartEvidenceContributionDraft;
  checks?: {
    manifestKind: boolean;
    manifestRecordsExactDraft: boolean;
    manifestOptionsMatchDraft: boolean;
    selectedMatchesCandidate: boolean;
    evidenceObservationsMatchCandidate: boolean;
    scopeMatchesGenerator: boolean;
    artifactBytesMatch: boolean;
    artifactSha256Matches: boolean;
    collisionObservationCurrent: boolean;
    pathPresenceObservationCurrent: boolean;
    allEvidencePathsPresent: boolean;
  };
  current?: {
    collision: PartEvidenceCandidateResult['collision'];
    pathPresence: PartEvidenceCandidateResult['pathPresence'];
  };
  details: string[];
  readOnly: true;
  limitations: string[];
}

const CONTRIBUTION_DOES_NOT_PROVE = [
  'referenced evidence content, digest, authenticity, licensing, or regular-file type',
  'electrical correctness, pin mapping, footprint correctness, or supplier availability',
  'orderability, manufacturability, security, publication, acceptance, or community review',
  'atomic no-clobber, symlink confinement, or freshness after the manifest is written',
];

function validateDraftPath(path: unknown, label: string, suffix: string): string {
  if (typeof path !== 'string' || !path || path.trim() !== path) {
    throw new Error(`${label} must be an explicit non-empty canonical workspace-relative path.`);
  }
  if (path.includes('\\')) throw new Error(`${label} must use forward slashes; backslashes are rejected.`);
  if (path.includes('\0')) throw new Error(`${label} must not contain NUL.`);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`${label} must be workspace-relative, not absolute.`);
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must not contain empty, dot, or dot-dot segments.`);
  }
  if (!path.endsWith(suffix)) throw new Error(`${label} must end with ${suffix}.`);
  const value = path;
  if (new TextEncoder().encode(value).byteLength > MAX_PART_CONTRIBUTION_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_PART_CONTRIBUTION_PATH_BYTES} UTF-8 bytes.`);
  }
  return value;
}

export function buildPartEvidenceContributionDraft(candidate: PartEvidenceCandidateResult): PartEvidenceContributionDraft {
  return {
    schema: PART_CONTRIBUTION_DRAFT_SCHEMA,
    generator: PART_CONTRIBUTION_DRAFT_GENERATOR,
    selected: candidate.selected,
    candidate: {
      partRecordSchemaVersion: PART_EVIDENCE_SCHEMA_VERSION,
      record: JSON.parse(candidate.canonicalRecordJson) as LocalPartEvidenceRecord,
    },
    localObservations: {
      collisionTarget: {
        path: DEFAULT_PART_EVIDENCE_PATH,
        state: candidate.target.state,
        collision: candidate.collision,
      },
      evidencePathPresence: candidate.pathPresence.sources,
    },
    scope: {
      proves: 'canonical-local-part-record-draft-and-path-presence-observation',
      doesNotProve: CONTRIBUTION_DOES_NOT_PROVE,
    },
  };
}

export function parsePartEvidenceContributionDraft(text: string): PartEvidenceContributionDraft {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Part contribution draft must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Part contribution draft root must be an object.');
  const item = value as Record<string, unknown>;
  const expectedKeys = ['candidate', 'generator', 'localObservations', 'schema', 'scope', 'selected'];
  if (Object.keys(item).sort().join('|') !== expectedKeys.join('|')) throw new Error('Part contribution draft contains missing or unknown top-level fields.');
  if (item.schema !== PART_CONTRIBUTION_DRAFT_SCHEMA || item.generator !== PART_CONTRIBUTION_DRAFT_GENERATOR) {
    throw new Error('Part contribution draft schema or generator is unsupported.');
  }
  const selected = item.selected as PartEvidenceCandidateResult['selected'];
  const candidate = item.candidate as PartEvidenceContributionDraft['candidate'];
  const observations = item.localObservations as PartEvidenceContributionDraft['localObservations'];
  const scope = item.scope as PartEvidenceContributionDraft['scope'];
  if (!selected || typeof selected !== 'object' || !candidate || typeof candidate !== 'object'
    || !observations || typeof observations !== 'object' || !scope || typeof scope !== 'object') {
    throw new Error('Part contribution draft is missing structured fields.');
  }
  if (Object.keys(selected).sort().join('|') !== 'footprint|mpn|ref|sourceComponentId'
    || Object.keys(candidate).sort().join('|') !== 'partRecordSchemaVersion|record'
    || Object.keys(observations).sort().join('|') !== 'collisionTarget|evidencePathPresence'
    || Object.keys(observations.collisionTarget ?? {}).sort().join('|') !== 'collision|path|state'
    || Object.keys(scope).sort().join('|') !== 'doesNotProve|proves') {
    throw new Error('Part contribution draft contains missing or unknown structured fields.');
  }
  for (const [label, field] of Object.entries(selected)) boundedExactText(field, `selected.${label}`);
  if (candidate.partRecordSchemaVersion !== 1) throw new Error('Part contribution draft record schema version is unsupported.');
  const parsed = parsePartEvidenceFile(JSON.stringify({ schemaVersion: 1, parts: [candidate.record] }));
  if (canonicalJson(parsed.parts[0]) !== canonicalJson(candidate.record)) throw new Error('Part contribution draft record is not canonical v1 data.');
  if (observations.collisionTarget?.path !== DEFAULT_PART_EVIDENCE_PATH
    || !['loaded', 'missing'].includes(observations.collisionTarget?.state)
    || !['new', 'exact-duplicate', 'conflict'].includes(observations.collisionTarget?.collision)
    || !Array.isArray(observations.evidencePathPresence)) {
    throw new Error('Part contribution draft local observations are invalid.');
  }
  for (const presence of observations.evidencePathPresence) {
    if (!presence || typeof presence !== 'object'
      || !['source|state', 'notes|source|state'].includes(Object.keys(presence).sort().join('|'))
      || !['present', 'missing'].includes(presence.state)) {
      throw new Error('Part contribution draft path-presence observation is invalid.');
    }
    boundedExactText(presence.source, 'localObservations.evidencePathPresence.source');
    if (presence.notes != null) boundedExactText(presence.notes, 'localObservations.evidencePathPresence.notes');
  }
  if (scope.proves !== 'canonical-local-part-record-draft-and-path-presence-observation'
    || !Array.isArray(scope.doesNotProve) || !scope.doesNotProve.every((entry) => typeof entry === 'string')) {
    throw new Error('Part contribution draft scope is invalid.');
  }
  return value as PartEvidenceContributionDraft;
}

function boundedExactText(value: unknown, label: string, optional = false): string | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be one non-empty string.`);
  const trimmed = value.trim();
  if (new TextEncoder().encode(trimmed).byteLength > MAX_PART_EVIDENCE_CANDIDATE_TEXT_BYTES) {
    throw new Error(`${label} must be at most ${MAX_PART_EVIDENCE_CANDIDATE_TEXT_BYTES} UTF-8 bytes.`);
  }
  return trimmed;
}

function candidateRecord(elements: AnyCircuitElement[], request: PartEvidenceCandidateRequest): {
  selected: PartEvidenceCandidateResult['selected'];
  record: LocalPartEvidenceRecord;
} {
  const sourceComponentId = boundedExactText(request.sourceComponentId, 'sourceComponentId')!;
  const ref = boundedExactText(request.ref, 'ref')!;
  const components = listComponents(elements);
  const matches = components.filter((component) => component.id === sourceComponentId && component.name === ref);
  if (matches.length !== 1 || components.filter((component) => component.id === sourceComponentId).length !== 1
    || components.filter((component) => component.name === ref).length !== 1) {
    throw new Error(`Part-record validation requires one unique exact current placed part for ${JSON.stringify(ref)} and ${JSON.stringify(sourceComponentId)}.`);
  }
  const mpn = boundedExactText(matches[0].manufacturerPartNumber, `Selected ${ref} manufacturer part number`)!;
  const footprint = boundedExactText(matches[0].footprint, `Selected ${ref} placed footprint`)!;
  if (!Array.isArray(request.evidence) || request.evidence.length === 0 || request.evidence.length > MAX_PART_EVIDENCE_CANDIDATE_SOURCES) {
    throw new Error(`evidence must contain 1-${MAX_PART_EVIDENCE_CANDIDATE_SOURCES} reviewer-chosen local source paths.`);
  }
  const manufacturer = boundedExactText(request.manufacturer, 'manufacturer', true);
  const notes = boundedExactText(request.notes, 'notes', true);
  const evidence = request.evidence.map((source, index) => {
    const sourcePath = boundedExactText(source?.source, `evidence[${index}].source`)!;
    const sourceNotes = boundedExactText(source?.notes, `evidence[${index}].notes`, true);
    return { source: sourcePath, ...(sourceNotes ? { notes: sourceNotes } : {}) };
  });
  const parsed = parsePartEvidenceFile(JSON.stringify({
    schemaVersion: PART_EVIDENCE_SCHEMA_VERSION,
    parts: [{ mpn, ...(manufacturer ? { manufacturer } : {}), footprint, evidence, ...(notes ? { notes } : {}) }],
  }));
  return { selected: { sourceComponentId, ref, mpn, footprint }, record: parsed.parts[0] };
}

function sameRecord(a: LocalPartEvidenceRecord, b: LocalPartEvidenceRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createPartEvidenceCandidateGrant(
  baseline: string,
  part: { id: string; name: string; manufacturerPartNumber?: string; footprint?: string },
): PartEvidenceCandidateGrant {
  const sourceComponentId = boundedExactText(part.id, 'Selected source component id')!;
  const ref = boundedExactText(part.name, 'Selected ref')!;
  const mpn = boundedExactText(part.manufacturerPartNumber, `Selected ${ref} manufacturer part number`)!;
  const footprint = boundedExactText(part.footprint, `Selected ${ref} placed footprint`)!;
  return { baseline, sourceComponentId, ref, mpn, footprint };
}

export function validatePartEvidenceCandidateGrant(
  grant: PartEvidenceCandidateGrant,
  currentSource: string,
  elements: AnyCircuitElement[],
  request: Pick<PartEvidenceCandidateRequest, 'sourceComponentId' | 'ref'>,
): void {
  if (grant.baseline !== currentSource) throw new Error('The source changed during part-record validation. Select Validate record again.');
  if (request.sourceComponentId !== grant.sourceComponentId || request.ref !== grant.ref) {
    throw new Error('Part-record validation must target the exact selected source component id and ref.');
  }
  const components = listComponents(elements);
  const matches = components.filter((component) => component.id === grant.sourceComponentId && component.name === grant.ref);
  if (matches.length !== 1 || components.filter((component) => component.id === grant.sourceComponentId).length !== 1
    || components.filter((component) => component.name === grant.ref).length !== 1
    || matches[0].manufacturerPartNumber !== grant.mpn || matches[0].footprint !== grant.footprint) {
    throw new Error('The selected part identity, MPN, or placed footprint changed during part-record validation.');
  }
}

/** Validate one selected-part record candidate without writing or reading referenced evidence contents. */
export async function validatePartEvidenceCandidate(options: {
  elements: AnyCircuitElement[];
  request: PartEvidenceCandidateRequest;
  workspacePath: string;
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  assertCurrent(): void;
}): Promise<PartEvidenceCandidateResult> {
  const { selected, record } = candidateRecord(options.elements, options.request);
  const resolvedPath = resolvePartEvidenceFilePath(DEFAULT_PART_EVIDENCE_PATH, options.workspacePath);
  const targetExists = await options.fileExists(resolvedPath);
  let existing: PartEvidenceFile | undefined;
  if (targetExists) existing = parsePartEvidenceFile(await options.readFile(resolvedPath));
  const existingMatch = existing?.parts.find((part) => part.mpn === record.mpn);
  const collision: PartEvidenceCandidateResult['collision'] = !existingMatch
    ? 'new'
    : sameRecord(existingMatch, record) ? 'exact-duplicate' : 'conflict';
  const sources = await checkPartEvidenceSources({ schemaVersion: 1, parts: [record] }, {
    workspacePath: options.workspacePath,
    evidenceFilePath: resolvedPath,
    fileExists: options.fileExists,
  });
  options.assertCurrent();
  return {
    schemaVersion: 1,
    schemaPath: PART_EVIDENCE_SCHEMA_PATH,
    parserAuthority: 'The TypeScript v1 parser remains authoritative for exact duplicate MPNs, path aliases, and workspace confinement that JSON Schema alone cannot prove.',
    selected,
    target: { requestedPath: DEFAULT_PART_EVIDENCE_PATH, resolvedPath, state: targetExists ? 'loaded' : 'missing' },
    collision,
    pathPresence: {
      total: sources.length,
      present: sources.filter((source) => source.state === 'present').length,
      missing: sources.filter((source) => source.state === 'missing').length,
      sources: sources.map(({ source, state, notes }) => ({ source, state, ...(notes ? { notes } : {}) })),
    },
    checks: { parserCompatible: true, selectedMetadataMatches: true, allPathsPresent: sources.every((source) => source.state === 'present') },
    omissions: { sourceCount: 0, fields: [] },
    canonicalRecordJson: JSON.stringify(record, null, 2),
    limitations: [
      'Parser-compatible, selected-metadata-matching, and path-present are local checks only; they do not make this a verified or accepted contribution.',
      'Referenced evidence contents are not opened, read, hashed, authenticated, licensed, or verified.',
      'No datasheet, pin map, electrical behavior, supplier availability, orderability, manufacturing, package security, or community publication is validated.',
      'This checker never creates, overwrites, merges, publishes, fetches, or mutates electronics.parts.json or the circuit.',
    ],
  };
}

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function baseDraft(outputPath: string, manifestPath: string): CreatePartEvidenceDraftResult {
  return {
    status: 'refused',
    output_path: outputPath,
    manifest_path: manifestPath,
    sourceStableBeforeWrite: false,
    sourceStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed',
    nonAtomicNoClobber: true,
    symlinkConfinement: 'unproven',
  };
}

const REVIEW_LIMITATIONS = [
  'Consistent current observations means the explicit draft/manifest are intact and current root collision/path-presence observations agree; it is not acceptance or verification.',
  'Referenced evidence contents are not opened, read, hashed, authenticated, licensed, or verified.',
  'The review does not prove electrical correctness, footprint correctness, availability, orderability, manufacturability, security, publication, or community approval.',
  'This global filesystem review does not open an editor or re-resolve the selected component against a live design; use the editor freshness checker or an explicit design-review packet for that separate question.',
  'The unsigned manifest does not resist coordinated edits; root collision and path presence remain point-in-time observations without realpath or symlink proof.',
];

function baseReview(draftPath: string, manifestPath: string): PartEvidenceContributionReviewResult {
  return { state: 'malformed_or_unsupported', draft_path: draftPath, manifest_path: manifestPath, details: [], readOnly: true, limitations: REVIEW_LIMITATIONS };
}

/**
 * Review one explicit manifest and its single contribution envelope against
 * current local root-collision/path-presence observations. Never mutates files,
 * opens an editor, scans for inputs, or reads referenced evidence contents.
 */
export async function reviewPartEvidenceContributionDraft(input: {
  fs: Pick<TextFileSystem, 'readFile' | 'fileExists'>;
  workspacePath: string;
  manifestPath: unknown;
}): Promise<PartEvidenceContributionReviewResult> {
  let draftRelative = '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  try {
    if (!input.workspacePath) throw new Error('A workspace must be open before reviewing a part contribution draft.');
    manifestRelative = validateDraftPath(input.manifestPath, 'manifest_path', '.freshness.json');
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const base = baseReview(draftRelative, manifestRelative);
    if (!(await input.fs.fileExists(manifestAbsolute))) return { ...base, state: 'artifact_missing', details: ['The explicit contribution manifest does not exist.'] };
    let manifestText: string;
    try { manifestText = await input.fs.readFile(manifestAbsolute); }
    catch (error) { return { ...base, details: [`The explicit contribution manifest could not be read: ${(error as Error).message}`] }; }
    const parsedManifest = parseArtifactFreshnessManifest(manifestText, manifestAbsolute);
    if ('state' in parsedManifest) return { ...base, details: parsedManifest.details };
    if (parsedManifest.export.kind !== 'part-contribution-draft') {
      return { ...base, details: [`The manifest records ${parsedManifest.export.kind}, not part-contribution-draft.`] };
    }
    if (parsedManifest.exporterRevision !== EXPORTER_REVISION) {
      return { ...base, state: 'exporter_revision_changed', details: [`Manifest exporter revision ${parsedManifest.exporterRevision} differs from ${EXPORTER_REVISION}.`] };
    }
    const expectedExportFingerprint = await sha256Text(canonicalJson({
      kind: parsedManifest.export.kind,
      options: parsedManifest.export.options,
      exporterRevision: parsedManifest.exporterRevision,
    }));
    if (expectedExportFingerprint !== parsedManifest.export.sha256) {
      return { ...base, details: ['The manifest export fingerprint does not match its kind, options, and exporter revision.'] };
    }
    if (parsedManifest.artifacts.length !== 1 || !parsedManifest.artifacts[0].path.endsWith('.electronics.part-contribution-draft.json')) {
      return { ...base, details: ['The manifest must record exactly one canonical *.electronics.part-contribution-draft.json artifact.'] };
    }
    const draftAbsolute = resolveManifestArtifactPath(manifestAbsolute, parsedManifest.artifacts[0].path);
    const workspacePrefix = `${input.workspacePath.replace(/\/$/, '')}/`;
    if (!draftAbsolute.startsWith(workspacePrefix)) return { ...base, details: ['The recorded contribution draft escapes the workspace.'] };
    draftRelative = draftAbsolute.slice(workspacePrefix.length);
    const resolvedBase = baseReview(draftRelative, manifestRelative);
    if (!(await input.fs.fileExists(draftAbsolute))) return { ...resolvedBase, state: 'artifact_missing', details: ['The manifest-recorded contribution draft is missing.'] };
    let draftText: string;
    try { draftText = await input.fs.readFile(draftAbsolute); }
    catch (error) { return { ...resolvedBase, state: 'artifact_missing', details: [`The manifest-recorded contribution draft could not be read: ${(error as Error).message}`] }; }
    const recordedArtifact = parsedManifest.artifacts[0];
    const artifactBytesMatch = new TextEncoder().encode(draftText).byteLength === recordedArtifact.bytes;
    const artifactSha256Matches = await sha256Text(draftText) === recordedArtifact.sha256;
    if (!artifactBytesMatch || !artifactSha256Matches) {
      return { ...resolvedBase, state: 'artifact_modified', details: ['The contribution draft byte count or SHA-256 differs from the manifest.'] };
    }
    let draft: PartEvidenceContributionDraft;
    try { draft = parsePartEvidenceContributionDraft(draftText); }
    catch (error) { return { ...resolvedBase, details: [(error as Error).message] }; }
    const record = draft.candidate.record;
    const selectedMatchesCandidate = draft.selected.mpn === record.mpn && draft.selected.footprint === record.footprint;
    const expectedPresence = record.evidence.map((entry) => ({ source: entry.source, state: 'present' as const, ...(entry.notes ? { notes: entry.notes } : {}) }));
    const evidenceObservationsMatchCandidate = canonicalJson(expectedPresence) === canonicalJson(draft.localObservations.evidencePathPresence);
    const scopeMatchesGenerator = canonicalJson(draft.scope.doesNotProve) === canonicalJson(CONTRIBUTION_DOES_NOT_PROVE);
    const manifestOptionsMatchDraft = canonicalJson(parsedManifest.export.options) === canonicalJson({
      schemaVersion: 1,
      selectedSourceComponentId: draft.selected.sourceComponentId,
      selectedRef: draft.selected.ref,
      targetPath: DEFAULT_PART_EVIDENCE_PATH,
      collision: draft.localObservations.collisionTarget.collision,
      evidencePresence: 'path-only',
    });
    const targetPath = resolvePartEvidenceFilePath(DEFAULT_PART_EVIDENCE_PATH, input.workspacePath);
    const targetExists = await input.fs.fileExists(targetPath);
    let existing: PartEvidenceFile | undefined;
    if (targetExists) existing = parsePartEvidenceFile(await input.fs.readFile(targetPath));
    const existingMatch = existing?.parts.find((part) => part.mpn === record.mpn);
    const collision: PartEvidenceCandidateResult['collision'] = !existingMatch ? 'new' : sameRecord(existingMatch, record) ? 'exact-duplicate' : 'conflict';
    const currentSources = await checkPartEvidenceSources({ schemaVersion: 1, parts: [record] }, {
      workspacePath: input.workspacePath,
      evidenceFilePath: targetPath,
      fileExists: (path) => input.fs.fileExists(path),
    });
    const currentPresence: PartEvidenceCandidateResult['pathPresence'] = {
      total: currentSources.length,
      present: currentSources.filter((source) => source.state === 'present').length,
      missing: currentSources.filter((source) => source.state === 'missing').length,
      sources: currentSources.map(({ source, state, notes }) => ({ source, state, ...(notes ? { notes } : {}) })),
    };
    const collisionObservationCurrent = collision === draft.localObservations.collisionTarget.collision
      && (targetExists ? 'loaded' : 'missing') === draft.localObservations.collisionTarget.state;
    const pathPresenceObservationCurrent = canonicalJson(currentPresence.sources) === canonicalJson(draft.localObservations.evidencePathPresence);
    const allEvidencePathsPresent = currentPresence.missing === 0;
    const checks = {
      manifestKind: true,
      manifestRecordsExactDraft: true,
      manifestOptionsMatchDraft,
      selectedMatchesCandidate,
      evidenceObservationsMatchCandidate,
      scopeMatchesGenerator,
      artifactBytesMatch,
      artifactSha256Matches,
      collisionObservationCurrent,
      pathPresenceObservationCurrent,
      allEvidencePathsPresent,
    };
    const consistent = Object.values(checks).every(Boolean);
    return {
      ...resolvedBase,
      state: consistent ? 'consistent_current_observations' : 'local_observations_changed',
      draft,
      checks,
      current: { collision, pathPresence: currentPresence },
      details: consistent
        ? ['The explicit manifest/draft are intact and current root collision/path-presence observations match the recorded envelope.']
        : ['The envelope, manifest options, root collision, or evidence path-presence observations differ from the current local state.'],
    };
  } catch (error) {
    return { ...baseReview(draftRelative, manifestRelative), details: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Emit one standalone, versioned contribution envelope plus a tracked
 * completion manifest. This never merges into or rewrites electronics.parts.json.
 */
export async function createPartEvidenceContributionDraft(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot'>;
  fs: TextFileSystem;
  workspacePath: string;
  outputPath: unknown;
  manifestPath: unknown;
  request: PartEvidenceCandidateRequest;
}): Promise<CreatePartEvidenceDraftResult> {
  let outputRelative = typeof input.outputPath === 'string' ? input.outputPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  try {
    if (!input.workspacePath) throw new Error('A workspace must be open before creating a local part-record contribution draft.');
    outputRelative = validateDraftPath(input.outputPath, 'output_path', '.electronics.part-contribution-draft.json');
    manifestRelative = validateDraftPath(input.manifestPath, 'manifest_path', '.freshness.json');
    if (outputRelative === manifestRelative) throw new Error('Part-record draft and manifest paths must be distinct.');
    if (outputRelative === DEFAULT_PART_EVIDENCE_PATH || manifestRelative === DEFAULT_PART_EVIDENCE_PATH) {
      throw new Error(`The contribution draft must not target ${DEFAULT_PART_EVIDENCE_PATH}; merge remains a separate manual review.`);
    }
    const outputAbsolute = joinWorkspace(input.workspacePath, outputRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const base = baseDraft(outputRelative, manifestRelative);
    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return { ...base, refusal: { code: 'snapshot-failed', message: `The copied editor source failed evaluation: ${snapshot.evalError}` } };
    if (input.api.getCode() !== snapshot.source) return { ...base, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed before candidate validation.' } };
    const candidate = await validatePartEvidenceCandidate({
      elements: snapshot.circuitJson,
      request: input.request,
      workspacePath: input.workspacePath,
      fileExists: (path) => input.fs.fileExists(path),
      readFile: (path) => input.fs.readFile(path),
      assertCurrent: () => {
        if (input.api.getCode() !== snapshot.source) throw new Error('The circuit changed during contribution-draft validation. Select Create contribution again.');
      },
    });
    if (!candidate.checks.allPathsPresent) {
      return { ...base, candidate, refusal: { code: 'evidence-path-missing', message: 'Every explicit evidence path must be present before a contribution draft can be emitted. Presence does not verify content.' } };
    }
    const draftText = `${JSON.stringify(JSON.parse(canonicalJson(buildPartEvidenceContributionDraft(candidate))), null, 2)}\n`;
    if (new TextEncoder().encode(draftText).byteLength > MAX_PART_CONTRIBUTION_DRAFT_BYTES) {
      return { ...base, candidate, refusal: { code: 'draft-too-large', message: `The contribution draft exceeds ${MAX_PART_CONTRIBUTION_DRAFT_BYTES} UTF-8 bytes.` } };
    }
    parsePartEvidenceContributionDraft(draftText);
    const draftSha256 = await sha256Text(draftText);
    if (input.api.getCode() !== snapshot.source) {
      return { ...base, candidate, draft_sha256: draftSha256, refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed while the contribution draft was assembled; no intentional write was attempted.' } };
    }
    for (const parent of new Set([parentPath(outputAbsolute), parentPath(manifestAbsolute)])) {
      if (!(await input.fs.fileExists(parent))) {
        return { ...base, candidate, draft_sha256: draftSha256, refusal: { code: 'parent-missing-or-unevidenced', message: `Destination parent does not exist as far as fileExists can evidence: ${parent}` } };
      }
    }
    if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) {
      return { ...base, candidate, draft_sha256: draftSha256, refusal: { code: 'path-exists', message: 'The contribution draft or manifest already exists; overwrite-anyway is never offered.' } };
    }
    let writeStage: 'none' | 'draft' | 'manifest' = 'none';
    let sourceStableBeforeWrite = false;
    let sourceStableBeforeManifest = false;
    const candidateFingerprint = canonicalJson({
      selected: candidate.selected,
      target: candidate.target,
      collision: candidate.collision,
      pathPresence: candidate.pathPresence,
      canonicalRecordJson: candidate.canonicalRecordJson,
    });
    const assertCandidateCurrent = async () => {
      const current = await validatePartEvidenceCandidate({
        elements: snapshot.circuitJson,
        request: input.request,
        workspacePath: input.workspacePath,
        fileExists: (path) => input.fs.fileExists(path),
        readFile: (path) => input.fs.readFile(path),
        assertCurrent: () => {
          if (input.api.getCode() !== snapshot.source) throw new Error('The circuit changed during contribution-draft emission.');
        },
      });
      const fingerprint = canonicalJson({
        selected: current.selected,
        target: current.target,
        collision: current.collision,
        pathPresence: current.pathPresence,
        canonicalRecordJson: current.canonicalRecordJson,
      });
      if (fingerprint !== candidateFingerprint) throw new Error('The part record, root collision, or evidence path-presence observation changed before the next write. Select Create contribution draft again.');
    };
    const guardedFs = {
      writeFile: async (path: string, content: string) => {
        if (path === outputAbsolute) {
          if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) throw new Error('A destination appeared after the non-atomic preflight; no intentional draft write was attempted.');
          sourceStableBeforeWrite = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeWrite) throw new Error('The editor-buffer source changed immediately before contribution-draft write.');
          await assertCandidateCurrent();
          writeStage = 'draft';
        } else {
          if (await input.fs.fileExists(manifestAbsolute)) throw new Error('The manifest destination appeared after the non-atomic preflight; it was not knowingly overwritten.');
          sourceStableBeforeManifest = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeManifest) throw new Error('The editor-buffer source changed immediately before contribution-draft manifest write.');
          await assertCandidateCurrent();
          writeStage = 'manifest';
        }
        await input.fs.writeFile(path, content);
      },
    };
    try {
      await writeTrackedExport({
        fs: guardedFs,
        manifestPath: manifestAbsolute,
        source: snapshot.source,
        circuitJson: snapshot.circuitJson,
        kind: 'part-contribution-draft',
        options: {
          schemaVersion: PART_EVIDENCE_SCHEMA_VERSION,
          selectedSourceComponentId: candidate.selected.sourceComponentId,
          selectedRef: candidate.selected.ref,
          targetPath: DEFAULT_PART_EVIDENCE_PATH,
          collision: candidate.collision,
          evidencePresence: 'path-only',
        },
        artifacts: [{ path: outputAbsolute, text: draftText }],
        assertSourceCurrent: () => {
          if (input.api.getCode() !== snapshot.source) throw new Error('The editor-buffer source changed during contribution-draft emission.');
        },
      });
      return { ...base, status: 'created', candidate, draft_sha256: draftSha256, sourceStableBeforeWrite, sourceStableBeforeManifest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (writeStage === 'none') return { ...base, candidate, draft_sha256: draftSha256, sourceStableBeforeWrite, sourceStableBeforeManifest, refusal: { code: 'write-refused', message } };
      return {
        ...base,
        status: 'incomplete',
        candidate,
        draft_sha256: draftSha256,
        sourceStableBeforeWrite,
        sourceStableBeforeManifest,
        cleanup: { automatic: false, pathsThatMayExist: writeStage === 'draft' ? [outputRelative] : [outputRelative, manifestRelative] },
        refusal: { code: 'write-failed', message },
      };
    }
  } catch (error) {
    return { ...baseDraft(outputRelative, manifestRelative), refusal: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } };
  }
}
