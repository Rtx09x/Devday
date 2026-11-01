import type { AnyCircuitElement } from './circuitJson.ts';
import {
  buildConnectivityEvidence,
  escapeAttributeValue,
  MAX_CONNECTIVITY_EVIDENCE_MARKERS,
  MAX_CONNECTIVITY_EVIDENCE_PORTS,
  type ConnectivityEvidenceMode,
  type ConnectivityEvidencePoint,
} from './connectivityEvidence.ts';
import {
  advisorAgentTargetKey,
  MAX_ADVISOR_RELATED_REFS,
  MAX_ENDPOINTS_PER_NET,
  normalizeSelectionFact,
  resolveAdvisorAgentTarget,
  type AdvisorAgentTarget,
  type ResolvedAdvisorAgentTarget,
} from './selectionContext.ts';
import { MAX_AGENT_SELECTION_LENGTH } from '../agentSession.ts';
import { inspectEvaluatorDiagnostics } from './evaluatorDiagnostics.ts';
import type { ReadinessCheck } from './readiness.ts';
import type { LintFinding, NetSummary } from './circuitJson.ts';

export type AdvisorAffectedGeometryBasis =
  | 'related-refs'
  | 'unconnected-reviewable-ports'
  | 'global-zero-pcb-traces'
  | 'selected-net'
  | 'evaluator-diagnostics';

export type AdvisorAffectedGeometryRefusalReason =
  | 'stale-target'
  | 'ambiguous-target'
  | 'missing-component-ref'
  | 'ambiguous-component-ref'
  | 'missing-source-identity'
  | 'ambiguous-source-identity'
  | 'partial-routing-indeterminate'
  | 'evidence-limit-exceeded';

export interface AdvisorAffectedComponent {
  sourceComponentId: string;
  ref: string;
}

export interface AdvisorAffectedPort {
  sourcePortId: string;
  sourceComponentId: string;
  ref: string;
  port: string;
  selector?: string;
}

export interface AdvisorAffectedLogicalNet {
  connectivityKey: string;
  sourceTraceIds: string[];
  endpointSourcePortIds: string[];
}

export interface AdvisorEvaluatorDiagnosticLocation {
  diagnosticId: string;
  type: string;
  x: number;
  y: number;
  source: 'center' | 'component_center';
}

export interface AdvisorEvaluatorDiagnosticEvidence {
  total: number;
  presented: number;
  omitted: number;
  byType: Array<{ type: string; count: number }>;
  otherTypeDiagnostics: number;
  diagnosticIds: string[];
  diagnosticIdsOmitted: number;
  pcbComponentIds: string[];
  unresolvedIdentityLinks: number;
  locations: AdvisorEvaluatorDiagnosticLocation[];
  locationsOmitted: number;
}

export interface ResolvedAdvisorAffectedGeometry {
  state: 'resolved';
  targetKey: string;
  basis: AdvisorAffectedGeometryBasis;
  components: AdvisorAffectedComponent[];
  ports: AdvisorAffectedPort[];
  logicalNets: AdvisorAffectedLogicalNet[];
  pcbEndpoints: ConnectivityEvidencePoint[];
  overlayElements: AnyCircuitElement[];
  exactConnectivityMode?: Exclude<ConnectivityEvidenceMode, 'all'>;
  evaluatorDiagnostics?: AdvisorEvaluatorDiagnosticEvidence;
}

export type AdvisorAffectedGeometry =
  | ResolvedAdvisorAffectedGeometry
  | { state: 'empty'; targetKey: string; detail: string }
  | { state: 'refused'; targetKey: string; reason: AdvisorAffectedGeometryRefusalReason; detail: string };

export interface AdvisorAffectedGeometryLatest {
  checks: ReadinessCheck[];
  findings: LintFinding[];
  nets: NetSummary[];
  circuitJson: AnyCircuitElement[];
}

export interface AdvisorAffectedGeometryDecoration {
  selector: string;
  className:
    | 'es-advisor-affected-component'
    | 'es-advisor-affected-port'
    | 'es-advisor-affected-net'
    | 'es-advisor-affected-pcb-endpoint'
    | 'es-advisor-diagnostic-component'
    | 'es-advisor-diagnostic-marker';
}

export interface NetDetectiveStory {
  targetKey: string;
  label: string;
  endpointCount: number;
  endpoints: string[];
  endpointsOmitted: number;
  componentRefs: string[];
  componentRefsOmitted: number;
  uniquePcbEndpointCount: number;
  pcbEndpointCoverage: 'all' | 'some' | 'none';
  disclaimer: 'Source-level connectivity; no PCB copper/routing proof.';
}

