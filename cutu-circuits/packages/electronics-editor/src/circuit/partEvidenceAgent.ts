import type { ComponentSummary } from './circuitJson.ts';
import type { PartEvidenceFinding, PartEvidenceReport } from './partEvidence.ts';
import { DEFAULT_PART_EVIDENCE_PATH, resolvePartEvidenceFilePath } from './partEvidence.ts';

export const MAX_PART_EVIDENCE_AGENT_BYTES = 8_192;
export const MAX_PART_EVIDENCE_AGENT_SOURCES = 8;
export const MAX_PART_EVIDENCE_PATH_BYTES = 1_024;

export interface SelectedPartEvidenceSnapshot {
  sourceComponentId: string;
  ref: string;
  binding: PartEvidenceReportBinding;
  pathAuthority: 'default-bootstrap' | 'loaded-exact';
  description: string;
}

export interface PartEvidenceReportBinding {
  requestedPath: string;
  resolvedPath: string;
}

export interface PartEvidenceSessionGrant {
  baseline: string;
  sourceComponentId: string;
  ref: string;
  requestedPath: string;
  resolvedPath?: string;
  pathAuthority: 'default-bootstrap' | 'loaded-exact';
}

function boundedText(value: unknown, fallback: string, maxBytes = 512): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
  const encoder = new TextEncoder();
  if (encoder.encode(normalized).byteLength <= maxBytes) return normalized;
  let output = '';
  for (const character of normalized) {
    if (encoder.encode(`${output}${character}…`).byteLength > maxBytes) break;
    output += character;
  }
  return `${output}…`;
}

function resolveExactFinding(
  report: PartEvidenceReport,
  target: Pick<ComponentSummary, 'id' | 'name'>,
): PartEvidenceFinding {
  const matches = report.parts.filter((finding) => finding.sourceComponentId === target.id && finding.ref === target.name);
  if (matches.length !== 1) {
    throw new Error(`Evidence Scout requires one exact current evidence finding for ${JSON.stringify(target.name)}; found ${matches.length}.`);
  }
  if (report.parts.filter((finding) => finding.sourceComponentId === target.id).length !== 1
    || report.parts.filter((finding) => finding.ref === target.name).length !== 1) {
    throw new Error('Evidence Scout requires unique selected source-component id and ref identities in the loaded report.');
  }
  return matches[0];
}

/** Bind the selected placed identity to the existing session-only evidence report without reading evidence sources. */
export function buildSelectedPartEvidenceSnapshot(
  report: PartEvidenceReport | undefined,
  target: Pick<ComponentSummary, 'id' | 'name'>,
  binding?: PartEvidenceReportBinding,
): SelectedPartEvidenceSnapshot {
  if (!report) throw new Error('Run electronics.part_evidence_report first so Evidence Scout has a session-only local report. No request was sent.');
  if (!binding) throw new Error('The loaded part-evidence report has no exact requested/resolved path provenance. Reload it before using Evidence Scout.');
  const finding = resolveExactFinding(report, target);
  const exactBinding = validatePartEvidenceReportBinding(binding);
  if (report.evidenceFile.path !== exactBinding.resolvedPath) throw new Error('The loaded part-evidence report path does not match its exact resolved-path provenance. Reload it before using Evidence Scout.');
  const sources = (finding.sources ?? []).slice(0, MAX_PART_EVIDENCE_AGENT_SOURCES).map((source) => ({
    source: boundedText(source.source, 'unknown local path', 240),
    state: source.state,
    ...(source.notes ? { notes: boundedText(source.notes, 'notes omitted', 240) } : {}),
  }));
  const description = JSON.stringify({
    selectedSourceComponentId: boundedText(finding.sourceComponentId, 'unknown source component', 240),
    selectedRef: boundedText(finding.ref, 'unknown ref', 240),
    status: finding.status,
    ...(finding.mpn ? { placedMpn: boundedText(finding.mpn, 'unknown MPN') } : {}),
    ...(finding.footprint ? { placedFootprint: boundedText(finding.footprint, 'unknown footprint') } : {}),
    missingFields: [...finding.missingFields],
    evidenceFile: {
      requestedPath: exactBinding.requestedPath,
      resolvedPath: exactBinding.resolvedPath,
      state: report.evidenceFile.state,
      recordCount: report.evidenceFile.recordCount,
    },
    ...(finding.record ? {
      matchedRecord: {
        mpn: boundedText(finding.record.mpn, 'unknown MPN'),
        footprint: boundedText(finding.record.footprint, 'unknown footprint'),
        ...(finding.record.manufacturer ? { manufacturer: boundedText(finding.record.manufacturer, 'unknown manufacturer') } : {}),
        ...(finding.record.notes ? { notes: boundedText(finding.record.notes, 'notes omitted') } : {}),
      },
    } : {}),
    ...(finding.conflict ? {
      conflict: {
        field: finding.conflict.field,
        placed: boundedText(finding.conflict.placed, 'unknown placed footprint'),
        recorded: boundedText(finding.conflict.recorded, 'unknown recorded footprint'),
      },
    } : {}),
    sources,
    omittedSourceCount: Math.max(0, (finding.sources?.length ?? 0) - sources.length),
    presenceMeaning: 'present/missing is a confined path-presence observation only; referenced source contents were not opened, read, validated, hashed, authenticated, or verified.',
  });
  if (new TextEncoder().encode(description).byteLength > MAX_PART_EVIDENCE_AGENT_BYTES) {
    throw new Error('The selected-part evidence snapshot exceeds its bounded prompt limit. No request was sent.');
  }
  return {
    sourceComponentId: finding.sourceComponentId,
    ref: finding.ref,
    binding: exactBinding,
    pathAuthority: 'loaded-exact',
    description,
  };
}

