import { listComponents, listNets, type AnyCircuitElement } from './circuitJson.ts';
import { summarizeSourceChange, type EditDescriptor, type SourceChangeSummary } from './editHistory.ts';
import type { GeometryPreview } from './pcbGeometry.ts';
import type { MountingHolePreview } from './pcbMountingHoles.ts';
import type { KeepoutPreview } from './pcbKeepouts.ts';
import type { ProjectTemplatePreviewMetadata } from './projectTemplates.ts';
import type { ConnectionPreviewMetadata } from './connectionPreview.ts';
import type { AssemblyMetadataBatchPreviewMetadata, AssemblyMetadataPreviewMetadata } from './assemblyMetadataPreview.ts';

export interface VisualEditSnapshot {
  components: number;
  connections: number;
  pcbComponents: number;
  routedCopper: number;
  boardGeometry: number;
}

export const MAX_REVEAL_AFFECTED_NETS = 24;
export const MAX_REVEAL_NET_ENDPOINTS = 16;
export const MAX_REVEAL_NET_LABEL_LENGTH = 160;
export const MAX_REVEAL_NET_ENDPOINT_LENGTH = 160;
export const MAX_REVEAL_CONNECTIVITY_KEY_LENGTH = 256;

export interface AffectedNetPreview {
  change: 'added' | 'removed' | 'changed';
  beforeLabel?: string;
  afterLabel?: string;
  beforeEndpoints: string[];
  afterEndpoints: string[];
  beforeEndpointCount: number;
  afterEndpointCount: number;
  /** Exact rendered-connectivity candidate. It must be re-verified after apply. */
  connectivityKey?: string;
}

export interface VisualEditDiff {
  before: VisualEditSnapshot;
  after: VisualEditSnapshot;
  addedComponents: string[];
  removedComponents: string[];
  /** Bounded exact identities derived from the evaluated before/after projections. */
  affectedNets: AffectedNetPreview[];
  affectedNetCount: number;
  /** Exact pre-edit readiness, present only when the baseline evaluated successfully. */
  readinessBefore?: number;
  /** Identifies the project-guidance context used for the readiness score. */
  readinessContextKey?: string;
  /** Present when either the current or proposed source could not be evaluated. */
  limitation?: string;
  geometry?: GeometryPreview;
  mountingHoles?: MountingHolePreview;
  keepouts?: KeepoutPreview;
  projectTemplate?: ProjectTemplatePreviewMetadata;
  connection?: ConnectionPreviewMetadata;
  assemblyMetadata?: AssemblyMetadataPreviewMetadata;
  assemblyMetadataBatch?: AssemblyMetadataBatchPreviewMetadata;
}

export interface PendingEditPreview extends SourceChangeSummary {
  approvalId: string;
  operation: string;
  label: string;
  createdAt: number;
  visual: VisualEditDiff;
}

interface PendingEdit {
  baseline: string;
  nextSource: string;
  descriptor: EditDescriptor;
  preview: PendingEditPreview;
}

export interface ApprovedEdit {
  nextSource: string;
  descriptor: EditDescriptor;
  preview: PendingEditPreview;
}

/**
 * Session-only approval queue for destructive or broad agent edits.
 *
 * Full source snapshots deliberately never leave this in-memory object. Applying
 * an approval also checks the live source is still byte-for-byte identical to
 * the preview baseline, preventing stale approvals from overwriting later work.
 */
export class EditApprovalQueue {
  private nextId = 1;
  private pending = new Map<string, PendingEdit>();

  stage(
    baseline: string,
    nextSource: string,
    descriptor: EditDescriptor,
    visual: VisualEditDiff,
    now = Date.now(),
  ): PendingEditPreview {
    if (baseline === nextSource) throw new Error('The proposed edit does not change the source.');
    const approvalId = `approval-${this.nextId++}`;
    const preview: PendingEditPreview = {
      approvalId,
      operation: descriptor.operation,
      label: descriptor.label,
      createdAt: now,
      ...summarizeSourceChange(baseline, nextSource),
      visual,
    };
    this.pending.set(approvalId, { baseline, nextSource, descriptor, preview });
    return preview;
  }

  approve(approvalId: string, currentSource: string): ApprovedEdit {
    const edit = this.pending.get(approvalId);
    if (!edit) throw new Error(`No pending edit preview named "${approvalId}" exists.`);
    if (edit.baseline !== currentSource) {
      this.pending.delete(approvalId);
      throw new Error('The circuit changed after this preview was created. Preview the edit again before applying it.');
    }
    this.pending.delete(approvalId);
    return { nextSource: edit.nextSource, descriptor: edit.descriptor, preview: edit.preview };
  }

