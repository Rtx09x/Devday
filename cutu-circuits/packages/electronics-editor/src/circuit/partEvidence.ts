import { listComponents, type AnyCircuitElement } from './circuitJson.ts';

export const PART_EVIDENCE_SCHEMA_VERSION = 1;
export const DEFAULT_PART_EVIDENCE_PATH = 'electronics.parts.json';

export type PartEvidenceStatus = 'incomplete' | 'declared' | 'evidenced' | 'conflict';
export type EvidenceSourcePresenceState = 'present' | 'missing';

export interface LocalEvidenceSource {
  /** Inspectable project-relative local file path. URLs and parent traversal are rejected. */
  source: string;
  /** Exact reviewer-authored context; this is not interpreted as a verification claim. */
  notes?: string;
}

export interface LocalPartEvidenceRecord {
  mpn: string;
  manufacturer?: string;
  footprint: string;
  evidence: LocalEvidenceSource[];
  notes?: string;
}

export interface EvidenceSourcePresence extends LocalEvidenceSource {
  /** Authored project-relative source path resolved inside the workspace boundary. */
  resolvedPath: string;
  /** Path presence only. The referenced content is never read or verified. */
  state: EvidenceSourcePresenceState;
}

export interface PartEvidenceFile {
  schemaVersion: 1;
  parts: LocalPartEvidenceRecord[];
}

export interface PartEvidenceFinding {
  ref: string;
  sourceComponentId: string;
  status: PartEvidenceStatus;
  mpn?: string;
  footprint?: string;
  missingFields: Array<'mpn' | 'footprint'>;
  record?: LocalPartEvidenceRecord;
  sources?: EvidenceSourcePresence[];
  conflict?: { field: 'footprint'; placed: string; recorded: string };
}

export interface PartEvidenceReport {
  schemaVersion: 1;
  evidenceFile: {
    path: string;
    state: 'loaded' | 'missing';
    recordCount: number;
  };
  summary: Record<PartEvidenceStatus, number> & { total: number };
  sourceSummary: Record<EvidenceSourcePresenceState, number> & { total: number };
  sources: EvidenceSourcePresence[];
  parts: PartEvidenceFinding[];
  evidencedMeans: string;
  limitations: string[];
}

