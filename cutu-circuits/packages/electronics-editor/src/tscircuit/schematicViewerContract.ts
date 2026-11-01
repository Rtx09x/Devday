import type { ComponentProps } from 'react';
import { SchematicViewer } from '@tscircuit/schematic-viewer';
import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import {
  buildCircuitIndex,
  withDecollidedNetLabels,
  withReadableNetLabels,
} from '../circuit/circuitJson.ts';

export const TSCIRCUIT_SCHEMATIC_VIEWER_VERSION = '2.0.69' as const;
export const ASSEMBLY_VIEWER_SELECTION_BRIDGE_VERSION = 'assembly-label@1' as const;

export type TscircuitSchematicViewerProps = ComponentProps<typeof SchematicViewer>;

/** Keep the interactive viewer and deterministic image export on one label-layout pipeline. */
export function prepareSchematicViewerCircuitJson(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  return withDecollidedNetLabels(withReadableNetLabels(circuitJson));
}

export function inspectSchematicViewerContract(candidate: unknown): { usable: boolean; reason?: string } {
  if (typeof candidate !== 'function') {
    return { usable: false, reason: 'The pinned SchematicViewer export is missing.' };
  }
  return { usable: true };
}

export type SchematicViewerSelection =
  | { status: 'component'; sourceComponentId: string }
  | { status: 'port'; sourcePortId: string; selector: string }
  | { status: 'invalid'; reason: string };

type ComponentSelection = Extract<SchematicViewerSelection, { status: 'component' | 'invalid' }>;
type PortSelection = Extract<SchematicViewerSelection, { status: 'port' | 'invalid' }>;

export type AssemblyViewerSelection =
  | { status: 'component'; sourceComponentId: string; pcbComponentId: string; ref: string }
  | { status: 'invalid'; reason: string };

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveAssemblySource(
  circuitJson: AnyCircuitElement[],
  sourceComponentId: string,
): AssemblyViewerSelection {
  const sources = circuitJson.filter((element) => (
    element.type === 'source_component'
      && element.source_component_id === sourceComponentId
      && typeof element.name === 'string'
      && element.name.length > 0
  ));
  if (sources.length !== 1) {
    return { status: 'invalid', reason: 'The assembly selection did not resolve to one exact named source component.' };
  }
  const ref = sources[0].name as string;
  const duplicateLabels = circuitJson.filter((element) => (
    element.type === 'source_component' && element.name === ref
  ));
  if (duplicateLabels.length !== 1) {
    return { status: 'invalid', reason: 'The assembly viewer label is ambiguous in the current projection.' };
  }
  const pcbComponents = circuitJson.filter((element) => {
    if (element.type !== 'pcb_component'
      || element.source_component_id !== sourceComponentId
      || typeof element.pcb_component_id !== 'string') return false;
    const center = element.center as { x?: unknown; y?: unknown } | undefined;
    return Boolean(center)
      && finiteNumber(center?.x)
      && finiteNumber(center?.y)
      && finiteNumber(element.width)
      && finiteNumber(element.height);
  });
  if (pcbComponents.length !== 1) {
    return { status: 'invalid', reason: 'The assembly selection did not resolve to one exact rendered PCB component.' };
  }
  const pcbComponentId = pcbComponents[0].pcb_component_id as string;
  const ports = circuitJson.filter((element) => (
    element.type === 'pcb_port' && element.pcb_component_id === pcbComponentId
  ));
  if (ports.length === 0) {
    return { status: 'invalid', reason: 'The assembly viewer cannot render this component without an exact PCB port.' };
  }
  return { status: 'component', sourceComponentId, pcbComponentId, ref };
}

/**
 * Translate the exact label emitted by the circuit-to-svg assembly drawing
 * back to stable Circuit JSON identity. The bridge deliberately refuses
 * duplicate labels, duplicate PCB identities, and elements the installed
 * renderer cannot draw.
 */
export function resolveAssemblyComponentLabel(
  circuitJson: AnyCircuitElement[],
  label: string,
): AssemblyViewerSelection {
  const sources = circuitJson.filter((element) => (
    element.type === 'source_component'
      && element.name === label
      && typeof element.source_component_id === 'string'
  ));
  if (sources.length !== 1) {
    return { status: 'invalid', reason: 'The assembly viewer label did not resolve to one exact source component.' };
  }
  return resolveAssemblySource(circuitJson, sources[0].source_component_id as string);
}

export function resolveAssemblySourceComponent(
  circuitJson: AnyCircuitElement[],
  sourceComponentId: string,
): AssemblyViewerSelection {
  return resolveAssemblySource(circuitJson, sourceComponentId);
}

export function resolveSchematicComponentClick(
  circuitJson: AnyCircuitElement[],
  schematicComponentId: string,
): ComponentSelection {
  const matches = circuitJson.filter((element) => (
    element.type === 'schematic_component'
      && element.schematic_component_id === schematicComponentId
      && typeof element.source_component_id === 'string'
  ));
  if (matches.length !== 1) {
    return { status: 'invalid', reason: 'The upstream schematic click did not resolve to one exact source component.' };
  }
  return { status: 'component', sourceComponentId: matches[0].source_component_id as string };
}

export function resolveSchematicPortClick(
  circuitJson: AnyCircuitElement[],
  viewerPortId: string,
): PortSelection {
  // 2.0.69 names the callback value `schematicPortId`, but its mounted mouse
  // target currently emits `source_port_id`. Accept either exact public shape
  // while the upstream naming mismatch is corrected; never infer from labels.
  const matches = circuitJson.filter((element) => (
    element.type === 'schematic_port'
      && (element.schematic_port_id === viewerPortId || element.source_port_id === viewerPortId)
      && typeof element.source_port_id === 'string'
  ));
  if (matches.length !== 1) {
    return { status: 'invalid', reason: 'The upstream schematic port click did not resolve to one exact source selector.' };
  }
  const sourcePortId = matches[0].source_port_id as string;
  const selector = buildCircuitIndex(circuitJson).portConnectionSelector(sourcePortId);
  if (!selector) {
    return { status: 'invalid', reason: 'The upstream schematic port click did not resolve to one exact source selector.' };
  }
  return { status: 'port', sourcePortId, selector };
}

export { SchematicViewer };