export interface EvaluatorDiagnosticBeaconStory {
  targetKey: string;
  total: number;
  presented: number;
  omitted: number;
  types: Array<{ type: string; count: number }>;
  typesOmitted: number;
  refs: string[];
  refsOmitted: number;
  linkedPcbComponentCount: number;
  finiteLocationCount: number;
  finiteLocationsOmitted: number;
  unresolvedIdentityLinks: number;
  disclaimer: 'Exact native evaluator output; not comprehensive ERC/DRC/DFM or signoff.';
}

export const MAX_EVALUATOR_DIAGNOSTIC_VISUAL_COMPONENTS = 64;
export const MAX_EVALUATOR_DIAGNOSTIC_VISUAL_MARKERS = 32;
export const MAX_EVALUATOR_DIAGNOSTIC_STORY_TYPES = 8;
export const MAX_EVALUATOR_DIAGNOSTIC_STORY_REFS = 16;

const str = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const sortText = (values: string[]): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b));

function refused(
  targetKey: string,
  reason: AdvisorAffectedGeometryRefusalReason,
  detail: string,
): AdvisorAffectedGeometry {
  return { state: 'refused', targetKey, reason, detail };
}

function empty(targetKey: string, detail: string): AdvisorAffectedGeometry {
  return { state: 'empty', targetKey, detail };
}

function targetRefusal(targetKey: string, caught: unknown): AdvisorAffectedGeometry {
  const detail = caught instanceof Error ? caught.message : String(caught);
  return refused(targetKey, /ambiguous/i.test(detail) ? 'ambiguous-target' : 'stale-target', detail);
}

function exactMatches(
  elements: AnyCircuitElement[],
  type: string,
  field: string,
  value: string,
): AnyCircuitElement[] {
  return elements.filter((element) => element.type === type && element[field] === value);
}

function componentsFromPorts(
  targetKey: string,
  elements: AnyCircuitElement[],
  ports: AdvisorAffectedPort[],
): AdvisorAffectedComponent[] | AdvisorAffectedGeometry {
  const components = new Map<string, AdvisorAffectedComponent>();
  for (const port of ports) {
    const sourcePorts = exactMatches(elements, 'source_port', 'source_port_id', port.sourcePortId);
    if (sourcePorts.length !== 1) {
      return refused(
        targetKey,
        sourcePorts.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity',
        `Affected source port ${JSON.stringify(port.sourcePortId)} is ${sourcePorts.length === 0 ? 'missing' : 'ambiguous'} in the latest projection. Select the target again.`,
      );
    }
    const sourceComponents = exactMatches(elements, 'source_component', 'source_component_id', port.sourceComponentId);
    if (sourceComponents.length !== 1) {
      return refused(
        targetKey,
        sourceComponents.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity',
        `Owning source component ${JSON.stringify(port.sourceComponentId)} is ${sourceComponents.length === 0 ? 'missing' : 'ambiguous'} in the latest projection. Select the target again.`,
      );
    }
    components.set(port.sourceComponentId, { sourceComponentId: port.sourceComponentId, ref: port.ref });
  }
  return [...components.values()].sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId));
}

function advisorMarker(point: ConnectivityEvidencePoint, index: number): AnyCircuitElement[] {
  const half = 0.38;
  const prefix = `pcb-advisor-affected-endpoint-${index}`;
  return [
    { type: 'pcb_note_line', pcb_note_line_id: `${prefix}-a`, x1: point.x - half, y1: point.y - half, x2: point.x + half, y2: point.y + half, layer: 'top', stroke_width: 0.15, color: '#b995ff' },
    { type: 'pcb_note_line', pcb_note_line_id: `${prefix}-b`, x1: point.x - half, y1: point.y + half, x2: point.x + half, y2: point.y - half, layer: 'top', stroke_width: 0.15, color: '#b995ff' },
  ];
}

function evaluatorDiagnosticMarker(point: AdvisorEvaluatorDiagnosticLocation, index: number): AnyCircuitElement[] {
  const half = 0.46;
  const prefix = `pcb-advisor-evaluator-diagnostic-${index}`;
  return [
    { type: 'pcb_note_line', pcb_note_line_id: `${prefix}-a`, x1: point.x - half, y1: point.y - half, x2: point.x + half, y2: point.y + half, layer: 'top', stroke_width: 0.18, color: '#ff746c' },
    { type: 'pcb_note_line', pcb_note_line_id: `${prefix}-b`, x1: point.x - half, y1: point.y + half, x2: point.x + half, y2: point.y - half, layer: 'top', stroke_width: 0.18, color: '#ff746c' },
  ];
}

