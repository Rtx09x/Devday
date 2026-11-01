import type { AnyCircuitElement } from './circuitJson.ts';
import {
  buildAssemblyHandoffReport,
  type AssemblyHandoffIssueCode,
  type AssemblyHandoffPart,
} from './assemblyHandoff.ts';

export const MAX_ASSEMBLY_METADATA_REF_BYTES = 160;
export const MAX_ASSEMBLY_METADATA_FOOTPRINT_BYTES = 256;
export const MAX_ASSEMBLY_METADATA_LCSC_BYTES = 32;
export const MAX_ASSEMBLY_METADATA_BATCH_UPDATES = 8;

export interface AssemblyMetadataPreviewRequest {
  ref: string;
  footprint?: string;
  lcscPartNumber?: string;
}

export interface ResolvedAssemblyMetadataProposal {
  request: Required<Pick<AssemblyMetadataPreviewRequest, 'ref'>> & Pick<AssemblyMetadataPreviewRequest, 'footprint' | 'lcscPartNumber'>;
  sourceComponentId: string;
  before: Pick<AssemblyHandoffPart, 'footprint' | 'lcscPartNumber' | 'placement' | 'issues' | 'readyForTemplate'>;
  nextSource: string;
}

export interface AssemblyMetadataBatchRequest { updates: AssemblyMetadataPreviewRequest[] }
export interface ResolvedAssemblyMetadataBatchProposal {
  updates: ResolvedAssemblyMetadataProposal[];
  nextSource: string;
}

export interface AssemblyMetadataAgentGrant {
  baseline: string;
  sourceComponentId: string;
  ref: string;
  allowedFields: Array<'footprint' | 'lcscPartNumber'>;
}

export interface AssemblyMetadataBatchAgentGrant {
  baseline: string;
  targets: Array<{
    sourceComponentId: string;
    ref: string;
    allowedFields: Array<'footprint' | 'lcscPartNumber'>;
  }>;
  consumed: boolean;
}

export interface AssemblyMetadataPreviewMetadata {
  ref: string;
  sourceComponentId: string;
  before: { footprint?: string; lcscPartNumber?: string };
  after: { footprint?: string; lcscPartNumber?: string };
  requested: { footprint?: string; lcscPartNumber?: string };
  resolvedIssues: AssemblyHandoffIssueCode[];
  remainingIssues: AssemblyHandoffIssueCode[];
  readyForTemplate: boolean;
  limitations: string[];
}

export interface AssemblyMetadataBatchPreviewMetadata {
  changes: AssemblyMetadataPreviewMetadata[];
  counts: { updates: number; resolvedIssues: number; remainingIssues: number; readyForTemplate: number };
  limitations: string[];
}

