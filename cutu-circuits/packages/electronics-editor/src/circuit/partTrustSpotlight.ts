import { listComponents, type AnyCircuitElement } from './circuitJson.ts';
import type { PartEvidenceReport, PartEvidenceStatus } from './partEvidence.ts';
import type { PartEvidenceReportBinding } from './partEvidenceAgent.ts';

export const PART_TRUST_SPOTLIGHT_STATUSES = ['incomplete', 'declared', 'conflict', 'evidenced'] as const;
export const MAX_PART_TRUST_SPOTLIGHT_PARTS = 128;

export interface PartTrustSpotlightRequest {
  statuses: string[];
}

export interface PartTrustSpotlightFinding {
  sourceComponentId: string;
  ref: string;
  status: PartEvidenceStatus;
  schematicComponentIds: string[];
  pcbComponentIds: string[];
}

export interface PartTrustSpotlightResult {
  statuses: PartEvidenceStatus[];
  findings: PartTrustSpotlightFinding[];
  counts: Record<PartEvidenceStatus, number> & {
    total: number;
    schematicMappedParts: number;
    schematicRenderedElements: number;
    pcbMappedParts: number;
    pcbRenderedElements: number;
    schematicUnmappedParts: number;
    pcbUnmappedParts: number;
  };
  evidenceFile: PartEvidenceReport['evidenceFile'];
  sourceSummary: PartEvidenceReport['sourceSummary'];
  sessionOnly: true;
  readOnly: true;
  sourceChanged: false;
  limitations: string[];
}

export interface ActivePartTrustSpotlight {
  source: string;
  result: PartTrustSpotlightResult;
}

const LIMITATIONS = [
  'Spotlight status comes only from the explicitly loaded session report and exact current source-component identity.',
  'Evidenced means an exact local MPN/footprint record agreement whose referenced paths were present when the report ran; it does not mean verified.',
  'Referenced evidence contents are not opened, read, hashed, authenticated, or validated.',
  'This is not electrical correctness, authenticity, availability, orderability, supplier-live, production, manufacturing, or physical validation.',
  'The host cannot watch evidence files or prove real paths; rerun electronics.part_evidence_report after local record or evidence-path changes.',
];

function exactStatuses(raw: unknown): PartEvidenceStatus[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PART_TRUST_SPOTLIGHT_STATUSES.length) {
    throw new Error('Part Trust Spotlight requires 1-4 exact unique statuses.');
  }
  const supported = new Set<string>(PART_TRUST_SPOTLIGHT_STATUSES);
  const result: PartEvidenceStatus[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !supported.has(value)) {
      throw new Error(`Unsupported part-evidence status ${JSON.stringify(value)}. Use incomplete, declared, conflict, or evidenced.`);
    }
    if (seen.has(value)) throw new Error(`Duplicate part-evidence status: ${value}.`);
    seen.add(value);
    result.push(value as PartEvidenceStatus);
  }
  return result;
}

function uniqueIdentity<T>(values: T[], label: string, key: (value: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (!identity) throw new Error(`Part Trust Spotlight requires non-empty ${label} identities.`);
    if (result.has(identity)) throw new Error(`Part Trust Spotlight requires unique ${label} identity ${JSON.stringify(identity)}.`);
    result.set(identity, value);
  }
  return result;
}

function projectedIds(elements: AnyCircuitElement[], type: 'schematic_component' | 'pcb_component', sourceComponentId: string): string[] {
  const field = type === 'schematic_component' ? 'schematic_component_id' : 'pcb_component_id';
  return Array.from(new Set(elements
    .filter((element) => element.type === type && String(element.source_component_id) === sourceComponentId)
    .map((element) => String(element[field] ?? ''))
    .filter(Boolean))).sort();
}

