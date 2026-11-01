import type { AnyCircuitElement } from './circuitJson.ts';
import { resolveConnectionEndpoint, type ResolvedConnectionEndpoint } from './connectionPreview.ts';

export const MAX_PIN_SELECTION_TRACES = 12;
export const MAX_PIN_SELECTION_ENDPOINTS = 24;
export const MAX_PIN_SELECTION_IDENTITY_BYTES = 240;
export const MAX_PIN_SELECTION_DESCRIPTION_BYTES = 8_192;

export interface PinSelectionTarget {
  sourcePortId: string;
  selector: string;
}

export interface PinTraceEvidence {
  sourceTraceId?: string;
  connectivityKey?: string;
  endpointSourcePortIds: string[];
  omittedEndpointCount: number;
}

export interface PinSelectionSnapshot extends ResolvedConnectionEndpoint {
  targetKey: string;
  currentlyUntraced: boolean;
  logicalTraceCount: number;
  traces: PinTraceEvidence[];
  omittedTraceCount: number;
  description: string;
}

export interface PinSelectionConstellation {
  endpointSourcePortIds: string[];
  connectivityKey?: string;
}

const encoder = new TextEncoder();

function exactIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || encoder.encode(value).length > MAX_PIN_SELECTION_IDENTITY_BYTES) {
    throw new Error(`Pin Scout requires ${field} to be one inert exact identity no longer than ${MAX_PIN_SELECTION_IDENTITY_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function exactPortIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Pin Scout requires exact source_trace.connected_source_port_ids arrays.');
  const ids = value.map((item) => exactIdentity(item, 'source trace endpoint id'));
  if (new Set(ids).size !== ids.length) throw new Error('Pin Scout refuses duplicate endpoint identities in one source trace.');
  return ids;
}

/** Resolve one rendered schematic-port selection against the exact current Circuit JSON projection. */
export function resolvePinSelectionTarget(
  elements: AnyCircuitElement[],
  target: PinSelectionTarget,
): ResolvedConnectionEndpoint {
  const sourcePortId = exactIdentity(target.sourcePortId, 'selected source_port_id');
  const selector = exactIdentity(target.selector, 'selected canonical selector');
  const resolved = resolveConnectionEndpoint(elements, selector);
  if (resolved.sourcePortId !== sourcePortId) {
    throw new Error('The selected schematic pin no longer resolves to the same exact source_port_id. Select it again.');
  }
  return resolved;
}

/** Build a bounded, source-level story for one exact selected schematic pin. */
export function buildPinSelectionSnapshot(
  elements: AnyCircuitElement[],
  target: PinSelectionTarget,
): PinSelectionSnapshot {
  const resolved = resolvePinSelectionTarget(elements, target);
  const memberships = elements
    .filter((element) => element.type === 'source_trace')
    .map((trace) => ({
      sourceTraceId: trace.source_trace_id == null ? undefined : exactIdentity(trace.source_trace_id, 'source_trace_id'),
      connectivityKey: trace.subcircuit_connectivity_map_key == null
        ? undefined
        : exactIdentity(trace.subcircuit_connectivity_map_key, 'connectivity key'),
      endpointSourcePortIds: exactPortIds(trace.connected_source_port_ids),
    }))
    .filter((trace) => trace.endpointSourcePortIds.includes(resolved.sourcePortId))
    .sort((a, b) => (a.sourceTraceId ?? '').localeCompare(b.sourceTraceId ?? '')
      || (a.connectivityKey ?? '').localeCompare(b.connectivityKey ?? '')
      || JSON.stringify(a.endpointSourcePortIds).localeCompare(JSON.stringify(b.endpointSourcePortIds)));

  const visible = memberships.slice(0, MAX_PIN_SELECTION_TRACES).map((trace): PinTraceEvidence => ({
    ...(trace.sourceTraceId ? { sourceTraceId: trace.sourceTraceId } : {}),
    ...(trace.connectivityKey ? { connectivityKey: trace.connectivityKey } : {}),
    endpointSourcePortIds: trace.endpointSourcePortIds.slice(0, MAX_PIN_SELECTION_ENDPOINTS),
    omittedEndpointCount: Math.max(0, trace.endpointSourcePortIds.length - MAX_PIN_SELECTION_ENDPOINTS),
  }));
  const omittedTraceCount = Math.max(0, memberships.length - MAX_PIN_SELECTION_TRACES);
  const story = {
    selectedPin: {
      sourcePortId: resolved.sourcePortId,
      selector: resolved.selector,
      sourceComponentId: resolved.sourceComponentId,
      ref: resolved.ref,
      port: resolved.port,
    },
    logicalSourceTraceParticipation: {
      currentlyUntraced: memberships.length === 0,
      count: memberships.length,
      traces: visible,
      omittedTraceCount,
    },
    limitation: 'This proves exact evaluated source-port ownership and source_trace membership only. It does not prove electrical compatibility, intent, ERC, DRC, PCB copper or routing, fabrication/manufacturing acceptance, physical hardware behavior, or offline validation.',
  };
  const description = JSON.stringify(story);
  if (encoder.encode(description).length > MAX_PIN_SELECTION_DESCRIPTION_BYTES) {
    throw new Error(`Pin Scout evidence exceeds its ${MAX_PIN_SELECTION_DESCRIPTION_BYTES}-byte prompt boundary.`);
  }
  return {
    ...resolved,
    targetKey: `pin:${resolved.sourcePortId}`,
    currentlyUntraced: memberships.length === 0,
    logicalTraceCount: memberships.length,
    traces: visible,
    omittedTraceCount,
    description,
  };
}

/**
 * Return complete schematic-only decoration evidence for exactly one logical
 * trace. Multi-trace or presentation-capped evidence deliberately decorates
 * only the selected pin rather than implying a complete constellation.
 */
export function derivePinSelectionConstellation(
  snapshot: PinSelectionSnapshot | undefined,
): PinSelectionConstellation | undefined {
  if (!snapshot || snapshot.logicalTraceCount !== 1 || snapshot.omittedTraceCount !== 0 || snapshot.traces.length !== 1) {
    return undefined;
  }
  const trace = snapshot.traces[0];
  if (trace.omittedEndpointCount !== 0 || !trace.endpointSourcePortIds.includes(snapshot.sourcePortId)) return undefined;
  return {
    endpointSourcePortIds: [...trace.endpointSourcePortIds].sort(),
    ...(trace.connectivityKey ? { connectivityKey: trace.connectivityKey } : {}),
  };
}