/** Parse the strict, versioned project-local part evidence contract. */
export function parsePartEvidenceFile(content: string): PartEvidenceFile {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Part evidence is not valid JSON: ${message(error)}`);
  }
  if (!isRecord(value)) throw new Error('Part evidence must be a JSON object.');
  if (value.schemaVersion !== PART_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported part evidence schemaVersion. Expected ${PART_EVIDENCE_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(value.parts)) throw new Error('parts must be an array.');

  const seenMpns = new Set<string>();
  const parts = value.parts.map((item, index): LocalPartEvidenceRecord => {
    const path = `parts[${index}]`;
    const input = record(item, path);
    const mpn = requiredString(input.mpn, `${path}.mpn`);
    if (seenMpns.has(mpn)) throw new Error(`${path}.mpn duplicates exact MPN "${mpn}".`);
    seenMpns.add(mpn);
    const footprint = requiredString(input.footprint, `${path}.footprint`);
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new Error(`${path}.evidence must contain at least one inspectable local source.`);
    }
    const seenSources = new Set<string>();
    const evidence = input.evidence.map((entry, evidenceIndex): LocalEvidenceSource => {
      const evidencePath = `${path}.evidence[${evidenceIndex}]`;
      const evidenceRecord = record(entry, evidencePath);
      const source = requiredString(evidenceRecord.source, `${evidencePath}.source`);
      if (!isSafeLocalEvidencePath(source)) {
        throw new Error(`${evidencePath}.source must be an unambiguous project-relative local path using forward slashes, without a URL, absolute path, dot segment, parent traversal, or glob syntax.`);
      }
      if (seenSources.has(source)) throw new Error(`${evidencePath}.source duplicates "${source}" in the same record.`);
      seenSources.add(source);
      const notes = optionalString(evidenceRecord.notes, `${evidencePath}.notes`);
      return { source, ...(notes ? { notes } : {}) };
    });
    const manufacturer = optionalString(input.manufacturer, `${path}.manufacturer`);
    const notes = optionalString(input.notes, `${path}.notes`);
    return {
      mpn,
      ...(manufacturer ? { manufacturer } : {}),
      footprint,
      evidence,
      ...(notes ? { notes } : {}),
    };
  });
  return { schemaVersion: 1, parts };
}

/** Classify every placed source component using only exact local record matches. */
export function buildPartEvidenceReport(
  elements: AnyCircuitElement[],
  options: { path: string; file?: PartEvidenceFile; sources?: EvidenceSourcePresence[] },
): PartEvidenceReport {
  const records = new Map((options.file?.parts ?? []).map((part) => [part.mpn, part]));
  const sources = [...(options.sources ?? [])].sort((a, b) => a.source.localeCompare(b.source));
  const sourceByPath = new Map(sources.map((source) => [source.source, source]));
  const parts = listComponents(elements)
    .map((component): PartEvidenceFinding => {
      const ref = component.name;
      const sourceComponentId = component.id;
      const mpn = component.manufacturerPartNumber;
      const footprint = component.footprint;
      const missingFields: Array<'mpn' | 'footprint'> = [];
      if (!mpn) missingFields.push('mpn');
      if (!footprint) missingFields.push('footprint');
      if (!mpn || !footprint) {
        return { ref, sourceComponentId, status: 'incomplete', ...(mpn ? { mpn } : {}), ...(footprint ? { footprint } : {}), missingFields };
      }
      const matching = records.get(mpn);
      if (!matching) return { ref, sourceComponentId, status: 'declared', mpn, footprint, missingFields };
      const matchingSources = matching.evidence.map((source) => sourceByPath.get(source.source) ?? {
        ...source,
        resolvedPath: source.source,
        state: 'missing' as const,
      });
      if (matching.footprint !== footprint) {
        return {
          ref, sourceComponentId, status: 'conflict', mpn, footprint, missingFields,
          record: matching,
          sources: matchingSources,
          conflict: { field: 'footprint', placed: footprint, recorded: matching.footprint },
        };
      }
      if (matchingSources.some((source) => source.state === 'missing')) {
        return { ref, sourceComponentId, status: 'declared', mpn, footprint, missingFields, record: matching, sources: matchingSources };
      }
      return { ref, sourceComponentId, status: 'evidenced', mpn, footprint, missingFields, record: matching, sources: matchingSources };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId));
  const summary = {
    total: parts.length,
    incomplete: parts.filter((part) => part.status === 'incomplete').length,
    declared: parts.filter((part) => part.status === 'declared').length,
    evidenced: parts.filter((part) => part.status === 'evidenced').length,
    conflict: parts.filter((part) => part.status === 'conflict').length,
  };
  return {
    schemaVersion: 1,
    evidenceFile: {
      path: options.path,
      state: options.file ? 'loaded' : 'missing',
      recordCount: options.file?.parts.length ?? 0,
    },
    summary,
    sourceSummary: {
      total: sources.length,
      present: sources.filter((source) => source.state === 'present').length,
      missing: sources.filter((source) => source.state === 'missing').length,
    },
    sources,
    parts,
    evidencedMeans: 'Exact placed MPN matched a local record, the placed footprint agreed, and every referenced local evidence path was present.',
    limitations: [
      'Not electrical verification, authenticity, availability, orderability, production approval, or live supplier data.',
      'Present means only that fileExists reported the confined path as accessible; source contents are not opened, read, validated, hashed, authenticated, or verified.',
      'The public filesystem boundary does not expose trustworthy byte, digest, stat, or realpath metadata; regular-file type, content integrity, and symlink-target authentication are deferred.',
    ],
  };
}

export function evidenceFindingByComponentId(
  report: PartEvidenceReport | undefined,
): Map<string, PartEvidenceFinding> {
  return new Map((report?.parts ?? []).map((part) => [part.sourceComponentId, part]));
}

/** Shared copy contract for the navigator and Advisor part rows. */
export function presentPartEvidence(finding: PartEvidenceFinding): { label: PartEvidenceStatus; detail: string } {
  if (finding.status === 'incomplete') {
    return { label: finding.status, detail: `Missing ${finding.missingFields.join(' and ')}; no local evidence claim is made.` };
  }
  if (finding.status === 'declared') {
    const missingSources = finding.sources?.filter((source) => source.state === 'missing') ?? [];
    if (finding.record && missingSources.length > 0) {
      return {
        label: finding.status,
        detail: `${finding.mpn} and ${finding.footprint} match the local record, but ${missingSources.length} referenced source path${missingSources.length === 1 ? ' is' : 's are'} missing; the identifiers remain declared only.`,
      };
    }
    return { label: finding.status, detail: `${finding.mpn} and ${finding.footprint} are placed metadata only; no exact local record was loaded.` };
  }
  if (finding.status === 'conflict') {
    return { label: finding.status, detail: `Placed footprint ${finding.conflict?.placed} disagrees with local record ${finding.conflict?.recorded}.` };
  }
  return { label: finding.status, detail: `Exact local record for ${finding.mpn} agrees with placed footprint ${finding.footprint}, and every referenced path is present; contents were not read or verified.` };
}

export async function checkPartEvidenceSources(
  file: PartEvidenceFile,
  options: {
    workspacePath: string;
    evidenceFilePath: string;
    fileExists(path: string): Promise<boolean>;
  },
): Promise<EvidenceSourcePresence[]> {
  const workspacePath = normalizeAbsolutePath(options.workspacePath, 'Workspace path');
  const evidenceFilePath = resolvePartEvidenceFilePath(options.evidenceFilePath, workspacePath);
  assertInsideWorkspace(evidenceFilePath, workspacePath, 'Part evidence file');

  const authoredByKey = new Map<string, LocalEvidenceSource>();
  for (const part of file.parts) {
    for (const source of part.evidence) {
      const resolvedPath = joinWorkspacePath(workspacePath, source.source);
      const key = comparablePath(resolvedPath);
      const previous = authoredByKey.get(key);
      if (previous && previous.source !== source.source) {
        throw new Error(`Evidence source paths "${previous.source}" and "${source.source}" ambiguously resolve to the same workspace path.`);
      }
      if (!previous) authoredByKey.set(key, source);
    }
  }

  const checked = await Promise.all([...authoredByKey.values()].map(async (source): Promise<EvidenceSourcePresence> => {
    const resolvedPath = joinWorkspacePath(workspacePath, source.source);
    if (!(await options.fileExists(resolvedPath))) return { ...source, resolvedPath, state: 'missing' };
    return { ...source, resolvedPath, state: 'present' };
  }));
  return checked.sort((a, b) => a.source.localeCompare(b.source));
}

export function resolvePartEvidenceFilePath(requestedPath: string, workspacePath: string): string {
  const workspace = normalizeAbsolutePath(workspacePath, 'Workspace path');
  const requested = requestedPath.trim().replace(/\\/g, '/');
  if (!requested) throw new Error('Part evidence path must not be empty.');
  const resolved = isAbsolutePath(requested)
    ? normalizeAbsolutePath(requested, 'Part evidence path')
    : joinWorkspacePath(workspace, requested);
  assertInsideWorkspace(resolved, workspace, 'Part evidence file');
  return resolved;
}

/** Read the record, check only source presence, and reject a stale circuit snapshot before returning. */
export async function preparePartEvidenceReport(
  elements: AnyCircuitElement[],
  options: {
    path: string;
    workspacePath: string;
    fileExists(path: string): Promise<boolean>;
    readFile(path: string): Promise<string>;
    assertCurrent(): void;
  },
): Promise<PartEvidenceReport> {
  const path = resolvePartEvidenceFilePath(options.path, options.workspacePath);
  const exists = await options.fileExists(path);
  const file = exists ? parsePartEvidenceFile(await options.readFile(path)) : undefined;
  const sources = file
    ? await checkPartEvidenceSources(file, {
        workspacePath: options.workspacePath,
        evidenceFilePath: path,
        fileExists: options.fileExists,
      })
    : [];
  const report = buildPartEvidenceReport(elements, { path, file, sources });
  options.assertCurrent();
  return report;
}

function isSafeLocalEvidencePath(path: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || /^(?:\/|\\|[A-Za-z]:[\\/])/.test(path)) return false;
  if (path.includes('\\') || /[\0*?[\]{}!]/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '..' && segment !== '.' && segment !== '');
}

function joinWorkspacePath(workspacePath: string, relativePath: string): string {
  const relative = relativePath.trim().replace(/\\/g, '/');
  if (!isSafeLocalEvidencePath(relative)) {
    throw new Error(`Path "${relativePath}" is not an unambiguous project-relative local path.`);
  }
  return `${workspacePath.replace(/\/$/, '')}/${relative}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function normalizeAbsolutePath(path: string, label: string): string {
  const withForwardSlashes = path.trim().replace(/\\/g, '/');
  const normalized = withForwardSlashes === '/' || /^[A-Za-z]:\/$/.test(withForwardSlashes)
    ? withForwardSlashes
    : withForwardSlashes.replace(/\/+$/, '');
  if (!isAbsolutePath(normalized)) throw new Error(`${label} must be absolute so local evidence remains workspace-confined.`);
  const prefix = normalized.startsWith('/') ? '/' : normalized.slice(0, 3);
  const remainder = normalized.startsWith('/') ? normalized.slice(1) : normalized.slice(3);
  const output: string[] = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) throw new Error(`${label} escapes its filesystem root.`);
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return prefix + output.join('/');
}

function comparablePath(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

function assertInsideWorkspace(path: string, workspacePath: string, label: string): void {
  const target = comparablePath(path);
  const workspace = comparablePath(workspacePath).replace(/\/$/, '');
  if (target !== workspace && !target.startsWith(`${workspace}/`)) {
    throw new Error(`${label} must stay inside the workspace boundary ${workspacePath}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  return requiredString(value, path);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