function deriveEvaluatorDiagnostics(
  targetKey: string,
  elements: AnyCircuitElement[],
): AdvisorAffectedGeometry {
  const report = inspectEvaluatorDiagnostics(elements);
  if (report.summary.total === 0) {
    return empty(targetKey, 'The latest successful projection has no native evaluator *_error elements.');
  }

  const components = new Map<string, AdvisorAffectedComponent>();
  const pcbComponentIds = new Set<string>();
  let unresolvedIdentityLinks = 0;
  let visualComponentsOmitted = 0;
  for (const diagnostic of report.diagnostics) {
    for (const sourceComponentId of diagnostic.sourceComponentIds) {
      const matches = exactMatches(elements, 'source_component', 'source_component_id', sourceComponentId);
      const ref = matches.length === 1 ? str(matches[0].name) : undefined;
      if (matches.length !== 1 || !ref) {
        unresolvedIdentityLinks += 1;
        continue;
      }
      if (!components.has(sourceComponentId)) {
        if (components.size < MAX_EVALUATOR_DIAGNOSTIC_VISUAL_COMPONENTS) {
          components.set(sourceComponentId, { sourceComponentId, ref });
        } else {
          visualComponentsOmitted += 1;
        }
      }
    }
    for (const pcbComponentId of diagnostic.pcbComponentIds) {
      const matches = exactMatches(elements, 'pcb_component', 'pcb_component_id', pcbComponentId);
      if (matches.length !== 1) {
        unresolvedIdentityLinks += 1;
        continue;
      }
      if (!pcbComponentIds.has(pcbComponentId)) {
        if (pcbComponentIds.size < MAX_EVALUATOR_DIAGNOSTIC_VISUAL_COMPONENTS) pcbComponentIds.add(pcbComponentId);
        else visualComponentsOmitted += 1;
      }
    }
  }

  const allLocations = report.diagnostics.flatMap((diagnostic) => diagnostic.location ? [{
    diagnosticId: diagnostic.id,
    type: diagnostic.type,
    ...diagnostic.location,
  }] : []);
  const locations = allLocations.slice(0, MAX_EVALUATOR_DIAGNOSTIC_VISUAL_MARKERS);
  const diagnosticIds = report.diagnostics.slice(0, 24).map((diagnostic) => diagnostic.id);
  return {
    state: 'resolved',
    targetKey,
    basis: 'evaluator-diagnostics',
    components: [...components.values()].sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId)),
    ports: [],
    logicalNets: [],
    pcbEndpoints: [],
    overlayElements: locations.flatMap(evaluatorDiagnosticMarker),
    evaluatorDiagnostics: {
      total: report.summary.total,
      presented: report.summary.presented,
      omitted: report.summary.omitted,
      byType: report.summary.byType,
      otherTypeDiagnostics: report.summary.otherTypeDiagnostics,
      diagnosticIds,
      diagnosticIdsOmitted: report.diagnostics.length - diagnosticIds.length,
      pcbComponentIds: [...pcbComponentIds].sort((a, b) => a.localeCompare(b)),
      unresolvedIdentityLinks: unresolvedIdentityLinks + visualComponentsOmitted,
      locations,
      locationsOmitted: allLocations.length - locations.length,
    },
  };
}

function uniquePcbEndpoints(points: ConnectivityEvidencePoint[]): ConnectivityEvidencePoint[] {
  return [...new Map(points
    .slice()
    .sort((a, b) => a.sourcePortId.localeCompare(b.sourcePortId) || a.pcbPortId.localeCompare(b.pcbPortId))
    .map((point) => [point.pcbPortId, point])).values()];
}

function deriveUnconnected(
  targetKey: string,
  elements: AnyCircuitElement[],
): AdvisorAffectedGeometry {
  let evidence;
  try {
    evidence = buildConnectivityEvidence(elements, { mode: 'unconnected_ports' });
  } catch (caught) {
    return refused(targetKey, 'evidence-limit-exceeded', caught instanceof Error ? caught.message : String(caught));
  }
  if (evidence.result.unconnectedPorts.length === 0) {
    return empty(targetKey, 'The latest successful projection has no unconnected reviewable source ports.');
  }
  const ports = evidence.result.unconnectedPorts.map((port) => ({
    sourcePortId: port.sourcePortId,
    sourceComponentId: port.sourceComponentId,
    ref: port.ref,
    port: port.port,
    selector: port.selector,
  }));
  const components = componentsFromPorts(targetKey, elements, ports);
  if (!Array.isArray(components)) return components;
  const pcbEndpoints = uniquePcbEndpoints(evidence.result.unconnectedPorts.flatMap((port) => port.pcbPoint ? [port.pcbPoint] : []));
  return {
    state: 'resolved',
    targetKey,
    basis: 'unconnected-reviewable-ports',
    components,
    ports,
    logicalNets: [],
    pcbEndpoints,
    overlayElements: pcbEndpoints.flatMap(advisorMarker),
    exactConnectivityMode: 'unconnected_ports',
  };
}