  cancel(approvalId: string): PendingEditPreview {
    const edit = this.pending.get(approvalId);
    if (!edit) throw new Error(`No pending edit preview named "${approvalId}" exists.`);
    this.pending.delete(approvalId);
    return edit.preview;
  }

  clear(): void {
    this.pending.clear();
  }
}

export function buildVisualEditDiff(
  before: AnyCircuitElement[],
  after: AnyCircuitElement[],
  limitation?: string,
): VisualEditDiff {
  const beforeNames = new Set(listComponents(before).map((component) => component.name));
  const afterNames = new Set(listComponents(after).map((component) => component.name));
  return {
    before: buildVisualEditSnapshot(before),
    after: buildVisualEditSnapshot(after),
    addedComponents: [...afterNames].filter((name) => !beforeNames.has(name)).sort(),
    removedComponents: [...beforeNames].filter((name) => !afterNames.has(name)).sort(),
    ...buildAffectedNetDiff(before, after),
    ...(limitation ? { limitation } : {}),
  };
}

interface EvaluatedNetIdentity {
  label: string;
  endpoints: string[];
  connectivityKey?: string;
  ordinal: number;
}

const exactStringIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];
const exactString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

function evaluatedNetIdentities(elements: AnyCircuitElement[]): EvaluatedNetIdentity[] {
  const components = new Map(elements
    .filter((element) => element.type === 'source_component')
    .flatMap((element) => {
      const id = exactString(element.source_component_id);
      return id ? [[id, exactString(element.name) ?? id] as const] : [];
    }));
  const ports = new Map(elements
    .filter((element) => element.type === 'source_port')
    .flatMap((element) => {
      const id = exactString(element.source_port_id);
      if (!id) return [];
      const component = components.get(exactString(element.source_component_id) ?? '') ?? exactString(element.source_component_id) ?? '?';
      const port = exactString(element.name) ?? (element.pin_number != null ? `pin${element.pin_number}` : id);
      return [[id, `${component}.${port}`] as const];
    }));
  const namedNets = new Map(elements
    .filter((element) => element.type === 'source_net')
    .flatMap((element) => {
      const id = exactString(element.source_net_id);
      return id ? [[id, exactString(element.name) ?? id] as const] : [];
    }));

  const grouped = new Map<string, {
    labels: string[];
    endpoints: string[];
    connectivityKey?: string;
  }>();
  elements.filter((element) => element.type === 'source_trace').forEach((trace, traceOrdinal) => {
    const endpoints = [...new Set(exactStringIds(trace.connected_source_port_ids)
      .map((id) => ports.get(id) ?? id))].sort();
    const namedLabel = exactStringIds(trace.connected_source_net_ids).map((id) => namedNets.get(id)).find(Boolean);
    const connectivityKey = exactString(trace.subcircuit_connectivity_map_key);
    const fallbackId = exactString(trace.source_trace_id) ?? String(traceOrdinal);
    const groupKey = connectivityKey ? `key:${connectivityKey}` : `trace:${fallbackId}`;
    const prior = grouped.get(groupKey);
    grouped.set(groupKey, {
      labels: [...new Set([...(prior?.labels ?? []), ...(namedLabel ? [namedLabel] : []),
        ...(exactString(trace.display_name) ? [exactString(trace.display_name) as string] : [])])].sort(),
      endpoints: [...new Set([...(prior?.endpoints ?? []), ...endpoints])].sort(),
      connectivityKey,
    });
  });
  return [...grouped.values()].map((net, ordinal) => {
    const descriptiveLabel = net.labels.join(' / ') || net.endpoints.join(' ↔ ');
    return {
      label: descriptiveLabel || net.connectivityKey || 'net',
      endpoints: net.endpoints,
      connectivityKey: net.connectivityKey,
      ordinal,
    };
  });
}

function boundedDisplayString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function endpointSide(endpoints: string[]): { endpoints: string[]; count: number } {
  return {
    endpoints: endpoints.slice(0, MAX_REVEAL_NET_ENDPOINTS)
      .map((endpoint) => boundedDisplayString(endpoint, MAX_REVEAL_NET_ENDPOINT_LENGTH)),
    count: endpoints.length,
  };
}

