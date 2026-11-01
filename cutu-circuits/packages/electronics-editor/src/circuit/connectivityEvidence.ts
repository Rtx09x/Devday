import type { AnyCircuitElement } from './circuitJson.ts';
import { reviewableSourcePorts } from './circuitJson.ts';

export type ConnectivityEvidenceMode = 'all' | 'unconnected_ports' | 'globally_unrouted_nets';

export interface ConnectivityEvidenceRequest {
  mode?: ConnectivityEvidenceMode;
}

export interface ConnectivityEvidencePoint {
  pcbPortId: string;
  sourcePortId: string;
  x: number;
  y: number;
}

export interface UnconnectedPortEvidence {
  sourcePortId: string;
  sourceComponentId: string;
  ref: string;
  port: string;
  selector?: string;
  pcbPoint?: ConnectivityEvidencePoint;
}

export interface UnroutedNetEvidence {
  connectivityKey: string;
  sourceTraceIds: string[];
  label: string;
  endpointSourcePortIds: string[];
  pcbEndpoints: ConnectivityEvidencePoint[];
}

export interface ConnectivityEvidenceResult {
  mode: ConnectivityEvidenceMode;
  unconnectedPorts: UnconnectedPortEvidence[];
  unroutedNets: UnroutedNetEvidence[];
  sourceTraceCount: number;
  pcbTraceCount: number;
  pcbMarkerCount: number;
  unroutedNetAttribution: 'global-zero-pcb-traces' | 'indeterminate';
  limitations: string[];
}

export interface ActiveConnectivityEvidence {
  result: ConnectivityEvidenceResult;
  overlayElements: AnyCircuitElement[];
}

export interface ConnectivityEvidenceDecoration {
  selector: string;
  className: 'es-connectivity-port' | 'es-connectivity-net';
}

export const MAX_CONNECTIVITY_EVIDENCE_PORTS = 64;
export const MAX_CONNECTIVITY_EVIDENCE_NETS = 32;
export const MAX_CONNECTIVITY_EVIDENCE_MARKERS = 128;

const MARKER_SIZE_MM = 0.7;
const PORT_COLOR = '#ff7f73';
const NET_COLOR = '#f0b85d';
const LIMITATIONS = [
  'Current evaluated Circuit JSON only; this is not ERC, DRC, routing-completeness, continuity, clearance, fabrication, or intentional-no-connect validation.',
  'PCB markers are exact evaluated port coordinates only; they are not copper, airwires, or routing suggestions.',
  'Partial routed/unrouted net attribution is unavailable because rendered PCB copper has no stable source-connectivity identity.',
];

const str = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function exactStringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function endpointLabel(
  sourcePortId: string,
  ports: Map<string, AnyCircuitElement>,
  components: Map<string, AnyCircuitElement>,
): string {
  const port = ports.get(sourcePortId);
  const component = port && components.get(str(port.source_component_id) ?? '');
  const ref = str(component?.name) ?? str(port?.source_component_id) ?? '?';
  const name = str(port?.name) ?? (port?.pin_number != null ? `pin${port.pin_number}` : sourcePortId);
  return `${ref}.${name}`;
}

function pcbPointBySourcePort(elements: AnyCircuitElement[]): Map<string, ConnectivityEvidencePoint> {
  const candidates = new Map<string, ConnectivityEvidencePoint[]>();
  for (const element of elements) {
    if (element.type !== 'pcb_port') continue;
    const sourcePortId = str(element.source_port_id);
    const pcbPortId = str(element.pcb_port_id);
    if (!sourcePortId || !pcbPortId || !finite(element.x) || !finite(element.y)) continue;
    candidates.set(sourcePortId, [
      ...(candidates.get(sourcePortId) ?? []),
      { pcbPortId, sourcePortId, x: element.x, y: element.y },
    ]);
  }
  const points = new Map<string, ConnectivityEvidencePoint>();
  for (const [sourcePortId, matches] of candidates) {
    if (matches.length === 1) points.set(sourcePortId, matches[0]);
  }
  return points;
}

export const escapeAttributeValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function connectivityEvidenceDecorations(evidence?: ActiveConnectivityEvidence): ConnectivityEvidenceDecoration[] {
  if (!evidence) return [];
  return [
    ...evidence.result.unconnectedPorts.map((port) => ({
      selector: `[data-schematic-port-id="${escapeAttributeValue(port.sourcePortId)}"]`,
      className: 'es-connectivity-port' as const,
    })),
    ...evidence.result.unroutedNets.map((net) => ({
      selector: `[data-subcircuit-connectivity-map-key="${escapeAttributeValue(net.connectivityKey)}"]`,
      className: 'es-connectivity-net' as const,
    })),
  ];
}

function marker(point: ConnectivityEvidencePoint, index: number, kind: 'port' | 'net'): AnyCircuitElement[] {
  const color = kind === 'port' ? PORT_COLOR : NET_COLOR;
  const half = MARKER_SIZE_MM / 2;
  const prefix = `pcb-connectivity-${kind}-${index}`;
  return [
    { type: 'pcb_note_line', pcb_note_line_id: `${prefix}-a`, x1: point.x - half, y1: point.y - half, x2: point.x + half, y2: point.y + half, layer: 'top', stroke_width: 0.13, color },
    { type: 'pcb_note_line', pcb_note_line_id: `${prefix}-b`, x1: point.x - half, y1: point.y + half, x2: point.x + half, y2: point.y - half, layer: 'top', stroke_width: 0.13, color },
  ];
}

