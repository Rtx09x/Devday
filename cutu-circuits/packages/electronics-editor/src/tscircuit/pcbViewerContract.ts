import type { ComponentProps } from 'react';
import {
  PCBViewer,
  PCB_VIEWER_SELECTION_BRIDGE_VERSION,
  getPcbViewerSelectionAtPoint,
  type PcbViewerSelection,
} from '@tscircuit/pcb-viewer';
import type { AnyCircuitElement } from '../circuit/circuitJson.ts';

export const TSCIRCUIT_PCB_VIEWER_VERSION = '1.11.374' as const;
export const TSCIRCUIT_SELECTION_BRIDGE_VERSION = 'source-component@2' as const;
export const TSCIRCUIT_SELECTION_UPSTREAM_ISSUE = 'pending-upstream-issue' as const;

export type TscircuitPcbViewerProps = ComponentProps<typeof PCBViewer>;

export const READ_ONLY_VIEWER_CONTRACT = {
  allowEditing: false,
  focusOnHover: false,
  clickToInteractEnabled: false,
} satisfies Pick<TscircuitPcbViewerProps, 'allowEditing' | 'focusOnHover' | 'clickToInteractEnabled'>;

export function inspectPcbViewerContract(
  candidate: unknown,
  selectionBridgeVersion: unknown = PCB_VIEWER_SELECTION_BRIDGE_VERSION,
): {
  usable: boolean;
  selectionBridge: 'private-patched' | 'unavailable';
  reason?: string;
} {
  if (typeof candidate !== 'function') {
    return { usable: false, selectionBridge: 'unavailable', reason: 'The pinned PCBViewer export is missing.' };
  }
  if (selectionBridgeVersion !== TSCIRCUIT_SELECTION_BRIDGE_VERSION) {
    return {
      usable: false,
      selectionBridge: 'unavailable',
      reason: `The pinned PCBViewer selection bridge drifted (expected ${TSCIRCUIT_SELECTION_BRIDGE_VERSION}).`,
    };
  }
  return {
    usable: true,
    selectionBridge: 'private-patched',
    reason: `Exact-pinned private source-component selection bridge ${TSCIRCUIT_SELECTION_BRIDGE_VERSION}; upstream public API contribution remains required.`,
  };
}

export type PcbSelectionResolution =
  | { status: 'cleared' }
  | { status: 'selected'; sourceComponentId: string; pcbComponentId: string; ref: string }
  | { status: 'invalid'; reason: string };

/**
 * Validate the patched viewer payload against the exact current Circuit JSON.
 * A stale, ambiguous, or mismatched bridge payload never becomes editor
 * selection authority.
 */
export function resolvePcbViewerSelection(
  circuitJson: AnyCircuitElement[],
  selection: PcbViewerSelection | null,
): PcbSelectionResolution {
  if (selection === null) return { status: 'cleared' };
  if (!selection || typeof selection.source_component_id !== 'string' || typeof selection.pcb_component_id !== 'string') {
    return { status: 'invalid', reason: 'The direct viewer returned an invalid selection payload.' };
  }
  const sources = circuitJson.filter((element) => (
    element.type === 'source_component' && element.source_component_id === selection.source_component_id
  ));
  const pcbs = circuitJson.filter((element) => (
    element.type === 'pcb_component' && element.pcb_component_id === selection.pcb_component_id
  ));
  if (sources.length !== 1 || pcbs.length !== 1) {
    return { status: 'invalid', reason: 'The direct viewer selection no longer resolves uniquely.' };
  }
  const source = sources[0];
  const pcb = pcbs[0];
  if (pcb.source_component_id !== source.source_component_id) {
    return { status: 'invalid', reason: 'The direct viewer PCB/source identity pair does not match.' };
  }
  const ref = typeof source.name === 'string' && source.name.length > 0 ? source.name : selection.source_component_id;
  if (selection.source_component_name && selection.source_component_name !== ref) {
    return { status: 'invalid', reason: 'The direct viewer selection name is stale.' };
  }
  return {
    status: 'selected',
    sourceComponentId: selection.source_component_id,
    pcbComponentId: selection.pcb_component_id,
    ref,
  };
}

export { PCBViewer, PCB_VIEWER_SELECTION_BRIDGE_VERSION, getPcbViewerSelectionAtPoint };
export type { PcbViewerSelection };
