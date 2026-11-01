import type { AnyCircuitElement } from './circuitJson.ts';
import { buildTrace } from './tscircuitCode.ts';

export interface ConnectionPreviewRequest {
  from: string;
  to: string;
}

export interface ResolvedConnectionEndpoint {
  selector: string;
  ref: string;
  port: string;
  sourceComponentId: string;
  sourcePortId: string;
}

export interface ResolvedConnectionProposal {
  from: ResolvedConnectionEndpoint;
  to: ResolvedConnectionEndpoint;
}

export interface ConnectionPreviewMetadata extends ResolvedConnectionProposal {
  beforeTraceCount: number;
  afterTraceCount: number;
  addedSourceTraceId: string;
  addedConnectivityKey: string;
  affectedNet: {
    change: 'added';
    selectors: [string, string];
    endpointSourcePortIds: [string, string];
    sourceTraceId: string;
    connectivityKey: string;
  };
  limitation: string;
}

export interface ConnectionPreviewProjectionState {
  loaded: boolean;
  currentSource: string;
  projectedSource: string | null;
  running: boolean;
  ok: boolean;
  error?: string;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const CANONICAL_SELECTOR = /^\.([A-Za-z0-9_-]+) > \.([A-Za-z0-9_-]+)$/;
export const MAX_CONNECTION_SELECTOR_LENGTH = 160;

function exactText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function exactStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`Evaluated ${field} must be an exact string array.`);
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error(`Evaluated ${field} contains duplicate identities.`);
  return ids;
}

function canonicalPortName(port: AnyCircuitElement): string | undefined {
  const name = exactText(port.name);
  if (name) return SAFE_IDENTIFIER.test(name) ? name : undefined;
  const pin = port.pin_number;
  return typeof pin === 'number' && Number.isInteger(pin) && pin >= 0 ? `pin${pin}` : undefined;
}

export function parseCanonicalConnectionSelector(selector: string): { ref: string; port: string } {
  if (typeof selector !== 'string') throw new Error('Connection selectors must be strings.');
  if (selector.length > MAX_CONNECTION_SELECTOR_LENGTH) throw new Error(`Connection selectors must be at most ${MAX_CONNECTION_SELECTOR_LENGTH} characters.`);
  const match = CANONICAL_SELECTOR.exec(selector);
  if (!match) {
    throw new Error(`Unsupported selector ${JSON.stringify(selector)}. Use exactly ".REF > .PORT" with safe ASCII letters, digits, underscore, or hyphen.`);
  }
  return { ref: match[1], port: match[2] };
}

/** Insert one canonical trace into exactly one explicit non-self-closing board. */
export function insertConnectionInCode(
  source: string,
  proposal: ResolvedConnectionProposal,
): string {
  const boardOpenings = [...source.matchAll(/<board\b[^<>]*>/g)];
  const boardClosings = [...source.matchAll(/<\/board\s*>/g)];
  if (boardOpenings.length !== 1 || boardClosings.length !== 1 || /\/\s*>$/.test(boardOpenings[0][0])) {
    throw new Error('Connection preview requires exactly one explicit non-self-closing <board> source target.');
  }
  const openIndex = boardOpenings[0].index ?? -1;
  const closeIndex = boardClosings[0].index ?? -1;
  if (openIndex < 0 || closeIndex <= openIndex) {
    throw new Error('Connection preview requires one well-ordered explicit <board> source target.');
  }
  const trace = buildTrace(proposal.from.selector, proposal.to.selector).trim();
  if (source.includes(trace)) throw new Error('The exact canonical trace already exists in source.');
  const closeLineStart = source.lastIndexOf('\n', closeIndex - 1) + 1;
  const closeIndentCandidate = source.slice(closeLineStart, closeIndex);
  const closingStartsOwnLine = /^\s*$/.test(closeIndentCandidate);
  const insertionIndex = closingStartsOwnLine ? closeLineStart : closeIndex;
  const indent = closingStartsOwnLine ? closeIndentCandidate : '';
  const before = source.slice(0, insertionIndex);
  const separator = before.endsWith('\n') ? '' : '\n';
  return `${before}${separator}${indent}  ${trace}\n${source.slice(insertionIndex)}`;
}

