import type { AnyCircuitElement } from './circuitJson';

export const MAX_PAIR_UNTRACED_PORTS = 16;
export const MAX_PAIR_TRACED_PORTS = 12;
export const MAX_PAIR_LOGICAL_MEMBERSHIPS = 8;
export const MAX_PAIR_SELECTOR_BYTES = 160;
export const MAX_PAIR_IDENTITY_BYTES = 160;
export const MAX_PAIR_SNAPSHOT_BYTES = 8_192;

export interface PairComponentTarget {
  sourceComponentId: string;
  ref: string;
}

export type PairSelectionState =
  | { phase: 'idle' }
  | { phase: 'collecting'; components: [] | [PairComponentTarget] }
  | { phase: 'ready'; components: [PairComponentTarget, PairComponentTarget] };

export type PairSelectionAction =
  | { type: 'start'; preseed?: PairComponentTarget }
  | { type: 'select'; component: PairComponentTarget }
  | { type: 'change-second' }
  | { type: 'clear' };

export interface PairPortEvidence {
  selector: string;
  sourcePortId: string;
}

export interface PairTracedPortEvidence extends PairPortEvidence {
  sourceTraceId: string;
  connectivityKey: string;
  netDisplayEvidence?: string;
}

export interface PairComponentEvidence extends PairComponentTarget {
  type?: string;
  value?: string;
  footprint?: string;
  untraced: PairPortEvidence[];
  traced: PairTracedPortEvidence[];
  logicalMemberships: Array<{ sourceTraceId: string; connectivityKey: string; netDisplayEvidence?: string }>;
  omittedUnsafeSelectors: number;
  omittedUntraced: number;
  omittedTraced: number;
  omittedLogicalMemberships: number;
}

export interface PairEvidenceSnapshot {
  targetKey: string;
  refs: [string, string];
  components: [PairComponentEvidence, PairComponentEvidence];
  description: string;
  omittedDescriptionBytes: number;
}

const encoder = new TextEncoder();
const SAFE_SELECTOR_PART = /^[A-Za-z0-9_-]+$/;

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Pair evidence requires a non-empty exact ${field}.`);
  return value;
}

function exactBoundedIdentity(value: unknown, field: string): string {
  const result = exactString(value, field);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(result) || encoder.encode(result).length > MAX_PAIR_IDENTITY_BYTES) {
    throw new Error(`Pair evidence requires ${field} to be an inert exact identity no longer than ${MAX_PAIR_IDENTITY_BYTES} UTF-8 bytes.`);
  }
  return result;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Pair evidence found a malformed ${field}.`);
  return value;
}

function normalizedFact(value: unknown, maxBytes = 256): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (encoder.encode(normalized).length <= maxBytes) return normalized;
  const suffix = '…';
  const budget = maxBytes - encoder.encode(suffix).length;
  let result = '';
  for (const point of normalized) {
    if (encoder.encode(result + point).length > budget) break;
    result += point;
  }
  return result + suffix;
}

function target(target: PairComponentTarget): PairComponentTarget {
  const ref = exactBoundedIdentity(target.ref, 'component ref');
  if (!SAFE_SELECTOR_PART.test(ref)) throw new Error('Pair evidence requires a canonical safe component ref.');
  return {
    sourceComponentId: exactBoundedIdentity(target.sourceComponentId, 'source component ID'),
    ref,
  };
}

function sortedPair(values: [PairComponentTarget, PairComponentTarget]): [PairComponentTarget, PairComponentTarget] {
  return [...values].sort((a, b) => a.sourceComponentId.localeCompare(b.sourceComponentId)) as [PairComponentTarget, PairComponentTarget];
}

export function reducePairSelection(state: PairSelectionState, action: PairSelectionAction): PairSelectionState {
  if (action.type === 'clear') return { phase: 'idle' };
  if (action.type === 'start') return action.preseed ? { phase: 'collecting', components: [target(action.preseed)] } : { phase: 'collecting', components: [] };
  if (action.type === 'change-second') {
    return state.phase === 'ready' ? { phase: 'collecting', components: [state.components[0]] } : state;
  }
  if (state.phase !== 'collecting') return state;
  const next = target(action.component);
  if (state.components.some((entry) => entry.sourceComponentId === next.sourceComponentId)) return state;
  if (state.components.length === 0) return { phase: 'collecting', components: [next] };
  return { phase: 'ready', components: sortedPair([state.components[0], next]) };
}

