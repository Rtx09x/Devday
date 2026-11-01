import { listComponents, type AnyCircuitElement } from './circuitJson.ts';
import {
  buildVisualEditSnapshot,
  type AffectedNetPreview,
  type PendingEditPreview,
  type VisualEditSnapshot,
} from './editApproval.ts';
import type { EditHistorySnapshot, EditTransactionSummary } from './editHistory.ts';
import type { ProjectGuidance } from './projectGuidance.ts';
import { buildReadinessReport } from './readiness.ts';

interface RevealBase {
  transactionId: string;
  label: string;
  addedComponents: string[];
  removedComponents: string[];
  affectedNets: AffectedNetPreview[];
  affectedNetCount: number;
}

export interface PendingAgentChangeReveal extends RevealBase {
  phase: 'reevaluating';
  expectedSource: string;
  before: VisualEditSnapshot;
  readinessBefore?: number;
  readinessContextKey?: string;
  /** Added or geometry-targeted source names to emphasize after exact reevaluation. */
  affectedComponentNames: string[];
}

export interface ReadyAgentChangeReveal extends RevealBase {
  phase: 'ready';
  before: VisualEditSnapshot;
  after: VisualEditSnapshot;
  /** Source-component ids that survived into the exact post-edit projection. */
  affectedComponentIds: string[];
  /** Geometry targets that survived the exact post-edit projection. */
  affectedComponentNames: string[];
  /** Exact affected connectivity keys that still exist in the post-edit projection. */
  affectedConnectivityKeys: string[];
  readiness?: { before: number; after: number };
}

export interface FailedAgentChangeReveal extends RevealBase {
  phase: 'failed';
  error?: string;
}

export type AgentChangeReveal = PendingAgentChangeReveal | ReadyAgentChangeReveal | FailedAgentChangeReveal;

export function readinessContextKey(guidance?: ProjectGuidance): string {
  return JSON.stringify(guidance ?? null);
}

export function createPendingAgentChangeReveal(
  transaction: EditTransactionSummary,
  expectedSource: string,
  preview: PendingEditPreview,
): PendingAgentChangeReveal {
  return {
    phase: 'reevaluating',
    transactionId: transaction.id,
    label: transaction.label,
    expectedSource,
    before: preview.visual.before,
    addedComponents: preview.visual.addedComponents,
    removedComponents: preview.visual.removedComponents,
    affectedNets: preview.visual.affectedNets,
    affectedNetCount: preview.visual.affectedNetCount,
    readinessBefore: preview.visual.readinessBefore,
    readinessContextKey: preview.visual.readinessContextKey,
    affectedComponentNames: [...new Set([
      ...preview.visual.addedComponents,
      ...(preview.visual.geometry?.deltas.map((delta) => delta.ref) ?? []),
    ])],
  };
}

export function settleAgentChangeReveal(
  reveal: PendingAgentChangeReveal,
  projection: {
    source: string | null;
    running: boolean;
    ok: boolean;
    error?: string;
    circuitJson: AnyCircuitElement[];
    guidance?: ProjectGuidance;
  },
): AgentChangeReveal {
  if (projection.running || projection.source !== reveal.expectedSource) return reveal;
  const base: RevealBase = {
    transactionId: reveal.transactionId,
    label: reveal.label,
    addedComponents: reveal.addedComponents,
    removedComponents: reveal.removedComponents,
    affectedNets: reveal.affectedNets,
    affectedNetCount: reveal.affectedNetCount,
  };
  if (!projection.ok) return { ...base, phase: 'failed', error: projection.error };

  const components = listComponents(projection.circuitJson);
  const affectedNames = new Set(reveal.affectedComponentNames);
  const survivingComponents = components.filter((component) => affectedNames.has(component.name));
  const exactConnectivityKeys = new Set(projection.circuitJson.flatMap((element) => {
    if (element.type !== 'source_trace') return [];
    return typeof element.subcircuit_connectivity_map_key === 'string' && element.subcircuit_connectivity_map_key.length > 0
      ? [element.subcircuit_connectivity_map_key]
      : [];
  }));
  const sameReadinessContext = reveal.readinessBefore != null
    && reveal.readinessContextKey === readinessContextKey(projection.guidance);
  return {
    ...base,
    phase: 'ready',
    before: reveal.before,
    after: buildVisualEditSnapshot(projection.circuitJson),
    affectedComponentIds: survivingComponents.map((component) => component.id),
    affectedComponentNames: survivingComponents.map((component) => component.name),
    affectedConnectivityKeys: [...new Set(reveal.affectedNets
      .map((net) => net.connectivityKey)
      .filter((key): key is string => typeof key === 'string' && exactConnectivityKeys.has(key)))],
    ...(sameReadinessContext
      ? { readiness: {
          before: reveal.readinessBefore as number,
          after: buildReadinessReport(projection.circuitJson, projection.guidance, projection.source).score,
        } }
      : {}),
  };
}

export function canUndoRevealedTransaction(
  history: EditHistorySnapshot,
  transactionId: string,
): boolean {
  return history.applied.at(-1)?.id === transactionId;
}