function affectedNet(
  change: AffectedNetPreview['change'],
  before?: EvaluatedNetIdentity,
  after?: EvaluatedNetIdentity,
): AffectedNetPreview {
  const beforeSide = endpointSide(before?.endpoints ?? []);
  const afterSide = endpointSide(after?.endpoints ?? []);
  const stableAcrossChange = before && after && before.connectivityKey === after.connectivityKey
    ? after.connectivityKey
    : undefined;
  const exactConnectivityKey = change === 'added' ? after?.connectivityKey : stableAcrossChange;
  const safeConnectivityKey = exactConnectivityKey && exactConnectivityKey.length <= MAX_REVEAL_CONNECTIVITY_KEY_LENGTH
    ? exactConnectivityKey
    : undefined;
  return {
    change,
    ...(before ? { beforeLabel: boundedDisplayString(before.label, MAX_REVEAL_NET_LABEL_LENGTH) } : {}),
    ...(after ? { afterLabel: boundedDisplayString(after.label, MAX_REVEAL_NET_LABEL_LENGTH) } : {}),
    beforeEndpoints: beforeSide.endpoints,
    afterEndpoints: afterSide.endpoints,
    beforeEndpointCount: beforeSide.count,
    afterEndpointCount: afterSide.count,
    ...(safeConnectivityKey ? { connectivityKey: safeConnectivityKey } : {}),
  };
}

export function buildAffectedNetDiff(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
): Pick<VisualEditDiff, 'affectedNets' | 'affectedNetCount'> {
  const before = evaluatedNetIdentities(beforeElements);
  const after = evaluatedNetIdentities(afterElements);
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const affected: AffectedNetPreview[] = [];

  // A stable Circuit JSON connectivity key is the strongest exact identity.
  for (const prior of before) {
    if (!prior.connectivityKey) continue;
    const next = after.find((candidate) => !usedAfter.has(candidate.ordinal)
      && candidate.connectivityKey === prior.connectivityKey);
    if (!next) continue;
    usedBefore.add(prior.ordinal);
    usedAfter.add(next.ordinal);
    if (prior.label !== next.label || prior.endpoints.join('\u0000') !== next.endpoints.join('\u0000')) {
      affected.push(affectedNet('changed', prior, next));
    }
  }

  // Remove unchanged same-label/same-endpoint nets before pairing endpoint changes.
  for (const prior of before) {
    if (usedBefore.has(prior.ordinal)) continue;
    const next = after.find((candidate) => !usedAfter.has(candidate.ordinal)
      && candidate.label === prior.label
      && candidate.endpoints.join('\u0000') === prior.endpoints.join('\u0000'));
    if (!next) continue;
    usedBefore.add(prior.ordinal);
    usedAfter.add(next.ordinal);
  }
  const unmatchedBeforeByLabel = new Map<string, EvaluatedNetIdentity[]>();
  const unmatchedAfterByLabel = new Map<string, EvaluatedNetIdentity[]>();
  for (const prior of before) if (!usedBefore.has(prior.ordinal)) {
    unmatchedBeforeByLabel.set(prior.label, [...(unmatchedBeforeByLabel.get(prior.label) ?? []), prior]);
  }
  for (const next of after) if (!usedAfter.has(next.ordinal)) {
    unmatchedAfterByLabel.set(next.label, [...(unmatchedAfterByLabel.get(next.label) ?? []), next]);
  }
  for (const [label, priors] of unmatchedBeforeByLabel) {
    const next = unmatchedAfterByLabel.get(label);
    if (priors.length !== 1 || next?.length !== 1) continue;
    usedBefore.add(priors[0].ordinal);
    usedAfter.add(next[0].ordinal);
    affected.push(affectedNet('changed', priors[0], next[0]));
  }
  for (const prior of before) if (!usedBefore.has(prior.ordinal)) affected.push(affectedNet('removed', prior));
  for (const next of after) if (!usedAfter.has(next.ordinal)) affected.push(affectedNet('added', undefined, next));

  affected.sort((a, b) => `${a.afterLabel ?? a.beforeLabel}:${a.change}`.localeCompare(`${b.afterLabel ?? b.beforeLabel}:${b.change}`));
  return { affectedNets: affected.slice(0, MAX_REVEAL_AFFECTED_NETS), affectedNetCount: affected.length };
}

export function buildVisualEditSnapshot(elements: AnyCircuitElement[]): VisualEditSnapshot {
  const count = (...types: string[]) => elements.filter((element) => types.includes(element.type)).length;
  return {
    components: listComponents(elements).length,
    connections: listNets(elements).length,
    pcbComponents: count('pcb_component'),
    routedCopper: count('pcb_trace', 'pcb_via'),
    boardGeometry: count('pcb_board', 'pcb_board_outline', 'pcb_hole', 'pcb_keepout'),
  };
}
