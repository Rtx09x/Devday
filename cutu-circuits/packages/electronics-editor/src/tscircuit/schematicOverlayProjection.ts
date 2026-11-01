import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import type { ActiveConnectivityEvidence } from '../circuit/connectivityEvidence.ts';
import type { ActivePartTrustSpotlight } from '../circuit/partTrustSpotlight.ts';
import type { ActiveAssemblyHandoffSpotlight } from '../circuit/assemblyHandoffSpotlight.ts';
import type { ResolvedAdvisorAffectedGeometry } from '../circuit/advisorAffectedGeometry.ts';
import type { CanvasFeedback, CanvasFeedbackKind } from '../sim/canvasFeedback.ts';

export interface SchematicOverlayProjectionInput {
  circuitJson: AnyCircuitElement[];
  selectedComponentId?: string;
  pairedComponentIds?: string[];
  connectivityEvidence?: ActiveConnectivityEvidence;
  partTrustSpotlight?: ActivePartTrustSpotlight;
  assemblyHandoffSpotlight?: ActiveAssemblyHandoffSpotlight;
  advisorAffectedGeometry?: ResolvedAdvisorAffectedGeometry;
  feedback?: CanvasFeedback | null;
  revealedComponentIds?: string[];
  revealedConnectivityKeys?: string[];
  selectedPortId?: string;
  pinTracePortIds?: string[];
  pinTraceConnectivityKey?: string;
  activeWirePortId?: string;
}

export interface SchematicOverlayProjection {
  circuitJson: AnyCircuitElement[];
  overlayElements: AnyCircuitElement[];
  revision: string;
}

interface SchematicComponentGeometry {
  schematicComponentId: string;
  sourceComponentId?: string;
  center: { x: number; y: number };
  width: number;
  height: number;
  subcircuitId?: string;
}

interface SchematicPortGeometry {
  sourcePortId: string;
  center: { x: number; y: number };
  subcircuitId?: string;
}

interface SchematicTraceGeometry {
  connectivityKey: string;
  edges: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
  subcircuitId?: string;
}

const PART_TRUST_COLORS = {
  incomplete: '#e6a93d',
  declared: '#7f8cff',
  conflict: '#ff5c62',
  evidenced: '#52c878',
} as const;

const ASSEMBLY_COLORS = {
  blocked: '#f06d4f',
  ready: '#4fc77a',
} as const;

const SIMULATION_COLORS: Record<CanvasFeedbackKind, string> = {
  'logical-on': '#ff8a5b',
  'logical-powered': '#42d8a5',
  'mcu-activity': '#56c7ff',
};

const COLORS = {
  selectedComponent: '#56c7ff',
  pair: '#9d7cff',
  connectivityPort: '#ff7f73',
  connectivityNet: '#f0b85d',
  advisorComponent: '#b995ff',
  advisorPort: '#ff81b0',
  advisorNet: '#6cd6ff',
  advisorDiagnostic: '#ff746c',
  reveal: '#9d7cff',
  selectedPin: '#ff81b0',
  pinPeer: '#50e2ff',
  pinNet: '#685dff',
  wireSource: '#ffb84d',
} as const;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

function point(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return finite(candidate.x) && finite(candidate.y) ? { x: candidate.x, y: candidate.y } : undefined;
}

function componentGeometry(elements: AnyCircuitElement[]): {
  byId: Map<string, SchematicComponentGeometry>;
  bySource: Map<string, SchematicComponentGeometry[]>;
} {
  const candidatesById = new Map<string, SchematicComponentGeometry[]>();
  const bySource = new Map<string, SchematicComponentGeometry[]>();
  for (const element of elements) {
    if (element.type !== 'schematic_component') continue;
    const schematicComponentId = string(element.schematic_component_id);
    const center = point(element.center);
    const size = element.size && typeof element.size === 'object' && !Array.isArray(element.size)
      ? element.size as Record<string, unknown>
      : undefined;
    if (!schematicComponentId || !center || !finite(size?.width) || size.width <= 0 || !finite(size.height) || size.height <= 0) continue;
    const geometry: SchematicComponentGeometry = {
      schematicComponentId,
      sourceComponentId: string(element.source_component_id),
      center,
      width: size.width,
      height: size.height,
      subcircuitId: string(element.subcircuit_id),
    };
    candidatesById.set(schematicComponentId, [...(candidatesById.get(schematicComponentId) ?? []), geometry]);
    if (geometry.sourceComponentId) {
      bySource.set(geometry.sourceComponentId, [...(bySource.get(geometry.sourceComponentId) ?? []), geometry]);
    }
  }
  const byId = new Map<string, SchematicComponentGeometry>();
  for (const [id, candidates] of candidatesById) if (candidates.length === 1) byId.set(id, candidates[0]);
  return { byId, bySource };
}