interface SourceElementMatch { start: number; end: number; text: string }

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function exactText(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} contains control characters.`);
  if (utf8Length(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  return value;
}

function scanSelfClosingElements(source: string): SourceElementMatch[] {
  const matches: SourceElementMatch[] = [];
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '<' || !/[A-Za-z]/.test(source[start + 1] ?? '')) continue;
    let quote: '"' | "'" | undefined;
    let braces = 0;
    for (let index = start + 1; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === quote && source[index - 1] !== '\\') quote = undefined;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '{') { braces++; continue; }
      if (char === '}') { if (braces > 0) braces--; continue; }
      if (char === '>' && braces === 0) {
        if (source[index - 1] === '/') matches.push({ start, end: index + 1, text: source.slice(start, index + 1) });
        start = index;
        break;
      }
    }
  }
  return matches;
}

function literalName(element: string): string | undefined {
  const match = /\bname\s*=\s*(["'])([^"']+)\1/.exec(element);
  return match?.[2];
}

function setLiteralAttribute(element: string, attribute: string, rawValue: string): string {
  const existing = new RegExp(`\\s${attribute}\\s*=\\s*(["'])[^"']*\\1`);
  if (existing.test(element)) return element.replace(existing, ` ${attribute}=${rawValue}`);
  return element.replace(/\s*\/>$/, ` ${attribute}=${rawValue} />`);
}

function exactTarget(report: ReturnType<typeof buildAssemblyHandoffReport>, ref: string): AssemblyHandoffPart {
  const candidates = report.parts.filter((part) => part.ref === ref);
  if (candidates.length !== 1) throw new Error(`Assembly metadata requires exactly one evaluated source part named "${ref}".`);
  return candidates[0];
}

function issueCodes(part: AssemblyHandoffPart): AssemblyHandoffIssueCode[] {
  return part.issues.map((issue) => issue.code).sort();
}

export function prepareAssemblyMetadataProposal(
  source: string,
  elements: AnyCircuitElement[],
  raw: AssemblyMetadataPreviewRequest,
): ResolvedAssemblyMetadataProposal {
  const ref = exactText(raw?.ref, 'ref', MAX_ASSEMBLY_METADATA_REF_BYTES)!;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(ref)) throw new Error('ref must be a case-sensitive JSX-safe ref designator.');
  const footprint = exactText(raw?.footprint, 'footprint', MAX_ASSEMBLY_METADATA_FOOTPRINT_BYTES);
  const lcscPartNumber = exactText(raw?.lcscPartNumber, 'lcscPartNumber', MAX_ASSEMBLY_METADATA_LCSC_BYTES);
  if (!footprint && !lcscPartNumber) throw new Error('Provide a missing footprint and/or LCSC part number to preview.');
  if (footprint && !/^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/.test(footprint)) {
    throw new Error('footprint must use the bounded literal footprinter-token form supported by this proposal.');
  }
  if (lcscPartNumber && !/^C[1-9][0-9]{0,14}$/.test(lcscPartNumber)) {
    throw new Error('lcscPartNumber must use the exact C-prefixed numeric LCSC form, for example C25804.');
  }

  const beforeReport = buildAssemblyHandoffReport(elements);
  const target = exactTarget(beforeReport, ref);
  const beforeIssues = new Set(issueCodes(target));
  if (footprint && !beforeIssues.has('missing-footprint')) {
    throw new Error(`${ref} does not have the supported missing-footprint blocker; conflicting or existing footprints are refused.`);
  }
  if (lcscPartNumber && !beforeIssues.has('missing-lcsc-part-number')) {
    throw new Error(`${ref} does not have the supported missing-LCSC blocker; ambiguous or existing supplier identifiers are refused.`);
  }

  const boardStarts = [...source.matchAll(/<board\b/g)].map((match) => match.index);
  const boardEnds = [...source.matchAll(/<\/board\s*>/g)].map((match) => match.index);
  if (boardStarts.length !== 1 || boardEnds.length !== 1 || boardStarts[0] >= boardEnds[0]) {
    throw new Error('Assembly metadata requires exactly one explicit non-self-closing JSX board.');
  }
  const sourceMatches = scanSelfClosingElements(source).filter((match) => literalName(match.text) === ref
    && match.start > boardStarts[0] && match.end <= boardEnds[0]);
  if (sourceMatches.length !== 1) {
    throw new Error(`Assembly metadata requires exactly one direct self-closing JSX source element named "${ref}".`);
  }
  let nextElement = sourceMatches[0].text;
  if (footprint) {
    if (/\bfootprint\s*=/.test(nextElement)) throw new Error('The source already declares footprint; v1 refuses conflicting or expression-valued replacement.');
    nextElement = setLiteralAttribute(nextElement, 'footprint', JSON.stringify(footprint));
  }
  if (lcscPartNumber) {
    if (/\bsupplierPartNumbers\s*=/.test(nextElement)) {
      throw new Error('The source already declares supplierPartNumbers; v1 refuses merging or replacing supplier maps.');
    }
    nextElement = setLiteralAttribute(nextElement, 'supplierPartNumbers', `{{ lcsc: [${JSON.stringify(lcscPartNumber)}] }}`);
  }
  const nextSource = `${source.slice(0, sourceMatches[0].start)}${nextElement}${source.slice(sourceMatches[0].end)}`;
  if (nextSource === source) throw new Error('The requested assembly metadata is already present.');
  return {
    request: { ref, ...(footprint ? { footprint } : {}), ...(lcscPartNumber ? { lcscPartNumber } : {}) },
    sourceComponentId: target.sourceComponentId,
    before: {
      ...(target.footprint ? { footprint: target.footprint } : {}),
      ...(target.lcscPartNumber ? { lcscPartNumber: target.lcscPartNumber } : {}),
      ...(target.placement ? { placement: target.placement } : {}),
      issues: target.issues,
      readyForTemplate: target.readyForTemplate,
    },
    nextSource,
  };
}