export function assertConnectionPreviewProjectionFresh(state: ConnectionPreviewProjectionState): void {
  if (!state.loaded) throw new Error('Connection preview requires a loaded editor source.');
  if (state.projectedSource !== state.currentSource) throw new Error('Connection preview requires a fresh projection matching the current editor source.');
  if (state.running) throw new Error('Connection preview is unavailable while evaluation is running.');
  if (!state.ok) throw new Error(`Connection preview requires successful evaluation${state.error ? `: ${state.error}` : '.'}`);
}

export function resolveConnectionEndpoint(
  elements: AnyCircuitElement[],
  selector: string,
): ResolvedConnectionEndpoint {
  const parsed = parseCanonicalConnectionSelector(selector);
  const components = elements.filter((element) => element.type === 'source_component' && element.name === parsed.ref);
  if (components.length !== 1) {
    throw new Error(`Selector ${JSON.stringify(selector)} has ${components.length === 0 ? 'no' : 'ambiguous'} exact case-sensitive source component match.`);
  }
  const sourceComponentId = exactText(components[0].source_component_id);
  if (!sourceComponentId) throw new Error(`Selector ${JSON.stringify(selector)} matched a component without one exact source_component_id.`);
  if (elements.filter((element) => element.type === 'source_component' && element.source_component_id === sourceComponentId).length !== 1) {
    throw new Error(`Selector ${JSON.stringify(selector)} matched an ambiguous source_component_id.`);
  }
  const ports = elements.filter((element) => element.type === 'source_port'
    && element.source_component_id === sourceComponentId
    && canonicalPortName(element) === parsed.port);
  if (ports.length !== 1) {
    throw new Error(`Selector ${JSON.stringify(selector)} has ${ports.length === 0 ? 'no' : 'ambiguous'} exact owned source port match.`);
  }
  const sourcePortId = exactText(ports[0].source_port_id);
  if (!sourcePortId) throw new Error(`Selector ${JSON.stringify(selector)} matched a port without one exact source_port_id.`);
  if (elements.filter((element) => element.type === 'source_port' && element.source_port_id === sourcePortId).length !== 1) {
    throw new Error(`Selector ${JSON.stringify(selector)} matched an ambiguous source_port_id.`);
  }
  return { selector, ref: parsed.ref, port: parsed.port, sourceComponentId, sourcePortId };
}

function traceMemberships(elements: AnyCircuitElement[]): Array<{
  sourceTraceId?: string;
  connectivityKey?: string;
  portIds: string[];
  netIds: string[];
}> {
  return elements.filter((element) => element.type === 'source_trace').map((trace) => ({
    ...(exactText(trace.source_trace_id) ? { sourceTraceId: exactText(trace.source_trace_id) } : {}),
    ...(exactText(trace.subcircuit_connectivity_map_key) ? { connectivityKey: exactText(trace.subcircuit_connectivity_map_key) } : {}),
    portIds: exactStringArray(trace.connected_source_port_ids, 'source_trace.connected_source_port_ids').slice().sort(),
    netIds: trace.connected_source_net_ids == null
      ? []
      : exactStringArray(trace.connected_source_net_ids, 'source_trace.connected_source_net_ids').slice().sort(),
  }));
}

function sourceIdentitySnapshot(elements: AnyCircuitElement[]): string[] {
  const rows: string[] = [];
  for (const component of elements.filter((element) => element.type === 'source_component')) {
    const id = exactText(component.source_component_id);
    const name = exactText(component.name);
    if (!id || !name) throw new Error('Every evaluated source component must expose exact id and name identity for a connection preview.');
    rows.push(JSON.stringify(['component', id, name]));
  }
  for (const port of elements.filter((element) => element.type === 'source_port')) {
    const id = exactText(port.source_port_id);
    const owner = exactText(port.source_component_id);
    const name = canonicalPortName(port);
    if (!id || !owner || !name) throw new Error('Every evaluated source port must expose exact id, owner, and canonical name identity for a connection preview.');
    rows.push(JSON.stringify(['port', id, owner, name]));
  }
  return rows.sort();
}

function traceSignature(trace: ReturnType<typeof traceMemberships>[number]): string {
  return JSON.stringify([trace.sourceTraceId ?? null, trace.connectivityKey ?? null, trace.portIds, trace.netIds]);
}

function samePair(actual: string[], requested: string[]): boolean {
  return actual.length === 2 && actual[0] === requested[0] && actual[1] === requested[1];
}