function deriveGlobalRouting(
  targetKey: string,
  elements: AnyCircuitElement[],
): AdvisorAffectedGeometry {
  let evidence;
  try {
    evidence = buildConnectivityEvidence(elements, { mode: 'globally_unrouted_nets' });
  } catch (caught) {
    return refused(targetKey, 'evidence-limit-exceeded', caught instanceof Error ? caught.message : String(caught));
  }
  if (evidence.result.pcbTraceCount > 0) {
    return refused(
      targetKey,
      'partial-routing-indeterminate',
      'This evaluation contains PCB traces, so per-net unrouted attribution is indeterminate. No affected geometry was shown.',
    );
  }
  if (evidence.result.sourceTraceCount === 0 || evidence.result.unroutedNets.length === 0) {
    return empty(targetKey, 'The latest projection has no exact logical nets eligible for global-zero-PCB-trace evidence.');
  }
  const affectedPortIds = sortText(evidence.result.unroutedNets.flatMap((net) => net.endpointSourcePortIds));
  const ports: AdvisorAffectedPort[] = [];
  for (const sourcePortId of affectedPortIds) {
    const matches = exactMatches(elements, 'source_port', 'source_port_id', sourcePortId);
    if (matches.length !== 1) {
      return refused(
        targetKey,
        matches.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity',
        `Routing endpoint ${JSON.stringify(sourcePortId)} is ${matches.length === 0 ? 'missing' : 'ambiguous'} in the latest projection.`,
      );
    }
    const sourceComponentId = str(matches[0].source_component_id);
    if (!sourceComponentId) return refused(targetKey, 'missing-source-identity', `Routing endpoint ${JSON.stringify(sourcePortId)} has no exact owning source component.`);
    const componentMatches = exactMatches(elements, 'source_component', 'source_component_id', sourceComponentId);
    if (componentMatches.length !== 1) {
      return refused(
        targetKey,
        componentMatches.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity',
        `Routing endpoint owner ${JSON.stringify(sourceComponentId)} is ${componentMatches.length === 0 ? 'missing' : 'ambiguous'} in the latest projection.`,
      );
    }
    const ref = str(componentMatches[0].name) ?? sourceComponentId;
    const port = str(matches[0].name) ?? (matches[0].pin_number != null ? `pin${matches[0].pin_number}` : sourcePortId);
    ports.push({ sourcePortId, sourceComponentId, ref, port, selector: str(componentMatches[0].name) ? `.${ref} > .${port}` : undefined });
  }
  const components = componentsFromPorts(targetKey, elements, ports);
  if (!Array.isArray(components)) return components;
  const logicalNets: AdvisorAffectedLogicalNet[] = evidence.result.unroutedNets.map((net) => ({
    connectivityKey: net.connectivityKey,
    sourceTraceIds: sortText(net.sourceTraceIds),
    endpointSourcePortIds: sortText(net.endpointSourcePortIds),
  }));
  if (logicalNets.some((net) => net.sourceTraceIds.length === 0)) {
    return refused(targetKey, 'missing-source-identity', 'At least one affected logical net has no exact source_trace_id. No affected geometry was shown.');
  }
  const pcbEndpoints = uniquePcbEndpoints(evidence.result.unroutedNets.flatMap((net) => net.pcbEndpoints));
  return {
    state: 'resolved',
    targetKey,
    basis: 'global-zero-pcb-traces',
    components,
    ports,
    logicalNets,
    pcbEndpoints,
    overlayElements: pcbEndpoints.flatMap(advisorMarker),
    exactConnectivityMode: 'globally_unrouted_nets',
  };
}

function exactStringIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) return undefined;
  return value as string[];
}