export function prepareAssemblyMetadataBatchProposal(
  source: string,
  elements: AnyCircuitElement[],
  raw: AssemblyMetadataBatchRequest,
): ResolvedAssemblyMetadataBatchProposal {
  if (!raw || !Array.isArray(raw.updates) || raw.updates.length < 1 || raw.updates.length > MAX_ASSEMBLY_METADATA_BATCH_UPDATES) {
    throw new Error(`Assembly Fix Queue requires 1-${MAX_ASSEMBLY_METADATA_BATCH_UPDATES} updates.`);
  }
  const refs = raw.updates.map((update) => typeof update?.ref === 'string' ? update.ref : '');
  if (new Set(refs).size !== refs.length) throw new Error('Assembly Fix Queue requires unique exact refs.');
  let nextSource = source;
  const updates: ResolvedAssemblyMetadataProposal[] = [];
  for (const update of raw.updates) {
    const proposal = prepareAssemblyMetadataProposal(nextSource, elements, update);
    updates.push(proposal);
    nextSource = proposal.nextSource;
  }
  return { updates, nextSource };
}

export function createAssemblyMetadataAgentGrant(
  baseline: string,
  elements: AnyCircuitElement[],
  sourceComponentId: string,
  ref: string,
): AssemblyMetadataAgentGrant {
  const target = buildAssemblyHandoffReport(elements).parts.filter((part) => part.sourceComponentId === sourceComponentId && part.ref === ref);
  if (target.length !== 1) throw new Error('Fix assembly blocker requires one exact current report row for the selected part.');
  const codes = new Set(issueCodes(target[0]));
  const allowedFields: AssemblyMetadataAgentGrant['allowedFields'] = [];
  if (codes.has('missing-footprint')) allowedFields.push('footprint');
  if (codes.has('missing-lcsc-part-number')) allowedFields.push('lcscPartNumber');
  if (allowedFields.length === 0) {
    throw new Error('The selected part has no supported missing-footprint or missing-LCSC blocker. No request was sent.');
  }
  return { baseline, sourceComponentId, ref, allowedFields };
}

export function validateAssemblyMetadataAgentGrant(
  grant: AssemblyMetadataAgentGrant,
  currentSource: string,
  proposal: ResolvedAssemblyMetadataProposal,
): void {
  if (grant.baseline !== currentSource) throw new Error('The source changed after the assembly-fix request began. Select the intent again.');
  if (grant.sourceComponentId !== proposal.sourceComponentId || grant.ref !== proposal.request.ref) {
    throw new Error('The assembly metadata proposal does not target the exact selected source component.');
  }
  const requested: AssemblyMetadataAgentGrant['allowedFields'] = [
    ...(proposal.request.footprint ? ['footprint' as const] : []),
    ...(proposal.request.lcscPartNumber ? ['lcscPartNumber' as const] : []),
  ];
  if (requested.some((field) => !grant.allowedFields.includes(field))) {
    throw new Error('The assembly metadata proposal includes a field that was not a supported current blocker.');
  }
}