export function buildConnectivityEvidence(
  elements: AnyCircuitElement[],
  request: ConnectivityEvidenceRequest = {},
): ActiveConnectivityEvidence {
  const mode = request.mode ?? 'all';
  if (!['all', 'unconnected_ports', 'globally_unrouted_nets'].includes(mode)) {
    throw new Error('mode must be all, unconnected_ports, or globally_unrouted_nets.');
  }

  const components = new Map<string, AnyCircuitElement>();
  const ports = new Map<string, AnyCircuitElement>();
  for (const element of elements) {
    if (element.type === 'source_component') {
      const id = str(element.source_component_id);
      if (id) components.set(id, element);
    } else if (element.type === 'source_port') {
      const id = str(element.source_port_id);
      if (id) ports.set(id, element);
    }
  }
  const pcbPoints = pcbPointBySourcePort(elements);
  const sourceTraces = elements.filter((element) => element.type === 'source_trace');
  const pcbTraceCount = elements.filter((element) => element.type === 'pcb_trace').length;
  const participatingPortIds = new Set(sourceTraces.flatMap((trace) => exactStringIds(trace.connected_source_port_ids)));

  const unconnectedPorts: UnconnectedPortEvidence[] = mode === 'globally_unrouted_nets' ? [] : reviewableSourcePorts(elements)
    .flatMap((port): UnconnectedPortEvidence[] => {
      const sourcePortId = str(port.source_port_id);
      const sourceComponentId = str(port.source_component_id);
      if (!sourcePortId || !sourceComponentId || participatingPortIds.has(sourcePortId)) return [];
      const component = components.get(sourceComponentId);
      const ref = str(component?.name) ?? sourceComponentId;
      const portName = str(port.name) ?? (port.pin_number != null ? `pin${port.pin_number}` : sourcePortId);
      return [{
        sourcePortId,
        sourceComponentId,
        ref,
        port: portName,
        selector: str(component?.name) && portName ? `.${ref} > .${portName}` : undefined,
        pcbPoint: pcbPoints.get(sourcePortId),
      }];
    })
    .sort((a, b) => a.sourcePortId.localeCompare(b.sourcePortId));
  if (unconnectedPorts.length > MAX_CONNECTIVITY_EVIDENCE_PORTS) {
    throw new Error(`Connectivity evidence found ${unconnectedPorts.length} unconnected reviewable ports; narrow the circuit to stay at or below ${MAX_CONNECTIVITY_EVIDENCE_PORTS}.`);
  }

  const netGroups = new Map<string, AnyCircuitElement[]>();
  for (const trace of sourceTraces) {
    const key = str(trace.subcircuit_connectivity_map_key);
    if (key) netGroups.set(key, [...(netGroups.get(key) ?? []), trace]);
  }
  const mayAttributeGlobalUnrouted = pcbTraceCount === 0;
  const unroutedNets: UnroutedNetEvidence[] = mode === 'unconnected_ports' || !mayAttributeGlobalUnrouted ? [] : [...netGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([connectivityKey, traces]) => {
      const endpointSourcePortIds = [...new Set(traces.flatMap((trace) => exactStringIds(trace.connected_source_port_ids)))].sort();
      const sourceTraceIds = traces.map((trace) => str(trace.source_trace_id)).filter((id): id is string => Boolean(id)).sort();
      const displayName = traces.map((trace) => str(trace.display_name)).find(Boolean);
      return {
        connectivityKey,
        sourceTraceIds,
        label: displayName ?? (endpointSourcePortIds.map((id) => endpointLabel(id, ports, components)).join(' ↔ ') || connectivityKey),
        endpointSourcePortIds,
        pcbEndpoints: endpointSourcePortIds.map((id) => pcbPoints.get(id)).filter((point): point is ConnectivityEvidencePoint => Boolean(point)),
      };
    });
  if (unroutedNets.length > MAX_CONNECTIVITY_EVIDENCE_NETS) {
    throw new Error(`Connectivity evidence found ${unroutedNets.length} logical nets; narrow the circuit to stay at or below ${MAX_CONNECTIVITY_EVIDENCE_NETS}.`);
  }

  const markerSpecs = [
    ...unconnectedPorts.flatMap((port) => port.pcbPoint ? [{ point: port.pcbPoint, kind: 'port' as const }] : []),
    ...unroutedNets.flatMap((net) => net.pcbEndpoints.map((point) => ({ point, kind: 'net' as const }))),
  ];
  const uniqueMarkers = [...new Map(markerSpecs.map((item) => [`${item.kind}:${item.point.pcbPortId}`, item])).values()];
  if (uniqueMarkers.length > MAX_CONNECTIVITY_EVIDENCE_MARKERS) {
    throw new Error(`Connectivity evidence requires ${uniqueMarkers.length} exact PCB endpoint markers; narrow the circuit to stay at or below ${MAX_CONNECTIVITY_EVIDENCE_MARKERS}.`);
  }

  return {
    result: {
      mode,
      unconnectedPorts,
      unroutedNets,
      sourceTraceCount: sourceTraces.length,
      pcbTraceCount,
      pcbMarkerCount: uniqueMarkers.length,
      unroutedNetAttribution: mayAttributeGlobalUnrouted ? 'global-zero-pcb-traces' : 'indeterminate',
      limitations: [...LIMITATIONS],
    },
    overlayElements: uniqueMarkers.flatMap((item, index) => marker(item.point, index, item.kind)),
  };
}