function deriveSelectedNet(
  targetKey: string,
  net: NetSummary,
  elements: AnyCircuitElement[],
): AdvisorAffectedGeometry {
  const sourceTraceId = str(net.sourceTraceId);
  const connectivityKey = str(net.connectivityKey);
  const summaryPortIds = exactStringIds(net.endpointSourcePortIds);
  if (!sourceTraceId || !connectivityKey || !summaryPortIds || summaryPortIds.length === 0) {
    return refused(targetKey, 'missing-source-identity', 'The selected net lacks an exact source trace, connectivity key, or endpoint source-port identity. Select it again; no geometry was shown.');
  }
  if (new Set(summaryPortIds).size !== summaryPortIds.length) {
    return refused(targetKey, 'ambiguous-source-identity', 'The selected net repeats an endpoint source-port identity. No geometry was shown.');
  }
  if (summaryPortIds.length > MAX_CONNECTIVITY_EVIDENCE_PORTS) {
    return refused(targetKey, 'evidence-limit-exceeded', `The selected net has ${summaryPortIds.length} endpoints; narrow it to ${MAX_CONNECTIVITY_EVIDENCE_PORTS} or fewer.`);
  }
  const traceMatches = exactMatches(elements, 'source_trace', 'source_trace_id', sourceTraceId);
  if (traceMatches.length !== 1) {
    return refused(
      targetKey,
      traceMatches.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity',
      `Selected source trace ${JSON.stringify(sourceTraceId)} is ${traceMatches.length === 0 ? 'missing' : 'ambiguous'} in the latest projection. No geometry was shown.`,
    );
  }
  const trace = traceMatches[0];
  if (str(trace.subcircuit_connectivity_map_key) !== connectivityKey) {
    return refused(targetKey, 'stale-target', 'The selected net connectivity key changed in the latest projection. Select it again; no geometry was shown.');
  }
  const tracePortIds = exactStringIds(trace.connected_source_port_ids);
  if (!tracePortIds || tracePortIds.length === 0) {
    return refused(targetKey, 'missing-source-identity', 'The latest source trace has malformed or missing endpoint source-port identities. No geometry was shown.');
  }
  if (new Set(tracePortIds).size !== tracePortIds.length) {
    return refused(targetKey, 'ambiguous-source-identity', 'The latest source trace repeats an endpoint source-port identity. No geometry was shown.');
  }
  if (JSON.stringify(sortText(tracePortIds)) !== JSON.stringify(sortText(summaryPortIds))) {
    return refused(targetKey, 'stale-target', 'The selected net endpoint source-port membership changed. Select it again; no geometry was shown.');
  }

  const ports: AdvisorAffectedPort[] = [];
  const components = new Map<string, AdvisorAffectedComponent>();
  const pcbEndpoints: ConnectivityEvidencePoint[] = [];
  for (const sourcePortId of sortText(tracePortIds)) {
    const portMatches = exactMatches(elements, 'source_port', 'source_port_id', sourcePortId);
    if (portMatches.length !== 1) {
      return refused(targetKey, portMatches.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity', `Net endpoint ${JSON.stringify(sourcePortId)} is ${portMatches.length === 0 ? 'missing' : 'ambiguous'} in the latest projection. No geometry was shown.`);
    }
    const sourceComponentId = str(portMatches[0].source_component_id);
    if (!sourceComponentId) return refused(targetKey, 'missing-source-identity', `Net endpoint ${JSON.stringify(sourcePortId)} has no exact owning source component. No geometry was shown.`);
    const componentMatches = exactMatches(elements, 'source_component', 'source_component_id', sourceComponentId);
    if (componentMatches.length !== 1) {
      return refused(targetKey, componentMatches.length === 0 ? 'missing-source-identity' : 'ambiguous-source-identity', `Net endpoint owner ${JSON.stringify(sourceComponentId)} is ${componentMatches.length === 0 ? 'missing' : 'ambiguous'} in the latest projection. No geometry was shown.`);
    }
    const schematicMatches = exactMatches(elements, 'schematic_component', 'source_component_id', sourceComponentId);
    if (schematicMatches.length > 1) {
      return refused(targetKey, 'ambiguous-source-identity', `Net endpoint owner ${JSON.stringify(sourceComponentId)} has ambiguous schematic component identity. No geometry was shown.`);
    }
    const ref = str(componentMatches[0].name) ?? sourceComponentId;
    const portName = str(portMatches[0].name) ?? (portMatches[0].pin_number != null ? `pin${portMatches[0].pin_number}` : sourcePortId);
    ports.push({ sourcePortId, sourceComponentId, ref, port: portName, selector: str(componentMatches[0].name) ? `.${ref} > .${portName}` : undefined });
    components.set(sourceComponentId, { sourceComponentId, ref });

    const pcbMatches = exactMatches(elements, 'pcb_port', 'source_port_id', sourcePortId);
    if (pcbMatches.length === 1) {
      const pcbPortId = str(pcbMatches[0].pcb_port_id);
      const x = pcbMatches[0].x;
      const y = pcbMatches[0].y;
      if (pcbPortId && typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
        pcbEndpoints.push({ pcbPortId, sourcePortId, x, y });
      }
    }
  }
  if (components.size > MAX_CONNECTIVITY_EVIDENCE_PORTS || pcbEndpoints.length > MAX_CONNECTIVITY_EVIDENCE_MARKERS) {
    return refused(targetKey, 'evidence-limit-exceeded', 'The selected net exceeds the existing affected-geometry component or PCB endpoint cap. No geometry was shown.');
  }
  const pcbIdentityCounts = new Map<string, number>();
  for (const point of pcbEndpoints) {
    pcbIdentityCounts.set(point.pcbPortId, (pcbIdentityCounts.get(point.pcbPortId) ?? 0) + 1);
  }
  // A rendered PCB identity claimed by two selected source endpoints is not an
  // exact endpoint mapping. Keep the schematic projection, but suppress the
  // entire PCB marker set rather than presenting the remaining points as a
  // deceptively complete subset.
  const hasReusedPcbIdentity = [...pcbIdentityCounts.values()].some((count) => count !== 1);
  const exactPcbEndpoints = hasReusedPcbIdentity ? [] : uniquePcbEndpoints(pcbEndpoints);
  return {
    state: 'resolved',
    targetKey,
    basis: 'selected-net',
    components: [...components.values()].sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId)),
    ports,
    logicalNets: [{ connectivityKey, sourceTraceIds: [sourceTraceId], endpointSourcePortIds: sortText(tracePortIds) }],
    pcbEndpoints: exactPcbEndpoints,
    overlayElements: exactPcbEndpoints.flatMap(advisorMarker),
  };
}