function portGeometry(elements: AnyCircuitElement[]): Map<string, SchematicPortGeometry> {
  const candidates = new Map<string, SchematicPortGeometry[]>();
  for (const element of elements) {
    if (element.type !== 'schematic_port') continue;
    const sourcePortId = string(element.source_port_id);
    const center = point(element.center);
    if (!sourcePortId || !center) continue;
    const geometry = { sourcePortId, center, subcircuitId: string(element.subcircuit_id) };
    candidates.set(sourcePortId, [...(candidates.get(sourcePortId) ?? []), geometry]);
  }
  const result = new Map<string, SchematicPortGeometry>();
  for (const [id, matches] of candidates) if (matches.length === 1) result.set(id, matches[0]);
  return result;
}

function traceGeometry(elements: AnyCircuitElement[]): Map<string, SchematicTraceGeometry[]> {
  const result = new Map<string, SchematicTraceGeometry[]>();
  for (const element of elements) {
    if (element.type !== 'schematic_trace') continue;
    const connectivityKey = string(element.subcircuit_connectivity_map_key);
    if (!connectivityKey || !Array.isArray(element.edges)) continue;
    const edges = element.edges.flatMap((edge): SchematicTraceGeometry['edges'] => {
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return [];
      const record = edge as Record<string, unknown>;
      const from = point(record.from);
      const to = point(record.to);
      return from && to ? [{ from, to }] : [];
    });
    if (edges.length === 0) continue;
    const geometry = { connectivityKey, edges, subcircuitId: string(element.subcircuit_id) };
    result.set(connectivityKey, [...(result.get(connectivityKey) ?? []), geometry]);
  }
  return result;
}

