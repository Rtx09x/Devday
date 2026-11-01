import {
  describePlacedPart,
  listComponents,
  listNets,
  type AnyCircuitElement,
  type ComponentSummary,
  type LintFinding,
  type NetSummary,
} from './circuitJson.ts';
import type { ReadinessCheck } from './readiness.ts';
import { MAX_AGENT_SELECTION_LENGTH } from '../agentSession.ts';
import {
  getProjectTemplate,
  projectTemplateContractLines,
  PROJECT_TEMPLATE_REQUIRED_FIELDS,
  XIAO_I2C_TEMPLATE_ID,
  type ProjectTemplateId,
} from './projectTemplates.ts';

export interface SelectionEditorContext {
  label: string;
  description: string;
}

export interface SelectionEditorContextItem {
  id: string;
  label: string;
  description: string;
  icon: string;
  groupLabel: string;
  data?: unknown;
  includeData?: true;
}

export const SELECTION_FIELD_MAX_LENGTH = 240;
export const MAX_CONNECTED_PINS = 20;
export const MAX_UNCONNECTED_PINS = 16;
export const MAX_RELATED_NETS = 10;
export const MAX_ENDPOINTS_PER_NET = 10;
export const MAX_ADVISOR_RELATED_REFS = 16;
export const MAX_EDITOR_CONTEXT_ITEM_DESCRIPTION = 2_400;

export interface LintFindingIdentity {
  nativeId?: string;
  rule?: string;
  severity?: LintFinding['severity'];
  message?: string;
  relatedRefs?: string[];
  occurrence: number;
}

export type AdvisorAgentTarget =
  | { kind: 'readiness'; checkId: string }
  | { kind: 'lint'; identity: LintFindingIdentity }
  | {
      kind: 'net';
      name: string;
      endpointSignature: string;
      sourceTraceId?: string;
      connectivityKey?: string;
      endpointSourcePortSignature?: string;
    };

export type ResolvedAdvisorAgentTarget =
  | { kind: 'readiness'; check: ReadinessCheck }
  | { kind: 'lint'; finding: LintFinding; identity: LintFindingIdentity }
  | { kind: 'net'; net: NetSummary };