function deriveRelatedRefs(
  targetKey: string,
  finding: LintFinding,
  elements: AnyCircuitElement[],
): AdvisorAffectedGeometry {
  const refs = sortText(Array.isArray(finding.relatedRefs)
    ? finding.relatedRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
    : []);
  if (refs.length === 0) return empty(targetKey, 'This finding has no exact related component refs.');
  const components: AdvisorAffectedComponent[] = [];
  for (const ref of refs) {
    const matches = exactMatches(elements, 'source_component', 'name', ref);
    if (matches.length !== 1) {
      return refused(
        targetKey,
        matches.length === 0 ? 'missing-component-ref' : 'ambiguous-component-ref',
        `Related ref ${JSON.stringify(ref)} is ${matches.length === 0 ? 'missing' : 'ambiguous'} in the latest successful projection. No affected geometry was shown.`,
      );
    }
    const sourceComponentId = str(matches[0].source_component_id);
    if (!sourceComponentId) return refused(targetKey, 'missing-source-identity', `Related ref ${JSON.stringify(ref)} has no exact source component ID.`);
    components.push({ sourceComponentId, ref });
  }
  return {
    state: 'resolved',
    targetKey,
    basis: 'related-refs',
    components: components.sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId)),
    ports: [],
    logicalNets: [],
    pcbEndpoints: [],
    overlayElements: [],
  };
}

export function isAdvisorAffectedGeometryTarget(resolved: ResolvedAdvisorAgentTarget): boolean {
  return resolved.kind === 'net'
    || resolved.kind === 'lint'
    || (resolved.kind === 'readiness' && (
      resolved.check.id === 'connectivity'
      || resolved.check.id === 'routing'
      || resolved.check.id === 'evaluator-diagnostics'
    ));
}

/** Derive fresh exact Advisor geometry without parsing finding/readiness prose or mutating input. */
export function deriveAdvisorAffectedGeometry(
  target: AdvisorAgentTarget,
  latest: AdvisorAffectedGeometryLatest,
): AdvisorAffectedGeometry {
  const targetKey = advisorAgentTargetKey(target);
  let resolved: ResolvedAdvisorAgentTarget;
  try {
    resolved = resolveAdvisorAgentTarget(target, latest);
  } catch (caught) {
    return targetRefusal(targetKey, caught);
  }
  if (resolved.kind === 'lint') {
    return resolved.finding.rule === 'unconnected-pin'
      ? deriveUnconnected(targetKey, latest.circuitJson)
      : deriveRelatedRefs(targetKey, resolved.finding, latest.circuitJson);
  }
  if (resolved.kind === 'readiness' && resolved.check.id === 'connectivity') {
    return deriveUnconnected(targetKey, latest.circuitJson);
  }
  if (resolved.kind === 'readiness' && resolved.check.id === 'routing') {
    return deriveGlobalRouting(targetKey, latest.circuitJson);
  }
  if (resolved.kind === 'readiness' && resolved.check.id === 'evaluator-diagnostics') {
    return deriveEvaluatorDiagnostics(targetKey, latest.circuitJson);
  }
  if (resolved.kind === 'net') return deriveSelectedNet(targetKey, resolved.net, latest.circuitJson);
  return empty(targetKey, 'This Advisor target does not expose affected geometry in this read-only slice.');
}

export function buildNetDetectiveStory(
  net: NetSummary,
  geometry: ResolvedAdvisorAffectedGeometry,
): NetDetectiveStory | undefined {
  if (geometry.basis !== 'selected-net') return undefined;
  const endpoints = net.endpoints.map((endpoint) => normalizeSelectionFact(endpoint, 160));
  const componentRefs = geometry.components.map((component) => normalizeSelectionFact(component.ref, 120));
  const visibleEndpoints = endpoints.slice(0, MAX_ENDPOINTS_PER_NET);
  const visibleRefs = componentRefs.slice(0, MAX_ADVISOR_RELATED_REFS);
  return {
    targetKey: geometry.targetKey,
    label: normalizeSelectionFact(net.name, 120),
    endpointCount: endpoints.length,
    endpoints: visibleEndpoints,
    endpointsOmitted: endpoints.length - visibleEndpoints.length,
    componentRefs: visibleRefs,
    componentRefsOmitted: componentRefs.length - visibleRefs.length,
    uniquePcbEndpointCount: geometry.pcbEndpoints.length,
    pcbEndpointCoverage: geometry.pcbEndpoints.length === 0 ? 'none' : geometry.pcbEndpoints.length === endpoints.length ? 'all' : 'some',
    disclaimer: 'Source-level connectivity; no PCB copper/routing proof.',
  };
}