export function createAssemblyMetadataBatchAgentGrant(
  baseline: string,
  elements: AnyCircuitElement[],
): AssemblyMetadataBatchAgentGrant {
  const targets = buildAssemblyHandoffReport(elements).parts.flatMap((part) => {
    const codes = new Set(issueCodes(part));
    const allowedFields: Array<'footprint' | 'lcscPartNumber'> = [];
    if (codes.has('missing-footprint')) allowedFields.push('footprint');
    if (codes.has('missing-lcsc-part-number')) allowedFields.push('lcscPartNumber');
    return allowedFields.length === 0 ? [] : [{
      sourceComponentId: part.sourceComponentId,
      ref: part.ref,
      allowedFields,
    }];
  });
  if (targets.length === 0) {
    throw new Error('The current sourcing report has no supported missing-footprint or missing-LCSC blockers. No request was sent.');
  }
  return { baseline, targets, consumed: false };
}

/** Consume the sole sourcing-request batch attempt before async evaluation starts. */
export function consumeAssemblyMetadataBatchAgentGrant(
  grant: AssemblyMetadataBatchAgentGrant,
  currentSource: string,
  proposal: ResolvedAssemblyMetadataBatchProposal,
): AssemblyMetadataBatchAgentGrant {
  if (grant.consumed) {
    throw new Error('The Assembly Fix Queue preview attempt was already consumed. Select Fix blockers again.');
  }
  if (grant.baseline !== currentSource) {
    throw new Error('The source changed after the Assembly Fix Queue request began. Select the sourcing check again.');
  }
  const targets = new Map(grant.targets.map((target) => [target.sourceComponentId, target]));
  for (const update of proposal.updates) {
    const target = targets.get(update.sourceComponentId);
    if (!target || target.ref !== update.request.ref) {
      throw new Error('The Assembly Fix Queue proposal targets a part outside the exact sourcing blockers authorized at Ask time.');
    }
    const requestedFields: Array<'footprint' | 'lcscPartNumber'> = [
      ...(update.request.footprint ? ['footprint' as const] : []),
      ...(update.request.lcscPartNumber ? ['lcscPartNumber' as const] : []),
    ];
    if (requestedFields.some((field) => !target.allowedFields.includes(field))) {
      throw new Error(`The Assembly Fix Queue proposal includes a field that was not a supported current blocker for ${target.ref}.`);
    }
  }
  return { ...grant, consumed: true };
}

function stableProjection(elements: AnyCircuitElement[], targetIds: Set<string>): string {
  const included = elements.filter((element) => ['source_component', 'source_port', 'source_trace', 'pcb_component'].includes(String(element.type)));
  const normalized = included.map((element) => {
    const copy = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
    if (copy.type === 'source_component' && targetIds.has(String(copy.source_component_id))) {
      delete copy.footprint;
      delete copy.supplier_part_numbers;
    }
    if (copy.type === 'pcb_component') {
      return {
        type: copy.type,
        pcb_component_id: copy.pcb_component_id,
        source_component_id: copy.source_component_id,
        center: copy.center,
        x: copy.x,
        y: copy.y,
        layer: copy.layer,
        rotation: copy.rotation,
        positioned_relative_to_pcb_board_id: copy.positioned_relative_to_pcb_board_id,
      };
    }
    return copy;
  });
  return JSON.stringify(normalized);
}

