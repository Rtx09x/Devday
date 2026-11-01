import type { AnyCircuitElement } from './circuitJson.ts';
import { extractPcbGeometry, type GeometryChangeRequest } from './pcbGeometry.ts';

export const MIN_LAYOUT_COMPONENTS = 2;
export const MAX_LAYOUT_COMPONENTS = 12;
export const MAX_LAYOUT_IDENTITY_BYTES = 160;
export const MAX_LAYOUT_SNAPSHOT_BYTES = 8_192;

export interface LayoutComponentTarget {
  sourceComponentId: string;
  ref: string;
}

export type LayoutSelectionState =
  | { phase: 'idle'; components: [] }
  | { phase: 'collecting'; components: LayoutComponentTarget[] };

export type LayoutSelectionAction =
  | { type: 'start' }
  | { type: 'toggle'; component: LayoutComponentTarget }
  | { type: 'remove'; sourceComponentId: string }
  | { type: 'clear' };

export interface LayoutEvidenceSnapshot {
  targetKey: string;
  refs: string[];
  components: Array<LayoutComponentTarget & {
    type?: string;
    value?: string;
    footprint?: string;
    pcb: { x: number; y: number; width: number; height: number; rotation: number };
  }>;
  board: { x: number; y: number; width: number; height: number };
  description: string;
  omittedDescriptionBytes: number;
}

export interface LayoutGeometryGrant {
  baseline: string;
  refs: string[];
}

const encoder = new TextEncoder();
const SAFE_REF = /^[A-Za-z0-9_-]+$/;

function exactIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || encoder.encode(value).length > MAX_LAYOUT_IDENTITY_BYTES) {
    throw new Error(`Layout selection requires ${field} to be an inert exact identity no longer than ${MAX_LAYOUT_IDENTITY_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function target(value: LayoutComponentTarget): LayoutComponentTarget {
  const ref = exactIdentity(value.ref, 'component ref');
  if (!SAFE_REF.test(ref)) throw new Error('Layout selection requires a canonical safe component ref.');
  return { sourceComponentId: exactIdentity(value.sourceComponentId, 'source component ID'), ref };
}

function sorted(values: readonly LayoutComponentTarget[]): LayoutComponentTarget[] {
  return [...values].sort((a, b) => a.sourceComponentId.localeCompare(b.sourceComponentId));
}

export function reduceLayoutSelection(state: LayoutSelectionState, action: LayoutSelectionAction): LayoutSelectionState {
  if (action.type === 'clear') return { phase: 'idle', components: [] };
  if (action.type === 'start') return { phase: 'collecting', components: [] };
  if (state.phase !== 'collecting') return state;
  if (action.type === 'remove') {
    const next = state.components.filter((entry) => entry.sourceComponentId !== action.sourceComponentId);
    return { phase: 'collecting', components: next };
  }
  const next = target(action.component);
  const existing = state.components.find((entry) => entry.sourceComponentId === next.sourceComponentId);
  if (existing) return { phase: 'collecting', components: state.components.filter((entry) => entry.sourceComponentId !== next.sourceComponentId) };
  if (state.components.length >= MAX_LAYOUT_COMPONENTS) return state;
  return { phase: 'collecting', components: sorted([...state.components, next]) };
}

export function layoutTargetKey(components: readonly LayoutComponentTarget[]): string | undefined {
  if (components.length < MIN_LAYOUT_COMPONENTS || components.length > MAX_LAYOUT_COMPONENTS) return undefined;
  return `layout:${JSON.stringify(sorted(components).map((entry) => entry.sourceComponentId))}`;
}

export function resolveLayoutTargets(elements: readonly AnyCircuitElement[], requested: readonly LayoutComponentTarget[]): LayoutComponentTarget[] {
  if (requested.length < MIN_LAYOUT_COMPONENTS || requested.length > MAX_LAYOUT_COMPONENTS) {
    throw new Error(`Layout selection requires ${MIN_LAYOUT_COMPONENTS} to ${MAX_LAYOUT_COMPONENTS} exact components.`);
  }
  const resolved = requested.map((raw) => {
    const expected = target(raw);
    const matches = elements.filter((element) => element.type === 'source_component' && element.source_component_id === expected.sourceComponentId);
    if (matches.length !== 1) throw new Error(`Layout component ${expected.sourceComponentId} is missing or ambiguous in the latest projection.`);
    const liveRef = exactIdentity(matches[0].name, 'component ref');
    if (liveRef !== expected.ref) throw new Error(`Layout component ${expected.sourceComponentId} was renamed from ${expected.ref} to ${liveRef}.`);
    return expected;
  });
  if (new Set(resolved.map((entry) => entry.sourceComponentId)).size !== resolved.length
    || new Set(resolved.map((entry) => entry.ref)).size !== resolved.length) {
    throw new Error('Layout selection requires distinct exact component IDs and refs.');
  }
  return sorted(resolved);
}

export function validateLayoutGeometryGrant(grant: LayoutGeometryGrant, currentSource: string, request: GeometryChangeRequest): void {
  if (grant.baseline !== currentSource) throw new Error('The Layout Crew source baseline changed. Select the parts and ask again.');
  if (request.board) throw new Error('Layout Crew cannot resize the board. No geometry preview was staged.');
  const requestedRefs = (request.parts ?? []).map((part) => part.ref).sort();
  const grantedRefs = [...grant.refs].sort();
  if (requestedRefs.length !== grantedRefs.length || requestedRefs.some((ref, index) => ref !== grantedRefs[index])) {
    throw new Error('Layout Crew must preview every selected ref exactly once and no unselected refs. No geometry preview was staged.');
  }
}

function normalizedFact(value: unknown, maxBytes = 256): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  let bounded = '';
  for (const point of normalized) {
    if (encoder.encode(bounded + point).length > maxBytes - 3) break;
    bounded += point;
  }
  return bounded.length === normalized.length ? bounded : `${bounded}…`;
}

function boundedDescription(description: string): { description: string; omittedDescriptionBytes: number } {
  const bytes = encoder.encode(description).length;
  if (bytes <= MAX_LAYOUT_SNAPSHOT_BYTES) return { description, omittedDescriptionBytes: 0 };
  const suffix = '\n[presentation omitted to fit the 8192-byte Layout Crew snapshot limit]';
  const budget = MAX_LAYOUT_SNAPSHOT_BYTES - encoder.encode(suffix).length;
  let prefix = '';
  for (const point of description) {
    if (encoder.encode(prefix + point).length > budget) break;
    prefix += point;
  }
  return { description: prefix + suffix, omittedDescriptionBytes: bytes - encoder.encode(prefix).length };
}

export function buildLayoutEvidenceSnapshot(elements: readonly AnyCircuitElement[], requested: readonly LayoutComponentTarget[]): LayoutEvidenceSnapshot {
  const targets = resolveLayoutTargets(elements, requested);
  const geometry = extractPcbGeometry([...elements], targets.map((entry) => entry.ref));
  const components = targets.map((entry, index) => {
    const source = elements.find((element) => element.type === 'source_component' && element.source_component_id === entry.sourceComponentId)!;
    const pcb = geometry.parts[index];
    return {
      ...entry,
      ...(normalizedFact(source.ftype) ? { type: normalizedFact(source.ftype) } : {}),
      ...(normalizedFact(source.display_value ?? source.resistance ?? source.capacitance ?? source.inductance) ? { value: normalizedFact(source.display_value ?? source.resistance ?? source.capacitance ?? source.inductance) } : {}),
      ...(normalizedFact(source.footprint) ? { footprint: normalizedFact(source.footprint) } : {}),
      pcb: { x: pcb.x, y: pcb.y, width: pcb.width, height: pcb.height, rotation: pcb.rotation ?? 0 },
    };
  });
  const targetKey = layoutTargetKey(targets)!;
  const payload = {
    mode: 'explicit-pcb-layout-crew',
    board: geometry.board,
    components,
    limitations: [
      'Coordinates and dimensions are evaluated PCB rectangles in millimetres.',
      'They are not courtyards, copper, routing, clearance, collision, DRC, fabrication, or physical-fit evidence.',
      'The existing rectangular board must not be resized by this request.',
    ],
  };
  const bounded = boundedDescription(JSON.stringify(payload, null, 2));
  return {
    targetKey,
    refs: targets.map((entry) => entry.ref),
    components,
    board: geometry.board,
    description: bounded.description,
    omittedDescriptionBytes: bounded.omittedDescriptionBytes,
  };
}
