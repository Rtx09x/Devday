import type { ComponentProps } from 'react';
import type { PCBViewer } from '@tscircuit/pcb-viewer';
import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import type { ActivePcbGrid } from '../circuit/pcbGrid.ts';
import type { ActivePcbMeasurement } from '../circuit/pcbMeasurement.ts';
import type { ActivePcbRuleLens } from '../circuit/pcbRuleLens.ts';
import type { ActivePcbRouteProposal } from '../circuit/pcbRouteProposal.ts';
import type { ActiveConnectivityEvidence } from '../circuit/connectivityEvidence.ts';
import type { ActivePartTrustSpotlight } from '../circuit/partTrustSpotlight.ts';
import type { ActiveAssemblyHandoffSpotlight } from '../circuit/assemblyHandoffSpotlight.ts';
import type { ResolvedAdvisorAffectedGeometry } from '../circuit/advisorAffectedGeometry.ts';
import type { CanvasFeedback, CanvasFeedbackKind } from '../sim/canvasFeedback.ts';

export type PcbDebugGraphics = NonNullable<ComponentProps<typeof PCBViewer>['debugGraphics']>;
type DebugLine = NonNullable<PcbDebugGraphics['lines']>[number];
type DebugRect = NonNullable<PcbDebugGraphics['rects']>[number];
type DebugCircle = NonNullable<PcbDebugGraphics['circles']>[number];
type DebugArrow = NonNullable<PcbDebugGraphics['arrows']>[number];
type DebugText = NonNullable<PcbDebugGraphics['texts']>[number];