function buildTargetPreview(
  before: AssemblyHandoffPart,
  after: AssemblyHandoffPart,
  proposal: ResolvedAssemblyMetadataProposal,
): AssemblyMetadataPreviewMetadata {
  if (before.sourceComponentId !== proposal.sourceComponentId || after.sourceComponentId !== proposal.sourceComponentId) {
    throw new Error('Assembly metadata proposal changed the exact source-component identity.');
  }
  if (JSON.stringify(before.placement) !== JSON.stringify(after.placement)) throw new Error('Assembly metadata proposal changed the target PCB placement.');
  if (proposal.request.footprint && !after.footprint) {
    throw new Error('Evaluated assembly metadata does not contain one exact resolved footprint for the requested source literal.');
  }
  if (proposal.request.lcscPartNumber && after.lcscPartNumber !== proposal.request.lcscPartNumber) {
    throw new Error('Evaluated assembly metadata does not contain the exact requested LCSC part number.');
  }
  const beforeCodes = issueCodes(before);
  const afterCodes = issueCodes(after);
  const allowedResolved = new Set<AssemblyHandoffIssueCode>([
    ...(proposal.request.footprint ? ['missing-footprint' as const] : []),
    ...(proposal.request.lcscPartNumber ? ['missing-lcsc-part-number' as const] : []),
  ]);
  const resolvedIssues = beforeCodes.filter((code) => !afterCodes.includes(code));
  const addedIssues = afterCodes.filter((code) => !beforeCodes.includes(code));
  if (addedIssues.length > 0 || resolvedIssues.some((code) => !allowedResolved.has(code))
    || [...allowedResolved].some((code) => !resolvedIssues.includes(code))) {
    throw new Error('Assembly metadata proposal changed unexpected blocker evidence.');
  }
  return {
    ref: after.ref,
    sourceComponentId: after.sourceComponentId,
    before: { ...(before.footprint ? { footprint: before.footprint } : {}), ...(before.lcscPartNumber ? { lcscPartNumber: before.lcscPartNumber } : {}) },
    after: { ...(after.footprint ? { footprint: after.footprint } : {}), ...(after.lcscPartNumber ? { lcscPartNumber: after.lcscPartNumber } : {}) },
    requested: { ...(proposal.request.footprint ? { footprint: proposal.request.footprint } : {}), ...(proposal.request.lcscPartNumber ? { lcscPartNumber: proposal.request.lcscPartNumber } : {}) },
    resolvedIssues,
    remainingIssues: afterCodes,
    readyForTemplate: after.readyForTemplate,
    limitations: [
      'This preview proves only exact evaluated metadata and installed JLC-style text-template completeness for this source snapshot.',
      'It does not verify that the footprint and LCSC number match each other or the physical part, nor prove authenticity, stock, price, orderability, current portal acceptance, ERC, DRC, DFM, fabrication, assembly, or hardware.',
    ],
  };
}

export function buildAssemblyMetadataBatchPreview(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
  proposal: ResolvedAssemblyMetadataBatchProposal,
): AssemblyMetadataBatchPreviewMetadata {
  const evaluatedErrors = afterElements.filter((element) => typeof element.type === 'string' && element.type.endsWith('_error'));
  if (evaluatedErrors.length > 0) throw new Error('Assembly metadata proposal produced evaluated error elements.');
  const beforeReport = buildAssemblyHandoffReport(beforeElements);
  const afterReport = buildAssemblyHandoffReport(afterElements);
  const targetIds = new Set(proposal.updates.map((update) => update.sourceComponentId));
  if (targetIds.size !== proposal.updates.length) throw new Error('Assembly Fix Queue requires unique exact source-component identities.');
  if (stableProjection(beforeElements, targetIds) !== stableProjection(afterElements, targetIds)) {
    throw new Error('Assembly metadata proposal changed component, port, trace, or PCB-placement evidence beyond the requested metadata.');
  }
  const otherBefore = beforeReport.parts.filter((part) => !targetIds.has(part.sourceComponentId));
  const otherAfter = afterReport.parts.filter((part) => !targetIds.has(part.sourceComponentId));
  if (JSON.stringify(otherBefore) !== JSON.stringify(otherAfter)) throw new Error('Assembly metadata proposal changed another assembly-handoff part.');
  const changes = proposal.updates.map((update) => buildTargetPreview(
    exactTarget(beforeReport, update.request.ref),
    exactTarget(afterReport, update.request.ref),
    update,
  ));
  return {
    changes,
    counts: {
      updates: changes.length,
      resolvedIssues: changes.reduce((total, change) => total + change.resolvedIssues.length, 0),
      remainingIssues: changes.reduce((total, change) => total + change.remainingIssues.length, 0),
      readyForTemplate: changes.filter((change) => change.readyForTemplate).length,
    },
    limitations: changes[0]?.limitations ?? [],
  };
}

export function buildAssemblyMetadataPreview(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
  proposal: ResolvedAssemblyMetadataProposal,
): AssemblyMetadataPreviewMetadata {
  return buildAssemblyMetadataBatchPreview(beforeElements, afterElements, { updates: [proposal], nextSource: proposal.nextSource }).changes[0];
}
