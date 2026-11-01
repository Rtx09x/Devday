import type { AnyCircuitElement, ComponentSummary } from './circuitJson.ts';
import type { ResolvedConnectionProposal } from './connectionPreview.ts';

export const MAX_PART_WIRE_PORTS = 32;
export const MAX_PART_WIRE_DESCRIPTION_LENGTH = 8_192;

const SAFE_SELECTOR_TOKEN = /^[A-Za-z0-9_-]+$/;
const MAX_IDENTITY_LENGTH = 240;

export interface PartWirePortEvidence {
  selector: string;
  sourcePortId: string;
}

export interface PartWireEvidence {
  sourceComponentId: string;
  ref: string;
  ports: PartWirePortEvidence[];
  omittedPortCount: number;
  description: string;
}

export interface PartConnectionGrant {
  baseline: string;
  sourceComponentId: string;
  ref: string;
  /** When present, the one selected endpoint must be this exact source port. */
  sourcePortId?: string;
}

function exactIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_LENGTH) {
    throw new Error(`${label} must be one exact bounded string identity.`);
  }
  return value;
}

function canonicalPortName(port: AnyCircuitElement): string | undefined {
  if (typeof port.name === 'string' && SAFE_SELECTOR_TOKEN.test(port.name)) return port.name;
  if (typeof port.pin_number === 'number' && Number.isInteger(port.pin_number) && port.pin_number >= 0) {
    return `pin${port.pin_number}`;
  }
  return undefined;
}

/** Build bounded, exact evidence for a selected part that can safely anchor one connection preview. */
export function buildPartWireEvidence(
  elements: AnyCircuitElement[],
  target: Pick<ComponentSummary, 'id' | 'name'>,
): PartWireEvidence {
  const sourceComponentId = exactIdentity(target.id, 'Selected source component id');
  const ref = exactIdentity(target.name, 'Selected part ref');
  if (!SAFE_SELECTOR_TOKEN.test(ref)) throw new Error('Selected part ref cannot form one canonical connection selector.');

  const exactComponents = elements.filter((element) => element.type === 'source_component'
    && element.source_component_id === sourceComponentId
    && element.name === ref);
  if (exactComponents.length !== 1) {
    throw new Error(`Wire one port requires one exact current source component match for ${JSON.stringify(ref)}; found ${exactComponents.length}.`);
  }
  const idMatches = elements.filter((element) => element.type === 'source_component'
    && element.source_component_id === sourceComponentId);
  const refMatches = elements.filter((element) => element.type === 'source_component' && element.name === ref);
  if (idMatches.length !== 1 || refMatches.length !== 1) {
    throw new Error('Wire one port requires unique current source component id and ref identities.');
  }

  const tracedPortIds = new Set<string>();
  for (const trace of elements.filter((element) => element.type === 'source_trace')) {
    if (!Array.isArray(trace.connected_source_port_ids)
      || trace.connected_source_port_ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error('Wire one port requires exact source trace port identities.');
    }
    for (const id of trace.connected_source_port_ids as string[]) tracedPortIds.add(id);
  }

  const globalPortIds = new Map<string, number>();
  for (const port of elements.filter((element) => element.type === 'source_port')) {
    if (typeof port.source_port_id === 'string' && port.source_port_id.length > 0) {
      globalPortIds.set(port.source_port_id, (globalPortIds.get(port.source_port_id) ?? 0) + 1);
    }
  }

  const ports = elements
    .filter((element) => element.type === 'source_port' && element.source_component_id === sourceComponentId)
    .map((port): PartWirePortEvidence | undefined => {
      const sourcePortId = exactIdentity(port.source_port_id, 'Selected source port id');
      if (globalPortIds.get(sourcePortId) !== 1) {
        throw new Error('Wire one port requires unique selected source port identities.');
      }
      if (tracedPortIds.has(sourcePortId)) return undefined;
      const name = canonicalPortName(port);
      if (!name) return undefined;
      return { selector: `.${ref} > .${name}`, sourcePortId };
    })
    .filter((port): port is PartWirePortEvidence => port != null)
    .sort((a, b) => a.selector.localeCompare(b.selector) || a.sourcePortId.localeCompare(b.sourcePortId));

  const distinctSelectors = new Set(ports.map((port) => port.selector));
  if (distinctSelectors.size !== ports.length) {
    throw new Error('Wire one port requires unique canonical port selectors on the selected part.');
  }
  if (ports.length === 0) {
    throw new Error(`Wire one port found no exact currently-untraced canonical port on ${ref}.`);
  }

  const visiblePorts = ports.slice(0, MAX_PART_WIRE_PORTS);
  const omittedPortCount = ports.length - visiblePorts.length;
  const description = JSON.stringify({
    selectedSourceComponentId: sourceComponentId,
    selectedRef: ref,
    exactCurrentlyUntracedPorts: visiblePorts,
    omittedPortCount,
    limitation: 'These identities prove current ownership and lack of source-trace membership only; they do not prove that any proposed electrical connection is correct.',
  });
  if (new TextEncoder().encode(description).byteLength > MAX_PART_WIRE_DESCRIPTION_LENGTH) {
    throw new Error('The selected-part wiring evidence exceeds its bounded prompt limit.');
  }
  return { sourceComponentId, ref, ports: visiblePorts, omittedPortCount, description };
}

export function createPartConnectionGrant(baseline: string, evidence: PartWireEvidence): PartConnectionGrant {
  return { baseline, sourceComponentId: evidence.sourceComponentId, ref: evidence.ref };
}

export function createPinConnectionGrant(
  baseline: string,
  pin: { sourceComponentId: string; ref: string; sourcePortId: string },
): PartConnectionGrant {
  return {
    baseline,
    sourceComponentId: exactIdentity(pin.sourceComponentId, 'Selected source component id'),
    ref: exactIdentity(pin.ref, 'Selected part ref'),
    sourcePortId: exactIdentity(pin.sourcePortId, 'Selected source port id'),
  };
}

/** Validate a consumed editor-owned grant against the exact current source and resolved proposal. */
export function validatePartConnectionGrant(
  grant: PartConnectionGrant,
  currentSource: string,
  proposal: ResolvedConnectionProposal,
): void {
  if (grant.baseline !== currentSource) {
    throw new Error('The selected-part wiring source changed. Select Wire one port again; no preview was staged.');
  }
  const endpoints = [proposal.from, proposal.to];
  if (proposal.from.sourceComponentId === proposal.to.sourceComponentId) {
    throw new Error('Wire one port requires a connection between two different source components.');
  }
  const selected = endpoints.filter((endpoint) => endpoint.sourceComponentId === grant.sourceComponentId);
  if (selected.length !== 1 || selected[0].ref !== grant.ref) {
    throw new Error('The connection preview must contain exactly one endpoint owned by the exact selected part.');
  }
  if (grant.sourcePortId && selected[0].sourcePortId !== grant.sourcePortId) {
    throw new Error('The connection preview must use the exact selected Pin Scout source_port_id.');
  }
  const counterpart = endpoints.find((endpoint) => endpoint !== selected[0]);
  if (!counterpart || counterpart.ref === grant.ref) {
    throw new Error('The connection preview counterpart must belong to a different exact part.');
  }
}