export function buildEvaluatorDiagnosticBeaconStory(
  geometry: ResolvedAdvisorAffectedGeometry,
): EvaluatorDiagnosticBeaconStory | undefined {
  const evidence = geometry.evaluatorDiagnostics;
  if (geometry.basis !== 'evaluator-diagnostics' || !evidence) return undefined;
  const types = evidence.byType.slice(0, MAX_EVALUATOR_DIAGNOSTIC_STORY_TYPES);
  const refs = geometry.components
    .map((component) => normalizeSelectionFact(component.ref, 120))
    .slice(0, MAX_EVALUATOR_DIAGNOSTIC_STORY_REFS);
  return {
    targetKey: geometry.targetKey,
    total: evidence.total,
    presented: evidence.presented,
    omitted: evidence.omitted,
    types,
    typesOmitted: evidence.byType.length - types.length,
    refs,
    refsOmitted: geometry.components.length - refs.length,
    linkedPcbComponentCount: evidence.pcbComponentIds.length,
    finiteLocationCount: evidence.locations.length,
    finiteLocationsOmitted: evidence.locationsOmitted,
    unresolvedIdentityLinks: evidence.unresolvedIdentityLinks,
    disclaimer: 'Exact native evaluator output; not comprehensive ERC/DRC/DFM or signoff.',
  };
}

export function visibleAdvisorAffectedGeometry(
  result: AdvisorAffectedGeometry | undefined,
  lifecycle: {
    targetValid: boolean;
    sourceValid: boolean;
    fileValid: boolean;
    evaluationValid: boolean;
    appliedRevealAuthoritative: boolean;
  },
): ResolvedAdvisorAffectedGeometry | undefined {
  if (
    !lifecycle.targetValid
    || !lifecycle.sourceValid
    || !lifecycle.fileValid
    || !lifecycle.evaluationValid
    || lifecycle.appliedRevealAuthoritative
    || result?.state !== 'resolved'
  ) return undefined;
  return result;
}

export function advisorAffectedGeometryDecorations(
  geometry: ResolvedAdvisorAffectedGeometry | undefined,
  elements: AnyCircuitElement[],
  surface: 'schematic' | 'pcb',
): AdvisorAffectedGeometryDecoration[] {
  if (!geometry) return [];
  if (surface === 'pcb') {
    const endpointMarkers = geometry.pcbEndpoints.flatMap((_point, index) => ['a', 'b'].map((suffix) => ({
      selector: `[data-pcb-note-line-id="${escapeAttributeValue(`pcb-advisor-affected-endpoint-${index}-${suffix}`)}"]`,
      className: 'es-advisor-affected-pcb-endpoint' as const,
    })));
    const diagnosticMarkers = (geometry.evaluatorDiagnostics?.locations ?? []).flatMap((_point, index) => ['a', 'b'].map((suffix) => ({
      selector: `[data-pcb-note-line-id="${escapeAttributeValue(`pcb-advisor-evaluator-diagnostic-${index}-${suffix}`)}"]`,
      className: 'es-advisor-diagnostic-marker' as const,
    })));
    const diagnosticComponents = (geometry.evaluatorDiagnostics?.pcbComponentIds ?? []).map((id) => ({
      selector: `[data-pcb-component-id="${escapeAttributeValue(id)}"]`,
      className: 'es-advisor-diagnostic-component' as const,
    }));
    return [...endpointMarkers, ...diagnosticMarkers, ...diagnosticComponents];
  }
  const componentIds = new Set(geometry.components.map((component) => component.sourceComponentId));
  const componentSelectors = elements
    .filter((element) => element.type === 'schematic_component' && componentIds.has(str(element.source_component_id) ?? ''))
    .map((element) => str(element.schematic_component_id))
    .filter((id): id is string => Boolean(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      selector: `[data-schematic-component-id="${escapeAttributeValue(id)}"]`,
      className: geometry.basis === 'evaluator-diagnostics'
        ? 'es-advisor-diagnostic-component' as const
        : 'es-advisor-affected-component' as const,
    }));
  return [
    ...componentSelectors,
    ...geometry.ports.map((port) => ({
      selector: `[data-schematic-port-id="${escapeAttributeValue(port.sourcePortId)}"]`,
      className: 'es-advisor-affected-port' as const,
    })),
    ...geometry.logicalNets.map((net) => ({
      selector: `[data-subcircuit-connectivity-map-key="${escapeAttributeValue(net.connectivityKey)}"]`,
      className: 'es-advisor-affected-net' as const,
    })),
  ];
}