function projectionRevision(elements: AnyCircuitElement[]): string {
  const source = JSON.stringify(elements);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function projectSchematicOverlays(input: SchematicOverlayProjectionInput): SchematicOverlayProjection {
  const overlayElements: AnyCircuitElement[] = [];
  const components = componentGeometry(input.circuitJson);
  const ports = portGeometry(input.circuitJson);
  const traces = traceGeometry(input.circuitJson);
  let rectIndex = 0;
  let circleIndex = 0;
  let lineIndex = 0;

  const addComponentGeometry = (
    geometry: SchematicComponentGeometry | undefined,
    color: string,
    kind: string,
    padding: number,
    dashed = false,
  ) => {
    if (!geometry) return;
    overlayElements.push({
      type: 'schematic_rect',
      schematic_rect_id: `es-overlay-${kind}-rect-${rectIndex++}`,
      center: geometry.center,
      width: geometry.width + padding * 2,
      height: geometry.height + padding * 2,
      rotation: 0,
      stroke_width: 0.075,
      color,
      is_filled: false,
      is_dashed: dashed,
      ...(geometry.subcircuitId ? { subcircuit_id: geometry.subcircuitId } : {}),
    });
  };
  const addComponentIds = (ids: Iterable<string>, color: string, kind: string, padding: number, dashed = false) => {
    for (const id of new Set(ids)) addComponentGeometry(components.byId.get(id), color, kind, padding, dashed);
  };
  const addSourceComponentIds = (ids: Iterable<string>, color: string, kind: string, padding: number, dashed = false) => {
    for (const id of new Set(ids)) {
      for (const geometry of components.bySource.get(id) ?? []) addComponentGeometry(geometry, color, kind, padding, dashed);
    }
  };
  const addPortIds = (ids: Iterable<string>, color: string, kind: string, radius: number, dashed = false) => {
    for (const id of new Set(ids)) {
      const geometry = ports.get(id);
      if (!geometry) continue;
      overlayElements.push({
        type: 'schematic_circle',
        schematic_circle_id: `es-overlay-${kind}-circle-${circleIndex++}`,
        center: geometry.center,
        radius,
        stroke_width: 0.065,
        color,
        is_filled: false,
        is_dashed: dashed,
        ...(geometry.subcircuitId ? { subcircuit_id: geometry.subcircuitId } : {}),
      });
    }
  };
  const addConnectivityKeys = (keys: Iterable<string>, color: string, kind: string, dashed = false) => {
    for (const key of new Set(keys)) {
      for (const trace of traces.get(key) ?? []) {
        for (const edge of trace.edges) {
          overlayElements.push({
            type: 'schematic_line',
            schematic_line_id: `es-overlay-${kind}-line-${lineIndex++}`,
            x1: edge.from.x,
            y1: edge.from.y,
            x2: edge.to.x,
            y2: edge.to.y,
            stroke_width: 0.085,
            color,
            is_dashed: dashed,
            ...(trace.subcircuitId ? { subcircuit_id: trace.subcircuitId } : {}),
          });
        }
      }
    }
  };

  if (input.selectedComponentId) addSourceComponentIds([input.selectedComponentId], COLORS.selectedComponent, 'selected-component', 0.1);
  addSourceComponentIds(input.pairedComponentIds ?? [], COLORS.pair, 'pair', 0.18);

  addPortIds(
    input.connectivityEvidence?.result.unconnectedPorts.map((port) => port.sourcePortId) ?? [],
    COLORS.connectivityPort,
    'connectivity-port',
    0.18,
  );
  addConnectivityKeys(
    input.connectivityEvidence?.result.unroutedNets.map((net) => net.connectivityKey) ?? [],
    COLORS.connectivityNet,
    'connectivity-net',
    true,
  );

  for (const finding of input.partTrustSpotlight?.result.findings ?? []) {
    addComponentIds(finding.schematicComponentIds, PART_TRUST_COLORS[finding.status], `part-trust-${finding.status}`, 0.24, true);
  }
  for (const finding of input.assemblyHandoffSpotlight?.result.findings ?? []) {
    addComponentIds(finding.schematicComponentIds, ASSEMBLY_COLORS[finding.state], `assembly-${finding.state}`, 0.32, true);
  }

  if (input.advisorAffectedGeometry) {
    addSourceComponentIds(
      input.advisorAffectedGeometry.components.map((component) => component.sourceComponentId),
      input.advisorAffectedGeometry.basis === 'evaluator-diagnostics' ? COLORS.advisorDiagnostic : COLORS.advisorComponent,
      input.advisorAffectedGeometry.basis === 'evaluator-diagnostics' ? 'advisor-diagnostic' : 'advisor-component',
      0.4,
      true,
    );
    addPortIds(input.advisorAffectedGeometry.ports.map((port) => port.sourcePortId), COLORS.advisorPort, 'advisor-port', 0.25);
    addConnectivityKeys(input.advisorAffectedGeometry.logicalNets.map((net) => net.connectivityKey), COLORS.advisorNet, 'advisor-net');
  }

  for (const component of input.feedback?.components ?? []) {
    addSourceComponentIds([component.sourceComponentId], SIMULATION_COLORS[component.kind], `simulation-${component.kind}`, 0.48);
  }
  addPortIds(input.feedback?.sourcePortIds ?? [], SIMULATION_COLORS['mcu-activity'], 'simulation-port', 0.31);
  addConnectivityKeys(input.feedback?.connectivityKeys ?? [], SIMULATION_COLORS['mcu-activity'], 'simulation-net');

  addSourceComponentIds(input.revealedComponentIds ?? [], COLORS.reveal, 'reveal-component', 0.56);
  addConnectivityKeys(input.revealedConnectivityKeys ?? [], COLORS.reveal, 'reveal-net');

  if (input.selectedPortId) addPortIds([input.selectedPortId], COLORS.selectedPin, 'selected-pin', 0.37);
  addPortIds(input.pinTracePortIds ?? [], COLORS.pinPeer, 'pin-peer', 0.45, true);
  if (input.pinTraceConnectivityKey) addConnectivityKeys([input.pinTraceConnectivityKey], COLORS.pinNet, 'pin-net', true);
  if (input.activeWirePortId) addPortIds([input.activeWirePortId], COLORS.wireSource, 'wire-source', 0.53);

  const circuitJson = [...input.circuitJson, ...overlayElements];
  const revision = projectionRevision(circuitJson);
  Object.defineProperty(circuitJson, 'editCount', { value: revision, enumerable: false });
  return { circuitJson, overlayElements, revision };
}