export function resolveConnectionProposal(
  elements: AnyCircuitElement[],
  request: ConnectionPreviewRequest,
): ResolvedConnectionProposal {
  const from = resolveConnectionEndpoint(elements, request.from);
  const to = resolveConnectionEndpoint(elements, request.to);
  if (from.selector === to.selector) throw new Error('Connection endpoints must be two different canonical selectors.');
  if (from.sourcePortId === to.sourcePortId) throw new Error('Connection endpoints resolve to the same source_port_id.');
  const traces = traceMemberships(elements);
  for (const endpoint of [from, to]) {
    if (traces.some((trace) => trace.portIds.includes(endpoint.sourcePortId))) {
      throw new Error(`Endpoint ${JSON.stringify(endpoint.selector)} already participates in a source trace. V1 never merges or extends an existing logical net.`);
    }
  }
  return { from, to };
}

export function buildConnectionPreview(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
  proposal: ResolvedConnectionProposal,
): ConnectionPreviewMetadata {
  if (afterElements.some((element) => typeof element.type === 'string' && element.type.endsWith('_error'))) {
    throw new Error('The proposed connection produced an evaluated error element.');
  }
  const beforeFrom = resolveConnectionEndpoint(beforeElements, proposal.from.selector);
  const beforeTo = resolveConnectionEndpoint(beforeElements, proposal.to.selector);
  if (beforeFrom.sourcePortId !== proposal.from.sourcePortId || beforeTo.sourcePortId !== proposal.to.sourcePortId) {
    throw new Error('Requested endpoint identity changed before connection verification.');
  }
  const afterFrom = resolveConnectionEndpoint(afterElements, proposal.from.selector);
  const afterTo = resolveConnectionEndpoint(afterElements, proposal.to.selector);
  if (JSON.stringify(afterFrom) !== JSON.stringify(proposal.from) || JSON.stringify(afterTo) !== JSON.stringify(proposal.to)) {
    throw new Error('The proposed source changed requested component or port identity.');
  }
  if (JSON.stringify(sourceIdentitySnapshot(beforeElements)) !== JSON.stringify(sourceIdentitySnapshot(afterElements))) {
    throw new Error('The proposed source changed source component or port identities.');
  }
  const before = traceMemberships(beforeElements);
  const requestedIds = [proposal.from.sourcePortId, proposal.to.sourcePortId].sort();
  if (before.some((trace) => trace.portIds.some((id) => requestedIds.includes(id)))) {
    throw new Error('A requested endpoint already participates in the baseline source traces.');
  }
  const after = traceMemberships(afterElements);
  if (after.length !== before.length + 1) throw new Error('The proposed source must add exactly one source_trace and no others.');
  const candidates = after.filter((trace) => samePair(trace.portIds, requestedIds));
  if (candidates.length !== 1) throw new Error('The proposed source must contain exactly one new source_trace with the two requested endpoint IDs.');
  const added = candidates[0];
  const remaining = after.slice();
  remaining.splice(remaining.indexOf(added), 1);
  if (JSON.stringify(remaining.map(traceSignature).sort()) !== JSON.stringify(before.map(traceSignature).sort())) {
    throw new Error('The proposed source changed, removed, or duplicated existing source_trace identity or membership.');
  }
  if (!added.sourceTraceId || !added.connectivityKey) {
    throw new Error('The proposed source_trace must expose one exact source_trace_id and connectivity key.');
  }
  if (before.some((trace) => trace.sourceTraceId === added.sourceTraceId)) {
    throw new Error('The proposed source reused an existing source_trace_id.');
  }
  if (before.some((trace) => trace.connectivityKey === added.connectivityKey)) {
    throw new Error('The proposed source reused an existing connectivity key.');
  }
  const selectors = [proposal.from.selector, proposal.to.selector] as [string, string];
  const endpointSourcePortIds = [proposal.from.sourcePortId, proposal.to.sourcePortId] as [string, string];
  return {
    ...proposal,
    beforeTraceCount: before.length,
    afterTraceCount: after.length,
    addedSourceTraceId: added.sourceTraceId,
    addedConnectivityKey: added.connectivityKey,
    affectedNet: {
      change: 'added', selectors, endpointSourcePortIds,
      sourceTraceId: added.sourceTraceId,
      connectivityKey: added.connectivityKey,
    },
    limitation: 'Exact evaluated source-level connection preview only; not ERC, DRC, PCB copper or routing proof, fabrication or manufacturing acceptance, physical hardware validation, or offline validation.',
  };
}