/** Bootstrap Evidence Scout without claiming a report status or inferring a workspace path. */
export function buildDefaultPartEvidenceBootstrapSnapshot(
  target: Pick<ComponentSummary, 'id' | 'name'>,
): SelectedPartEvidenceSnapshot {
  const description = JSON.stringify({
    selectedSourceComponentId: boundedText(target.id, 'unknown source component', 240),
    selectedRef: boundedText(target.name, 'unknown ref', 240),
    evidenceFile: { requestedPath: DEFAULT_PART_EVIDENCE_PATH, state: 'not-loaded' },
    classification: 'unavailable-until-report-load',
    limitation: 'No incomplete, declared, evidenced, conflict, or source-presence claim exists until the exact default report is loaded.',
  });
  return {
    sourceComponentId: target.id,
    ref: target.name,
    binding: { requestedPath: DEFAULT_PART_EVIDENCE_PATH, resolvedPath: '' },
    pathAuthority: 'default-bootstrap',
    description,
  };
}

export function validatePartEvidenceReportBinding(binding: PartEvidenceReportBinding): PartEvidenceReportBinding {
  for (const [label, value] of [['requested', binding.requestedPath], ['resolved', binding.resolvedPath]] as const) {
    if (typeof value !== 'string' || !value) throw new Error(`Part-evidence ${label} path provenance must be one exact non-empty string.`);
    if (new TextEncoder().encode(value).byteLength > MAX_PART_EVIDENCE_PATH_BYTES) {
      throw new Error(`Part-evidence ${label} path provenance must be at most ${MAX_PART_EVIDENCE_PATH_BYTES} UTF-8 bytes.`);
    }
  }
  return { requestedPath: binding.requestedPath, resolvedPath: binding.resolvedPath };
}

/** Resolve exact tool provenance before any editor report-state clear is allowed. */
export function resolvePartEvidenceToolBinding(
  requestedInput: unknown,
  workspacePath: string | undefined,
): Readonly<PartEvidenceReportBinding> {
  const requestedPath = typeof requestedInput === 'string' && requestedInput.trim()
    ? requestedInput.trim()
    : DEFAULT_PART_EVIDENCE_PATH;
  if (!workspacePath) throw new Error('A workspace must be open to confine local evidence paths.');
  const resolvedPath = resolvePartEvidenceFilePath(requestedPath, workspacePath);
  return Object.freeze(validatePartEvidenceReportBinding({ requestedPath, resolvedPath }));
}

export function createPartEvidenceSessionGrant(
  baseline: string,
  snapshot: SelectedPartEvidenceSnapshot,
): PartEvidenceSessionGrant {
  return {
    baseline,
    sourceComponentId: snapshot.sourceComponentId,
    ref: snapshot.ref,
    requestedPath: snapshot.binding.requestedPath,
    ...(snapshot.pathAuthority === 'loaded-exact' ? { resolvedPath: snapshot.binding.resolvedPath } : {}),
    pathAuthority: snapshot.pathAuthority,
  };
}

/** Validate the initial clear binding; bootstrap binds the first host-resolved default path. */
export function beginPartEvidenceSessionRefresh(
  grant: PartEvidenceSessionGrant,
  currentSource: string,
  binding: PartEvidenceReportBinding,
): PartEvidenceSessionGrant {
  if (grant.baseline !== currentSource) throw new Error('The circuit source changed during Evidence Scout. The loaded report was preserved.');
  const exact = validatePartEvidenceReportBinding(binding);
  if (exact.requestedPath !== grant.requestedPath) throw new Error('Evidence Scout may refresh only the byte-exact requested path advertised at Ask time.');
  if (grant.pathAuthority === 'default-bootstrap' && exact.requestedPath !== DEFAULT_PART_EVIDENCE_PATH) {
    throw new Error(`Evidence Scout bootstrap permits only the exact default requested path ${DEFAULT_PART_EVIDENCE_PATH}.`);
  }
  if (grant.resolvedPath && exact.resolvedPath !== grant.resolvedPath) throw new Error('Evidence Scout may refresh only the exact loaded resolved path advertised at Ask time.');
  return { ...grant, resolvedPath: exact.resolvedPath };
}

/** Accept one refreshed session-only report only when it remains bound to the same source and selected identity. */
export function validatePartEvidenceSessionReport(
  grant: PartEvidenceSessionGrant,
  currentSource: string,
  report: PartEvidenceReport,
  binding: PartEvidenceReportBinding,
): void {
  if (grant.baseline !== currentSource) {
    throw new Error('The circuit source changed during Evidence Scout. Select the intent again; the report was not attached.');
  }
  const exact = validatePartEvidenceReportBinding(binding);
  if (!grant.resolvedPath || exact.requestedPath !== grant.requestedPath || exact.resolvedPath !== grant.resolvedPath) throw new Error('Evidence Scout final report binding must exactly match its started refresh.');
  if (report.evidenceFile.path !== exact.resolvedPath) throw new Error('Evidence Scout final report path must equal its exact resolved-path provenance.');
  resolveExactFinding(report, { id: grant.sourceComponentId, name: grant.ref });
}