/** Normalize source-derived text to one inert line and mark any deterministic truncation. */
export function normalizeSelectionFact(value: unknown, maxLength = SELECTION_FIELD_MAX_LENGTH): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  const suffix = '… [truncated]';
  return `${normalized.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function formatBoundedCollection(
  values: string[],
  totalCount: number,
  omittedLabel: string,
  maxLength: number,
  separator = ', ',
): string {
  const kept = [...values];
  while (kept.length > 0) {
    const omitted = totalCount - kept.length;
    const notice = omitted > 0 ? `${kept.length ? separator : ''}[${omitted} ${omittedLabel} omitted]` : '';
    if (`${kept.join(separator)}${notice}`.length <= maxLength) return `${kept.join(separator)}${notice}`;
    kept.pop();
  }
  return `[${totalCount} ${omittedLabel} omitted]`;
}

function sortedExact(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string').slice().sort((a, b) => a.localeCompare(b))
    : [];
}

function lintIdentityBase(finding: LintFinding): Omit<LintFindingIdentity, 'occurrence'> {
  if (typeof finding.id === 'string' && finding.id) return { nativeId: finding.id };
  return {
    rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    relatedRefs: sortedExact(finding.relatedRefs),
  };
}

function lintIdentityBaseKey(identity: Omit<LintFindingIdentity, 'occurrence'>): string {
  return JSON.stringify(identity);
}

export function createLintAgentTarget(finding: LintFinding, findings: LintFinding[]): AdvisorAgentTarget {
  const index = findings.indexOf(finding);
  if (index < 0) throw new Error('The selected lint finding is not in the latest report. Select it again.');
  const base = lintIdentityBase(finding);
  if (base.nativeId) return { kind: 'lint', identity: { nativeId: base.nativeId, occurrence: 0 } };
  const key = lintIdentityBaseKey(base);
  const occurrence = findings.slice(0, index).filter((candidate) => lintIdentityBaseKey(lintIdentityBase(candidate)) === key).length;
  return { kind: 'lint', identity: { ...base, occurrence } };
}

export function createReadinessAgentTarget(check: ReadinessCheck): AdvisorAgentTarget {
  return { kind: 'readiness', checkId: check.id };
}

export function netEndpointSignature(endpoints: string[]): string {
  return JSON.stringify(sortedExact(endpoints));
}

export function createNetAgentTarget(net: NetSummary): AdvisorAgentTarget {
  return {
    kind: 'net',
    name: net.name,
    endpointSignature: netEndpointSignature(net.endpoints),
    ...(net.sourceTraceId ? { sourceTraceId: net.sourceTraceId } : {}),
    ...(net.connectivityKey ? { connectivityKey: net.connectivityKey } : {}),
    ...(Array.isArray(net.endpointSourcePortIds)
      ? { endpointSourcePortSignature: netEndpointSignature(net.endpointSourcePortIds) }
      : {}),
  };
}

export function advisorAgentTargetKey(target: AdvisorAgentTarget): string {
  return JSON.stringify(target);
}

/** Re-resolve a stored Advisor identity only against the latest exact report/projection. */
export function resolveAdvisorAgentTarget(
  target: AdvisorAgentTarget,
  latest: { checks: ReadinessCheck[]; findings: LintFinding[]; nets: NetSummary[] },
): ResolvedAdvisorAgentTarget {
  if (target.kind === 'readiness') {
    const matches = latest.checks.filter((check) => check.id === target.checkId);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? 'This readiness check changed or disappeared. Select it again; no request was sent.'
        : 'This readiness check is ambiguous in the latest report. Select it again; no request was sent.');
    }
    return { kind: 'readiness', check: matches[0] };
  }
  if (target.kind === 'net') {
    const named = latest.nets.filter((net) => net.name === target.name);
    if (named.length === 0) throw new Error('This net is missing from the latest projection. Select it again; no request was sent.');
    const endpointMatches = named.filter((net) => netEndpointSignature(net.endpoints) === target.endpointSignature);
    if (endpointMatches.length === 0) throw new Error('This net’s endpoints changed. Select it again; no request was sent.');
    const matches = endpointMatches.filter((net) => (
      (target.sourceTraceId == null || net.sourceTraceId === target.sourceTraceId)
      && (target.connectivityKey == null || net.connectivityKey === target.connectivityKey)
      && (target.endpointSourcePortSignature == null
        || (Array.isArray(net.endpointSourcePortIds)
          && netEndpointSignature(net.endpointSourcePortIds) === target.endpointSourcePortSignature))
    ));
    if (matches.length === 0) throw new Error('This net’s exact source identity changed. Select it again; no request was sent.');
    if (matches.length > 1) throw new Error('This net is ambiguous in the latest projection. Select it again; no request was sent.');
    return { kind: 'net', net: matches[0] };
  }
  if (target.identity.nativeId) {
    const matches = latest.findings.filter((finding) => finding.id === target.identity.nativeId);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? 'This finding changed or disappeared. Select it again; no request was sent.'
        : 'This finding is ambiguous in the latest lint report. Select it again; no request was sent.');
    }
    return { kind: 'lint', finding: matches[0], identity: target.identity };
  }
  const matches = latest.findings
    .map((finding) => ({ finding, target: createLintAgentTarget(finding, latest.findings) }))
    .filter(({ target: candidate }) => advisorAgentTargetKey(candidate) === advisorAgentTargetKey(target));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'This finding changed or disappeared. Select it again; no request was sent.'
      : 'This finding is ambiguous in the latest lint report. Select it again; no request was sent.');
  }
  return { kind: 'lint', finding: matches[0].finding, identity: target.identity };
}

/** Re-resolve an immutable source-component identity from the projection used to compose the snapshot. */
export function resolvePartFromLatestProjection(
  componentId: string,
  elements: AnyCircuitElement[],
): ComponentSummary {
  const part = listComponents(elements).find((candidate) => candidate.id === componentId);
  if (!part) throw new Error(`The selected source component no longer exists in the latest successful evaluation. Select it again; no request was sent.`);
  return part;
}

/** Build a deterministic, bounded task brief usable by the indicator or an explicit agent prompt. */
export function buildPartSelectionContext(
  part: ComponentSummary,
  elements: AnyCircuitElement[],
  options: { filePath: string; surface: 'schematic' | 'pcb' | '3d' | 'assembly' | 'bom' | 'code' | 'simulate'; editable: boolean },
): SelectionEditorContext {
  const placed = describePlacedPart(elements, part.name);
  const allRelatedNets = listNets(elements)
    .filter((net) => net.endpoints.some((endpoint) => endpoint.startsWith(`${part.name}.`)));
  const relatedNets = allRelatedNets.slice(0, MAX_RELATED_NETS);
  const allConnectedPins = placed?.pins.filter((pin) => pin.connected) ?? [];
  const connectedPins = allConnectedPins.slice(0, MAX_CONNECTED_PINS);
  const allUnconnectedPins = placed?.pins.filter((pin) => !pin.connected).map((pin) => pin.name) ?? [];
  const unconnectedPins = allUnconnectedPins.slice(0, MAX_UNCONNECTED_PINS);
  const safe = normalizeSelectionFact;
  const selectedName = safe(part.name);
  const connectedSummary = formatBoundedCollection(
    connectedPins.map((pin) => `${safe(pin.name, 120)}${pin.net ? ` (${safe(pin.net, 120)})` : ''}`),
    allConnectedPins.length,
    'connected pins',
    1_400,
  );
  const unconnectedSummary = formatBoundedCollection(
    unconnectedPins.map((pin) => safe(pin, 120)),
    allUnconnectedPins.length,
    'unconnected pins',
    900,
  );
  const relatedSummary = relatedNets.map((net) => {
    const endpoints = formatBoundedCollection(
      net.endpoints.slice(0, MAX_ENDPOINTS_PER_NET).map((endpoint) => safe(endpoint, 100)),
      net.endpoints.length,
      'endpoints',
      360,
      ' -> ',
    );
    return `${safe(net.name, 140)}: ${endpoints}`;
  });
  const relatedConnections = formatBoundedCollection(relatedSummary, allRelatedNets.length, 'related nets', 2_200, '; ');
  const facts = [
    `Selected part: ${selectedName}`,
    `Source component ID: ${safe(part.id)}`,
    `Active Electronics Studio surface: ${options.surface}`,
    `Circuit file: ${safe(options.filePath || '(untitled circuit)')}`,
    `Source mode: ${options.editable ? 'editable tscircuit TSX' : 'render-only Circuit JSON'}`,
    part.ftype ? `Type: ${safe(part.ftype)}` : undefined,
    part.value ? `Value: ${safe(part.value)}` : undefined,
    part.footprint ? `Footprint: ${safe(part.footprint)}` : undefined,
    allConnectedPins.length
      ? `Connected pins: ${connectedSummary}`
      : 'Connected pins: none detected',
    allUnconnectedPins.length ? `Unconnected pins: ${unconnectedSummary}` : undefined,
    allRelatedNets.length
      ? `Related connections: ${relatedConnections}`
      : 'Related connections: none detected',
    '',
    `This bounded snapshot refers to source component ID ${safe(part.id)} (${selectedName}). Truncated fields and omitted collection entries are marked above. Inspect the live circuit before changing it, use Electronics Studio tools for mutations, preserve tscircuit/Circuit JSON, and return high-impact edits through the preview/approval gate.`,
  ].filter((value): value is string => value !== undefined);
  const description = facts.join('\n');
  if (description.length > MAX_AGENT_SELECTION_LENGTH) {
    const suffix = '\n[Additional selection data omitted to enforce the hard snapshot limit.]';
    return {
      label: `Part: ${selectedName}`,
      description: `${description.slice(0, MAX_AGENT_SELECTION_LENGTH - suffix.length)}${suffix}`,
    };
  }
  return { label: `Part: ${selectedName}`, description };
}

/** Build one stable, bounded chip from the latest exact component projection. */
export function buildPartSelectionContextItem(
  part: ComponentSummary,
  elements: AnyCircuitElement[],
  options: { filePath: string; surface: 'schematic' | 'pcb' | '3d' | 'assembly' | 'bom' | 'code' | 'simulate'; editable: boolean },
): SelectionEditorContextItem {
  const context = buildPartSelectionContext(part, elements, options);
  const omittedSuffix = '\n[Additional component context omitted from this chip.]';
  const description = context.description.length <= MAX_EDITOR_CONTEXT_ITEM_DESCRIPTION
    ? context.description
    : `${context.description.slice(0, MAX_EDITOR_CONTEXT_ITEM_DESCRIPTION - omittedSuffix.length)}${omittedSuffix}`;
  return {
    id: `component:${normalizeSelectionFact(part.id, 480)}`,
    label: normalizeSelectionFact(part.name || part.id, 120),
    description,
    icon: 'memory',
    groupLabel: 'components',
    data: {
      sourceComponentId: normalizeSelectionFact(part.id),
      ref: normalizeSelectionFact(part.name),
      ...(part.ftype ? { type: normalizeSelectionFact(part.ftype) } : {}),
      ...(part.value ? { value: normalizeSelectionFact(part.value) } : {}),
      ...(part.footprint ? { footprint: normalizeSelectionFact(part.footprint) } : {}),
      surface: options.surface,
      filePath: normalizeSelectionFact(options.filePath, 600),
      editable: options.editable,
    },
    includeData: true,
  };
}

/** Resolve a multi-selection to one fresh chip per distinct current component. */
export function buildPartSelectionContextItems(
  parts: ComponentSummary[],
  selectedIds: string[],
  elements: AnyCircuitElement[],
  options: { filePath: string; surface: 'schematic' | 'pcb' | '3d' | 'assembly' | 'bom' | 'code' | 'simulate'; editable: boolean },
): SelectionEditorContextItem[] {
  const partsById = new Map(parts.map((part) => [part.id, part]));
  return [...new Set(selectedIds)].flatMap((componentId) => {
    const part = partsById.get(componentId);
    return part ? [buildPartSelectionContextItem(part, elements, options)] : [];
  });
}

/** Wrap an already bounded non-component selection (pin, Advisor row, template) as one chip. */
export function buildSelectionContextItem(
  id: string,
  context: SelectionEditorContext,
  options: { icon: string; groupLabel: string; data?: unknown },
): SelectionEditorContextItem {
  return {
    id: normalizeSelectionFact(id, 512),
    label: normalizeSelectionFact(context.label, 160),
    description: context.description,
    icon: options.icon,
    groupLabel: options.groupLabel,
    ...(options.data === undefined ? {} : { data: options.data, includeData: true as const }),
  };
}

export function buildFindingSelectionContext(
  finding: LintFinding,
  options: { filePath: string; editable: boolean },
): SelectionEditorContext {
  const safe = normalizeSelectionFact;
  const refs = sortedExact(finding.relatedRefs);
  const keptRefs = refs.slice(0, MAX_ADVISOR_RELATED_REFS).map((ref) => safe(ref, 120));
  return boundAdvisorContext({
    label: `Finding: ${safe(humanize(finding.rule), 120)}`,
    facts: [
      `Selected Electronics Studio finding: ${safe(humanize(finding.rule))}`,
      finding.id ? `Native finding ID: ${safe(finding.id)}` : undefined,
      `Rule: ${safe(finding.rule)}`,
      `Severity: ${safe(finding.severity)}`,
      `Finding: ${safe(finding.message, 1_200)}`,
      refs.length ? `Related refs: ${formatBoundedCollection(keptRefs, refs.length, 'related refs', 1_600)}` : undefined,
      `Circuit file: ${safe(options.filePath || '(untitled circuit)', 600)}`,
      `Source mode: ${options.editable ? 'editable tscircuit TSX' : 'render-only Circuit JSON'}`,
      '',
      'This brief refers exactly to this finding. Re-run electronics.lint and inspect the live circuit before proposing a fix. Explain uncertainty; use exact Electronics Studio mutation tools and the preview/approval gate for high-impact changes.',
    ],
  });
}

export function buildReadinessSelectionContext(
  check: ReadinessCheck,
  options: { filePath: string; editable: boolean },
): SelectionEditorContext {
  const safe = normalizeSelectionFact;
  return boundAdvisorContext({
    label: `Check: ${safe(check.title, 120)}`,
    facts: [
      `Selected Electronics Studio readiness check: ${safe(check.title)}`,
      `Check ID: ${safe(check.id)}`,
      `Category: ${safe(check.category)}`,
      `Status: ${safe(check.status)}`,
      `Evidence: ${safe(check.detail, 1_200)}`,
      check.action ? `Recommended action: ${safe(check.action, 1_200)}` : undefined,
      check.automaticAction ? `Fresh automatic action ID: ${safe(check.automaticAction.id)}` : undefined,
      `Circuit file: ${safe(options.filePath || '(untitled circuit)', 600)}`,
      `Source mode: ${options.editable ? 'editable tscircuit TSX' : 'render-only Circuit JSON'}`,
      '',
      'This brief refers exactly to this readiness check. Re-run electronics.readiness and inspect the live circuit before changing it. Do not call this full ERC/DRC; keep fixes narrow, inspectable, reversible, and preview high-impact changes.',
    ],
  });
}

export function buildNetSelectionContext(
  net: NetSummary,
  options: { filePath: string; editable: boolean; surface?: 'schematic' | 'pcb' | '3d' | 'assembly' | 'bom' | 'code' | 'simulate' },
): SelectionEditorContext {
  const safe = normalizeSelectionFact;
  const endpoints = sortedExact(net.endpoints);
  const keptEndpoints = endpoints.slice(0, MAX_ENDPOINTS_PER_NET).map((endpoint) => safe(endpoint, 160));
  const refs = [...new Set(endpoints.map((endpoint) => endpoint.split('.')[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return boundAdvisorContext({
    label: `Net: ${safe(net.name, 120)}`,
    facts: [
      `Selected Electronics Studio net/connection: ${safe(net.name)}`,
      `Endpoint signature: ${safe(netEndpointSignature(net.endpoints), 1_800)}`,
      `Exact source trace ID: ${safe(net.sourceTraceId ?? '(unavailable; do not guess)')}`,
      `Exact connectivity key: ${safe(net.connectivityKey ?? '(unavailable; do not guess)')}`,
      `Exact endpoint source-port IDs: ${net.endpointSourcePortIds?.length
        ? formatBoundedCollection(sortedExact(net.endpointSourcePortIds).slice(0, MAX_ENDPOINTS_PER_NET).map((id) => safe(id, 160)), net.endpointSourcePortIds.length, 'endpoint source-port IDs', 2_000)
        : '(unavailable; do not guess)'}`,
      `Endpoints: ${endpoints.length ? formatBoundedCollection(keptEndpoints, endpoints.length, 'endpoints', 2_000, ' -> ') : '(named net without resolved endpoints)'}`,
      refs.length ? `Resolved component refs: ${formatBoundedCollection(refs.slice(0, MAX_ADVISOR_RELATED_REFS).map((ref) => safe(ref, 120)), refs.length, 'component refs', 1_600)}` : undefined,
      `Circuit file: ${safe(options.filePath || '(untitled circuit)', 600)}`,
      `Active Electronics Studio surface: ${options.surface ?? 'schematic'}`,
      `Source mode: ${options.editable ? 'editable tscircuit TSX' : 'render-only Circuit JSON'}`,
      '',
      'This brief refers exactly to source-level net membership. Inspect both endpoint parts and their exact evaluated pins before proposing changes. It is not evidence of PCB routing, copper connectivity, ERC, DRC, clearance, fabrication readiness, or hardware correctness.',
    ],
  });
}

function boundAdvisorContext(options: { label: string; facts: Array<string | undefined> }): SelectionEditorContext {
  const description = options.facts.filter((value): value is string => value !== undefined).join('\n');
  if (description.length <= MAX_AGENT_SELECTION_LENGTH) return { label: options.label, description };
  const suffix = '\n[Additional selection data omitted to enforce the hard snapshot limit.]';
  return { label: options.label, description: `${description.slice(0, MAX_AGENT_SELECTION_LENGTH - suffix.length)}${suffix}` };
}

/** Bounded discoverability context; the tool schema remains the authoritative requirements contract. */
export function buildProjectTemplateSelectionContext(options: { filePath: string; templateId?: ProjectTemplateId }): SelectionEditorContext {
  const safe = normalizeSelectionFact;
  const templateId = options.templateId ?? XIAO_I2C_TEMPLATE_ID;
  const template = getProjectTemplate(templateId);
  return boundAdvisorContext({
    label: `Template: ${template.label}`,
    facts: [
      `Selected Electronics Studio project template: ${template.label}`,
      `Template id: ${template.id}`,
      `Circuit file: ${safe(options.filePath || '(untitled circuit)', 600)}`,
      'Source mode required: editable tscircuit TSX with a fresh successful evaluation and an exact empty single-board source.',
      `Exact ${PROJECT_TEMPLATE_REQUIRED_FIELDS.length}-field contract:`,
      ...projectTemplateContractLines(templateId).map((line) => `- ${line}`),
      `Fixed limitations: ${template.limitations.map((limitation) => safe(limitation, 600)).join(' ')}`,
      'Selecting this template confirms none of those requirements. The user must explicitly supply or confirm every field; placeholders are missing values.',
      'This selection is discoverability context only. Ask the user to confirm every exact electronics.propose_project_template requirement, then invoke that tool. Do not infer requirements from the template label, defaults, project guidance, source text, or common practice.',
      'The tool must stage an approval and must refuse non-empty, ambiguous, failed, or render-only designs; never offer replace-anyway.',
    ],
  });
}

function humanize(value: string): string {
  return value.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