export interface PcbDebugGraphicsInput {
  circuitJson: AnyCircuitElement[];
  grid?: ActivePcbGrid;
  measurement?: ActivePcbMeasurement;
  ruleLens?: ActivePcbRuleLens;
  routeProposal?: ActivePcbRouteProposal;
  connectivityEvidence?: ActiveConnectivityEvidence;
  partTrustSpotlight?: ActivePartTrustSpotlight;
  assemblyHandoffSpotlight?: ActiveAssemblyHandoffSpotlight;
  advisorAffectedGeometry?: ResolvedAdvisorAffectedGeometry;
  feedback?: CanvasFeedback | null;
  revealedComponentIds?: string[];
  revealedConnectivityKeys?: string[];
  layoutComponentIds?: string[];
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

const REVEAL_COLOR = '#9d7cff';
const LAYOUT_COLOR = '#2dd4bf';
const ADVISOR_DIAGNOSTIC_COLOR = '#ff746c';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

function point(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return finite(record.x) && finite(record.y) ? { x: record.x, y: record.y } : undefined;
}

function addOverlayElements(
  elements: AnyCircuitElement[],
  target: { lines: DebugLine[]; arrows: DebugArrow[]; texts: DebugText[] },
): void {
  for (const element of elements) {
    if (element.type === 'pcb_note_line'
      && finite(element.x1) && finite(element.y1) && finite(element.x2) && finite(element.y2)) {
      target.lines.push({
        points: [{ x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }],
        strokeColor: string(element.color) ?? '#e3a84b',
        strokeWidth: finite(element.stroke_width) ? element.stroke_width : 0.1,
        ...(element.is_dashed === true ? { strokeDash: [0.28, 0.18] } : {}),
        ...(string(element.layer) ? { layer: string(element.layer) } : {}),
      });
      continue;
    }
    if (element.type === 'pcb_note_text') {
      const anchor = point(element.anchor_position);
      const text = string(element.text);
      if (!anchor || !text) continue;
      target.texts.push({
        ...anchor,
        text,
        color: string(element.color) ?? '#e3a84b',
        fontSize: finite(element.font_size) ? element.font_size : 0.65,
        ...(string(element.layer) ? { layer: string(element.layer) } : {}),
      });
      continue;
    }
    if (element.type === 'pcb_note_dimension') {
      const from = point(element.from);
      const to = point(element.to);
      if (!from || !to) continue;
      const color = string(element.color) ?? '#ffb84d';
      target.arrows.push({ start: from, end: to, doubleSided: true, color });
      const text = string(element.text);
      if (text) target.texts.push({
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2,
        text,
        anchorSide: 'bottom_center',
        color,
        fontSize: finite(element.font_size) ? element.font_size : 0.8,
      });
    }
  }
}

function pcbComponentRects(elements: AnyCircuitElement[]): Map<string, DebugRect> {
  const result = new Map<string, DebugRect>();
  for (const element of elements) {
    if (element.type !== 'pcb_component') continue;
    const id = string(element.pcb_component_id);
    const center = point(element.center);
    if (!id || !center || !finite(element.width) || element.width <= 0 || !finite(element.height) || element.height <= 0) continue;
    result.set(id, {
      center,
      width: element.width,
      height: element.height,
      ...(finite(element.rotation) ? { ccwRotationDegrees: element.rotation } : {}),
    });
  }
  return result;
}

function componentIdsBySource(elements: AnyCircuitElement[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const element of elements) {
    if (element.type !== 'pcb_component') continue;
    const sourceId = string(element.source_component_id);
    const pcbId = string(element.pcb_component_id);
    if (!sourceId || !pcbId) continue;
    result.set(sourceId, [...(result.get(sourceId) ?? []), pcbId]);
  }
  return result;
}

function pushComponentOutline(rects: DebugRect[], byId: Map<string, DebugRect>, id: string, color: string, label?: string): void {
  const geometry = byId.get(id);
  if (!geometry) return;
  rects.push({ ...geometry, fill: 'rgba(0,0,0,0)', stroke: color, color, ...(label ? { label } : {}) });
}

function pcbPortPoints(elements: AnyCircuitElement[]): Map<string, Array<{ x: number; y: number }>> {
  const result = new Map<string, Array<{ x: number; y: number }>>();
  for (const element of elements) {
    if (element.type !== 'pcb_port') continue;
    const sourcePortId = string(element.source_port_id);
    if (!sourcePortId || !finite(element.x) || !finite(element.y)) continue;
    result.set(sourcePortId, [...(result.get(sourcePortId) ?? []), { x: element.x, y: element.y }]);
  }
  return result;
}

function exactPortPoint(points: Map<string, Array<{ x: number; y: number }>>, sourcePortId: string): { x: number; y: number } | undefined {
  const matches = points.get(sourcePortId) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function connectivityPortIds(elements: AnyCircuitElement[], keys: Iterable<string>): string[] {
  const requested = new Set(keys);
  const result = new Set<string>();
  for (const element of elements) {
    if (element.type !== 'source_trace' || !requested.has(string(element.subcircuit_connectivity_map_key) ?? '')) continue;
    for (const id of Array.isArray(element.connected_source_port_ids) ? element.connected_source_port_ids : []) {
      if (typeof id === 'string' && id.length > 0) result.add(id);
    }
  }
  return [...result].sort();
}

function pushPortMarkers(
  circles: DebugCircle[],
  elements: AnyCircuitElement[],
  sourcePortIds: Iterable<string>,
  color: string,
  radius = 0.45,
): void {
  const points = pcbPortPoints(elements);
  for (const sourcePortId of sourcePortIds) {
    const center = exactPortPoint(points, sourcePortId);
    if (center) circles.push({ center, radius, fill: 'rgba(0,0,0,0)', stroke: color });
  }
}

export function projectPcbDebugGraphics(input: PcbDebugGraphicsInput): PcbDebugGraphics | null {
  const lines: DebugLine[] = [];
  const rects: DebugRect[] = [];
  const circles: DebugCircle[] = [];
  const arrows: DebugArrow[] = [];
  const texts: DebugText[] = [];
  const overlayTarget = { lines, arrows, texts };

  addOverlayElements(input.grid?.overlayElements ?? [], overlayTarget);
  addOverlayElements(input.routeProposal?.overlayElements ?? [], overlayTarget);
  addOverlayElements(input.ruleLens?.overlayElements ?? [], overlayTarget);
  addOverlayElements(input.measurement?.overlayElements ?? [], overlayTarget);
  addOverlayElements(input.connectivityEvidence?.overlayElements ?? [], overlayTarget);
  addOverlayElements(input.advisorAffectedGeometry?.overlayElements ?? [], overlayTarget);

  const geometryById = pcbComponentRects(input.circuitJson);
  const idsBySource = componentIdsBySource(input.circuitJson);

  for (const finding of input.partTrustSpotlight?.result.findings ?? []) {
    for (const id of finding.pcbComponentIds) {
      pushComponentOutline(rects, geometryById, id, PART_TRUST_COLORS[finding.status], `${finding.ref} · ${finding.status}`);
    }
  }
  for (const finding of input.assemblyHandoffSpotlight?.result.findings ?? []) {
    for (const id of finding.pcbComponentIds) {
      pushComponentOutline(rects, geometryById, id, ASSEMBLY_COLORS[finding.state], `${finding.ref} · ${finding.state}`);
    }
  }
  for (const id of input.advisorAffectedGeometry?.evaluatorDiagnostics?.pcbComponentIds ?? []) {
    pushComponentOutline(rects, geometryById, id, ADVISOR_DIAGNOSTIC_COLOR, 'Evaluator diagnostic');
  }
  for (const component of input.feedback?.components ?? []) {
    for (const id of idsBySource.get(component.sourceComponentId) ?? []) {
      pushComponentOutline(rects, geometryById, id, SIMULATION_COLORS[component.kind], component.label);
    }
  }
  for (const sourceId of input.revealedComponentIds ?? []) {
    for (const id of idsBySource.get(sourceId) ?? []) pushComponentOutline(rects, geometryById, id, REVEAL_COLOR, 'Agent change');
  }
  for (const sourceId of input.layoutComponentIds ?? []) {
    for (const id of idsBySource.get(sourceId) ?? []) pushComponentOutline(rects, geometryById, id, LAYOUT_COLOR, 'Layout Crew');
  }

  pushPortMarkers(circles, input.circuitJson, input.feedback?.sourcePortIds ?? [], SIMULATION_COLORS['mcu-activity']);
  pushPortMarkers(
    circles,
    input.circuitJson,
    connectivityPortIds(input.circuitJson, input.feedback?.connectivityKeys ?? []),
    SIMULATION_COLORS['mcu-activity'],
  );
  pushPortMarkers(
    circles,
    input.circuitJson,
    connectivityPortIds(input.circuitJson, input.revealedConnectivityKeys ?? []),
    REVEAL_COLOR,
  );

  if (lines.length === 0 && rects.length === 0 && circles.length === 0 && arrows.length === 0 && texts.length === 0) return null;
  return {
    coordinateSystem: 'cartesian',
    title: 'Electronics Studio PCB evidence overlays',
    ...(lines.length ? { lines } : {}),
    ...(rects.length ? { rects } : {}),
    ...(circles.length ? { circles } : {}),
    ...(arrows.length ? { arrows } : {}),
    ...(texts.length ? { texts } : {}),
  };
}