export function buildPartTrustSpotlight(
  elements: AnyCircuitElement[],
  report: PartEvidenceReport | undefined,
  binding: PartEvidenceReportBinding | undefined,
  request: PartTrustSpotlightRequest,
): PartTrustSpotlightResult {
  const statuses = exactStatuses(request?.statuses);
  if (!report || !binding) throw new Error('Run electronics.part_evidence_report first; no session-only part-evidence report is attached.');
  if (!binding.requestedPath || !binding.resolvedPath || report.evidenceFile.path !== binding.resolvedPath) {
    throw new Error('The loaded part-evidence report does not match its exact path binding. Reload the report before showing the Spotlight.');
  }
  const current = listComponents(elements);
  if (current.length > MAX_PART_TRUST_SPOTLIGHT_PARTS || report.parts.length > MAX_PART_TRUST_SPOTLIGHT_PARTS) {
    throw new Error(`Part Trust Spotlight supports at most ${MAX_PART_TRUST_SPOTLIGHT_PARTS} placed parts; current/report counts are ${current.length}/${report.parts.length}.`);
  }
  const currentById = uniqueIdentity(current, 'current source-component id', (part) => part.id);
  uniqueIdentity(current, 'current ref', (part) => part.name);
  const reportById = uniqueIdentity(report.parts, 'report source-component id', (part) => part.sourceComponentId);
  uniqueIdentity(report.parts, 'report ref', (part) => part.ref);
  if (current.length !== report.parts.length) throw new Error('The loaded part-evidence report no longer covers the exact current placed-part set. Reload it.');
  for (const [id, part] of currentById) {
    const finding = reportById.get(id);
    if (!finding || finding.ref !== part.name) throw new Error(`The loaded report is stale for exact current part ${JSON.stringify(part.name)}. Reload it.`);
  }
  const expectedSummary = {
    total: report.parts.length,
    incomplete: report.parts.filter((part) => part.status === 'incomplete').length,
    declared: report.parts.filter((part) => part.status === 'declared').length,
    conflict: report.parts.filter((part) => part.status === 'conflict').length,
    evidenced: report.parts.filter((part) => part.status === 'evidenced').length,
  };
  for (const key of ['total', ...PART_TRUST_SPOTLIGHT_STATUSES] as const) {
    if (report.summary[key] !== expectedSummary[key]) throw new Error(`The loaded report summary is inconsistent for ${key}. Reload it.`);
  }
  const selected = new Set(statuses);
  const findings = report.parts
    .filter((finding) => selected.has(finding.status))
    .map((finding): PartTrustSpotlightFinding => ({
      sourceComponentId: finding.sourceComponentId,
      ref: finding.ref,
      status: finding.status,
      schematicComponentIds: projectedIds(elements, 'schematic_component', finding.sourceComponentId),
      pcbComponentIds: projectedIds(elements, 'pcb_component', finding.sourceComponentId),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId));
  const count = (status: PartEvidenceStatus) => findings.filter((finding) => finding.status === status).length;
  return {
    statuses,
    findings,
    counts: {
      total: findings.length,
      incomplete: count('incomplete'),
      declared: count('declared'),
      conflict: count('conflict'),
      evidenced: count('evidenced'),
      schematicMappedParts: findings.filter((finding) => finding.schematicComponentIds.length > 0).length,
      schematicRenderedElements: findings.reduce((sum, finding) => sum + finding.schematicComponentIds.length, 0),
      pcbMappedParts: findings.filter((finding) => finding.pcbComponentIds.length > 0).length,
      pcbRenderedElements: findings.reduce((sum, finding) => sum + finding.pcbComponentIds.length, 0),
      schematicUnmappedParts: findings.filter((finding) => finding.schematicComponentIds.length === 0).length,
      pcbUnmappedParts: findings.filter((finding) => finding.pcbComponentIds.length === 0).length,
    },
    evidenceFile: { ...report.evidenceFile },
    sourceSummary: { ...report.sourceSummary },
    sessionOnly: true,
    readOnly: true,
    sourceChanged: false,
    limitations: LIMITATIONS,
  };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function partTrustSpotlightDecorations(
  active: ActivePartTrustSpotlight | undefined,
  surface: 'schematic' | 'pcb',
): Array<{ selector: string; className: string }> {
  if (!active) return [];
  return active.result.findings.flatMap((finding) => {
    const ids = surface === 'schematic' ? finding.schematicComponentIds : finding.pcbComponentIds;
    const attribute = surface === 'schematic' ? 'data-schematic-component-id' : 'data-pcb-component-id';
    return ids.map((id) => ({
      selector: `[${attribute}="${escapeAttributeValue(id)}"]`,
      className: `es-part-trust-${finding.status}`,
    }));
  });
}