export function pairTargetKey(state: PairSelectionState | [PairComponentTarget, PairComponentTarget]): string | undefined {
  const components = Array.isArray(state) ? sortedPair(state) : state.phase === 'ready' ? state.components : undefined;
  return components ? `pair:${JSON.stringify(components.map((entry) => entry.sourceComponentId))}` : undefined;
}

export function resolvePairTargets(elements: readonly AnyCircuitElement[], requested: readonly PairComponentTarget[]): [PairComponentTarget, PairComponentTarget] {
  if (requested.length !== 2) throw new Error('Pair requires exactly two components.');
  const resolved = requested.map((raw) => {
    const expected = target(raw);
    const matches = elements.filter((element) => element.type === 'source_component' && element.source_component_id === expected.sourceComponentId);
    if (matches.length !== 1) throw new Error(`Pair component ${expected.sourceComponentId} is missing or ambiguous in the latest projection.`);
    const liveRef = exactBoundedIdentity(matches[0].name, 'component ref');
    if (liveRef !== expected.ref) throw new Error(`Pair component ${expected.sourceComponentId} was renamed from ${expected.ref} to ${liveRef}.`);
    return expected;
  });
  if (resolved[0].sourceComponentId === resolved[1].sourceComponentId) throw new Error('Pair requires two distinct component identities.');
  return sortedPair(resolved as [PairComponentTarget, PairComponentTarget]);
}

function canonicalPortName(port: AnyCircuitElement): string | undefined {
  const name = optionalString(port.name, 'source-port name');
  if (name) return SAFE_SELECTOR_PART.test(name) ? name : undefined;
  const pin = port.pin_number;
  if ((typeof pin === 'number' && Number.isInteger(pin) && pin >= 0) || (typeof pin === 'string' && /^[0-9]+$/.test(pin))) return `pin${pin}`;
  return undefined;
}

function strictStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Pair evidence requires ${field} to be an exact array.`);
  const values = value.map((entry) => exactBoundedIdentity(entry, field));
  if (new Set(values).size !== values.length) throw new Error(`Pair evidence found duplicate identities in ${field}.`);
  return values;
}

function boundedSnapshot(description: string): { description: string; omittedDescriptionBytes: number } {
  const bytes = encoder.encode(description).length;
  if (bytes <= MAX_PAIR_SNAPSHOT_BYTES) return { description, omittedDescriptionBytes: 0 };
  const suffix = '\n[presentation omitted to fit the 8192-byte Pair snapshot limit]';
  const suffixBytes = encoder.encode(suffix).length;
  let prefix = '';
  for (const point of description) {
    if (encoder.encode(prefix + point).length > MAX_PAIR_SNAPSHOT_BYTES - suffixBytes) break;
    prefix += point;
  }
  const bounded = prefix + suffix;
  return { description: bounded, omittedDescriptionBytes: bytes - encoder.encode(prefix).length };
}

export function buildPairEvidenceSnapshot(elements: readonly AnyCircuitElement[], requested: readonly PairComponentTarget[]): PairEvidenceSnapshot {
  const targets = resolvePairTargets(elements, requested);
  const componentsById = new Map<string, AnyCircuitElement>();
  for (const element of elements) {
    if (element.type !== 'source_component') continue;
    const id = exactBoundedIdentity(element.source_component_id, 'source component ID');
    if (componentsById.has(id)) throw new Error(`Pair evidence found duplicate source component identity ${id}.`);
    componentsById.set(id, element);
  }
  const portsById = new Map<string, AnyCircuitElement>();
  const portsByComponent = new Map<string, AnyCircuitElement[]>();
  for (const element of elements) {
    if (element.type !== 'source_port') continue;
    const id = exactBoundedIdentity(element.source_port_id, 'source port ID');
    const owner = exactBoundedIdentity(element.source_component_id, 'source-port owner ID');
    if (portsById.has(id)) throw new Error(`Pair evidence found duplicate source port identity ${id}.`);
    portsById.set(id, element);
    portsByComponent.set(owner, [...(portsByComponent.get(owner) ?? []), element]);
  }
  const netLabels = new Map<string, string>();
  for (const element of elements) {
    if (element.type !== 'source_net') continue;
    const id = exactBoundedIdentity(element.source_net_id, 'source net ID');
    if (netLabels.has(id)) throw new Error(`Pair evidence found duplicate source net identity ${id}.`);
    netLabels.set(id, normalizedFact(element.name) ?? id);
  }
  const traces = elements.filter((element) => element.type === 'source_trace').map((element) => {
    const sourceTraceId = exactBoundedIdentity(element.source_trace_id, 'source trace ID');
    const connectivityKey = exactBoundedIdentity(element.subcircuit_connectivity_map_key, 'connectivity key');
    const portIds = strictStringArray(element.connected_source_port_ids, 'connected_source_port_ids');
    for (const id of portIds) if (!portsById.has(id)) throw new Error(`Pair evidence found a trace referencing missing source port ${id}.`);
    const netIds = element.connected_source_net_ids == null ? [] : strictStringArray(element.connected_source_net_ids, 'connected_source_net_ids');
    const netDisplayEvidence = normalizedFact(netIds.map((id) => netLabels.get(id) ?? id).join(', '));
    return { sourceTraceId, connectivityKey, portIds, netDisplayEvidence };
  });
  const traceIds = traces.map((entry) => entry.sourceTraceId);
  const keys = traces.map((entry) => entry.connectivityKey);
  if (new Set(traceIds).size !== traceIds.length || new Set(keys).size !== keys.length) throw new Error('Pair evidence found ambiguous trace identities.');

  const componentEvidence = targets.map((selected): PairComponentEvidence => {
    const component = componentsById.get(selected.sourceComponentId)!;
    const ref = selected.ref;
    if (!SAFE_SELECTOR_PART.test(ref)) throw new Error(`Pair component ref ${ref} is not safe for a canonical selector.`);
    const untraced: PairPortEvidence[] = [];
    const traced: PairTracedPortEvidence[] = [];
    let omittedUnsafeSelectors = 0;
    for (const port of portsByComponent.get(selected.sourceComponentId) ?? []) {
      const sourcePortId = exactBoundedIdentity(port.source_port_id, 'source port ID');
      const portName = canonicalPortName(port);
      const selector = portName ? `.${ref} > .${portName}` : undefined;
      if (!selector || encoder.encode(selector).length > MAX_PAIR_SELECTOR_BYTES) {
        omittedUnsafeSelectors += 1;
        continue;
      }
      const memberships = traces.filter((trace) => trace.portIds.includes(sourcePortId));
      if (memberships.length === 0) untraced.push({ selector, sourcePortId });
      for (const membership of memberships) traced.push({
        selector,
        sourcePortId,
        sourceTraceId: membership.sourceTraceId,
        connectivityKey: membership.connectivityKey,
        ...(membership.netDisplayEvidence ? { netDisplayEvidence: membership.netDisplayEvidence } : {}),
      });
    }
    const sortPorts = <T extends PairPortEvidence>(values: T[]) => values.sort((a, b) => a.selector.localeCompare(b.selector) || a.sourcePortId.localeCompare(b.sourcePortId));
    sortPorts(untraced);
    sortPorts(traced);
    const memberships = [...new Map(traced.map((entry) => [entry.sourceTraceId, {
      sourceTraceId: entry.sourceTraceId,
      connectivityKey: entry.connectivityKey,
      ...(entry.netDisplayEvidence ? { netDisplayEvidence: entry.netDisplayEvidence } : {}),
    }])).values()].sort((a, b) => a.sourceTraceId.localeCompare(b.sourceTraceId));
    return {
      ...selected,
      ...(normalizedFact(component.ftype) ? { type: normalizedFact(component.ftype) } : {}),
      ...(normalizedFact(component.display_value ?? component.resistance ?? component.capacitance ?? component.inductance) ? { value: normalizedFact(component.display_value ?? component.resistance ?? component.capacitance ?? component.inductance) } : {}),
      ...(normalizedFact(component.footprint) ? { footprint: normalizedFact(component.footprint) } : {}),
      untraced: untraced.slice(0, MAX_PAIR_UNTRACED_PORTS),
      traced: traced.slice(0, MAX_PAIR_TRACED_PORTS),
      logicalMemberships: memberships.slice(0, MAX_PAIR_LOGICAL_MEMBERSHIPS),
      omittedUnsafeSelectors,
      omittedUntraced: Math.max(0, untraced.length - MAX_PAIR_UNTRACED_PORTS),
      omittedTraced: Math.max(0, traced.length - MAX_PAIR_TRACED_PORTS),
      omittedLogicalMemberships: Math.max(0, memberships.length - MAX_PAIR_LOGICAL_MEMBERSHIPS),
    };
  }) as [PairComponentEvidence, PairComponentEvidence];
  const payload = {
    mode: 'explicit-pair',
    definition: 'untraced means only absence from evaluated source_trace membership; it is not compatibility or need evidence',
    components: componentEvidence,
  };
  const bounded = boundedSnapshot(JSON.stringify(payload, null, 2));
  return {
    targetKey: pairTargetKey(targets)!,
    refs: [targets[0].ref, targets[1].ref],
    components: componentEvidence,
    ...bounded,
  };
}
