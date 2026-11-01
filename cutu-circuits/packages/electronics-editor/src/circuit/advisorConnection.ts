import type { AnyCircuitElement } from './circuitJson.ts';
import {
  resolveConnectionEndpoint,
  type ConnectionPreviewRequest,
  type ResolvedConnectionProposal,
} from './connectionPreview.ts';
import type { AdvisorAffectedGeometry } from './advisorAffectedGeometry.ts';

export interface AdvisorConnectionGrant {
  baseline: string;
  targetKey: string;
  endpoints: Array<{
    selector: string;
    sourcePortId: string;
    sourceComponentId: string;
  }>;
  consumed: boolean;
}

export interface AdvisorConnectionEligibility {
  allowed: boolean;
  reason?: string;
}

/**
 * Wire one gap is intentionally narrower than generic Advisor diagnosis: it
 * needs two exact canonical ports, each proven absent from every source trace,
 * and they must belong to different source components.
 */
export function getAdvisorConnectionEligibility(
  geometry: AdvisorAffectedGeometry | undefined,
): AdvisorConnectionEligibility {
  if (!geometry || geometry.state !== 'resolved' || geometry.basis !== 'unconnected-reviewable-ports') {
    return { allowed: false, reason: 'Wire one gap requires exact unconnected-port evidence.' };
  }
  const canonical = geometry.ports.filter((port) => typeof port.selector === 'string' && port.selector.length > 0);
  if (canonical.length < 2) {
    return { allowed: false, reason: 'Wire one gap requires at least two exact canonical unconnected ports.' };
  }
  if (new Set(canonical.map((port) => port.sourceComponentId)).size < 2) {
    return { allowed: false, reason: 'Wire one gap requires eligible ports on at least two different source components.' };
  }
  return { allowed: true };
}

export function createAdvisorConnectionGrant(
  baseline: string,
  geometry: AdvisorAffectedGeometry,
  elements: AnyCircuitElement[],
): AdvisorConnectionGrant {
  const eligibility = getAdvisorConnectionEligibility(geometry);
  if (!eligibility.allowed || geometry.state !== 'resolved') {
    throw new Error(`${eligibility.reason ?? 'Wire one gap is unavailable.'} No request was sent.`);
  }
  const endpoints = geometry.ports.map((port) => {
    if (!port.selector) throw new Error('Wire one gap requires a canonical selector for every affected port. No request was sent.');
    const resolved = resolveConnectionEndpoint(elements, port.selector);
    if (resolved.sourcePortId !== port.sourcePortId || resolved.sourceComponentId !== port.sourceComponentId) {
      throw new Error('Wire one gap exact selector identity changed before Ask. Select the finding again; no request was sent.');
    }
    return {
      selector: resolved.selector,
      sourcePortId: resolved.sourcePortId,
      sourceComponentId: resolved.sourceComponentId,
    };
  });
  if (new Set(endpoints.map((endpoint) => endpoint.selector)).size !== endpoints.length
    || new Set(endpoints.map((endpoint) => endpoint.sourcePortId)).size !== endpoints.length) {
    throw new Error('Wire one gap requires unique exact selector and source-port identities. No request was sent.');
  }
  return { baseline, targetKey: geometry.targetKey, endpoints, consumed: false };
}

/** Consume the only mutation attempt before starting asynchronous evaluation. */
export function consumeAdvisorConnectionGrant(
  grant: AdvisorConnectionGrant,
  currentSource: string,
  proposal: ResolvedConnectionProposal,
): AdvisorConnectionGrant {
  const consumed = consumeAdvisorConnectionGrantRequest(grant, currentSource, {
    from: proposal.from.selector,
    to: proposal.to.selector,
  });
  validateAdvisorConnectionProposal(consumed, proposal);
  return consumed;
}

export function consumeAdvisorConnectionGrantRequest(
  grant: AdvisorConnectionGrant,
  currentSource: string,
  request: ConnectionPreviewRequest,
): AdvisorConnectionGrant {
  if (grant.consumed) {
    throw new Error('The Wire one gap preview attempt was already consumed. Select the intent again.');
  }
  if (grant.baseline !== currentSource) {
    throw new Error('The circuit source changed after Wire one gap was sent. Select the finding again.');
  }
  const allowed = new Map(grant.endpoints.map((endpoint) => [endpoint.selector, endpoint]));
  const from = allowed.get(request.from);
  const to = allowed.get(request.to);
  if (!from || !to) {
    throw new Error('The connection proposal targets a port outside the exact unconnected evidence authorized at Ask time.');
  }
  if (from.sourcePortId === to.sourcePortId) throw new Error('Wire one gap requires two different authorized ports.');
  if (from.sourceComponentId === to.sourceComponentId) {
    throw new Error('Wire one gap requires endpoints on two different source components.');
  }
  return { ...grant, consumed: true };
}

export function validateAdvisorConnectionProposal(
  grant: AdvisorConnectionGrant,
  proposal: ResolvedConnectionProposal,
): void {
  const allowed = new Map(grant.endpoints.map((endpoint) => [endpoint.selector, endpoint]));
  for (const endpoint of [proposal.from, proposal.to]) {
    const expected = allowed.get(endpoint.selector);
    if (!expected || expected.sourcePortId !== endpoint.sourcePortId || expected.sourceComponentId !== endpoint.sourceComponentId) {
      throw new Error('The resolved connection identity changed after Wire one gap authorization.');
    }
  }
}