export function appendAdvisorAffectedGeometryContext(
  description: string,
  geometry: ResolvedAdvisorAffectedGeometry,
): string {
  const safe = (value: unknown) => normalizeSelectionFact(value);
  const components = geometry.components.slice(0, 24);
  const ports = geometry.ports.slice(0, 24);
  const logicalNets = geometry.logicalNets.slice(0, 12);
  const pcbEndpoints = geometry.pcbEndpoints.slice(0, 24);
  const evaluator = geometry.evaluatorDiagnostics;
  const lines = [
    '',
    'Exact affected-geometry projection (fresh Circuit JSON; diagnostic only):',
    `Basis: ${safe(geometry.basis)}`,
    `Exact affected refs: ${components.map((component) => `${safe(component.ref)} [${safe(component.sourceComponentId)}]`).join(', ') || 'none'}`,
    ...(geometry.components.length > components.length ? [`Affected refs omitted from prompt context: ${geometry.components.length - components.length}`] : []),
    ...ports.map((port) => `Affected port: ${safe(port.ref)}.${safe(port.port)} | source_port_id=${safe(port.sourcePortId)} | selector=${safe(port.selector ?? 'unavailable; do not guess')}`),
    ...(geometry.ports.length > ports.length ? [`Affected ports omitted from prompt context: ${geometry.ports.length - ports.length}`] : []),
    ...logicalNets.map((net) => `Affected logical net: key=${safe(net.connectivityKey)} | source_trace_ids=${net.sourceTraceIds.map(safe).join(',')} | endpoint_source_port_ids=${net.endpointSourcePortIds.map(safe).join(',')}`),
    ...(geometry.logicalNets.length > logicalNets.length ? [`Affected logical nets omitted from prompt context: ${geometry.logicalNets.length - logicalNets.length}`] : []),
    `Unique finite PCB port-coordinate endpoints: ${pcbEndpoints.map((point) => `${safe(point.sourcePortId)}@${point.x},${point.y} [${safe(point.pcbPortId)}]`).join('; ') || 'none; missing or ambiguous mappings remain schematic-only'}`,
    ...(geometry.pcbEndpoints.length > pcbEndpoints.length ? [`PCB endpoints omitted from prompt context: ${geometry.pcbEndpoints.length - pcbEndpoints.length}`] : []),
    ...(evaluator ? [
      `Native evaluator diagnostic counts: total=${evaluator.total} | presented=${evaluator.presented} | omitted=${evaluator.omitted}`,
      `Native evaluator diagnostic types: ${evaluator.byType.map((entry) => `${safe(entry.type)}=${entry.count}`).join(', ') || 'none'}`,
      ...(evaluator.otherTypeDiagnostics ? [`Diagnostics in additional types omitted by report cap: ${evaluator.otherTypeDiagnostics}`] : []),
      `Native evaluator diagnostic IDs: ${evaluator.diagnosticIds.map(safe).join(', ') || 'none'}`,
      ...(evaluator.diagnosticIdsOmitted ? [`Diagnostic IDs omitted from prompt context: ${evaluator.diagnosticIdsOmitted}`] : []),
      ...evaluator.locations.slice(0, 24).map((location) => `Native diagnostic location: id=${safe(location.diagnosticId)} | type=${safe(location.type)} | ${location.source}=${location.x},${location.y}`),
      ...(evaluator.locations.length > 24 || evaluator.locationsOmitted ? [`Diagnostic locations omitted from prompt context or visual cap: ${Math.max(0, evaluator.locations.length - 24) + evaluator.locationsOmitted}`] : []),
      `Unresolved or visually capped explicit diagnostic identity links: ${evaluator.unresolvedIdentityLinks}`,
      'Diagnostic messages are presentation-only and were not parsed for identity.',
    ] : []),
    'Uncertainty boundary: exact source identities and unique finite PCB port coordinates only. Do not infer PCB copper, per-net routing, physical pin validity, ERC/DRC, clearance, fabrication, or hardware correctness.',
  ];
  const combined = `${description}${lines.join('\n')}`;
  const suffix = '\n[Additional affected-geometry context omitted to enforce the hard selection limit.]';
  return boundUtf8(combined, MAX_AGENT_SELECTION_LENGTH, suffix);
}

function boundUtf8(value: string, maxBytes: number, suffix: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  const suffixBytes = encoder.encode(suffix).length;
  const prefixBudget = Math.max(0, maxBytes - suffixBytes);
  let prefix = '';
  let prefixBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (prefixBytes + characterBytes > prefixBudget) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}
