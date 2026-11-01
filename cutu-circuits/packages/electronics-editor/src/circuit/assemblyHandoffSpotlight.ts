import type { AnyCircuitElement } from './circuitJson.ts';
import {
  buildAssemblyHandoffReport,
  type AssemblyHandoffIssueCode,
  type AssemblyHandoffReport,
} from './assemblyHandoff.ts';

export const ASSEMBLY_HANDOFF_SPOTLIGHT_MODES = ['blocked', 'ready', 'all'] as const;
export type AssemblyHandoffSpotlightMode = (typeof ASSEMBLY_HANDOFF_SPOTLIGHT_MODES)[number];
export const MAX_ASSEMBLY_HANDOFF_SPOTLIGHT_PARTS = 128;
export const MAX_ASSEMBLY_HANDOFF_RENDERED_IDS_PER_PART = 4;

export interface AssemblyHandoffSpotlightRequest {
  mode: string;
}

export interface AssemblyHandoffSpotlightFinding {
  sourceComponentId: string;
  ref: string;
  state: 'blocked' | 'ready';
  issueCodes: AssemblyHandoffIssueCode[];
  schematicComponentIds: string[];
  pcbComponentIds: string[];
}

export interface AssemblyHandoffSpotlightResult {
  mode: AssemblyHandoffSpotlightMode;
  findings: AssemblyHandoffSpotlightFinding[];
  reportSummary: AssemblyHandoffReport['summary'];
  counts: {
    total: number;
    blocked: number;
    ready: number;
    schematicMappedParts: number;
    schematicRenderedElements: number;
    pcbMappedParts: number;
    pcbRenderedElements: number;
    schematicUnmappedParts: number;
    pcbUnmappedParts: number;
  };
  template: AssemblyHandoffReport['template'];
  sessionOnly: true;
  readOnly: true;
  sourceChanged: false;
  limitations: string[];
}

export interface ActiveAssemblyHandoffSpotlight {
  source: string;
  result: AssemblyHandoffSpotlightResult;
}

const LIMITATIONS = [
  'Assembly Scout visualizes only the exact current installed-template completeness report; it does not export artifacts or modify source.',
  'Blocked means at least one exact footprint, LCSC/JLCPCB identifier, or PCB placement field is missing, conflicting, ambiguous, invalid, or unsupported.',
  'Ready means only complete for this installed text-template projection, not accepted by a current vendor portal or safe to assemble.',
  'This is not stock, price, orderability, package-orientation, centroid, pin-1, ERC, DRC, DFM, fabrication, assembly, manufacturing, or physical-hardware validation.',
];

function exactMode(value: unknown): AssemblyHandoffSpotlightMode {
  if (typeof value !== 'string' || !ASSEMBLY_HANDOFF_SPOTLIGHT_MODES.includes(value as AssemblyHandoffSpotlightMode)) {
    throw new Error(`Assembly Scout mode must be exactly blocked, ready, or all; received ${JSON.stringify(value)}.`);
  }
  return value as AssemblyHandoffSpotlightMode;
}

function projectedIds(
  elements: AnyCircuitElement[],
  type: 'schematic_component' | 'pcb_component',
  sourceComponentId: string,
): string[] {
  const field = type === 'schematic_component' ? 'schematic_component_id' : 'pcb_component_id';
  const ids = Array.from(new Set(elements
    .filter((element) => element.type === type && element.source_component_id === sourceComponentId)
    .map((element) => element[field])
    .filter((value): value is string => typeof value === 'string' && value.length > 0))).sort();
  if (ids.length > MAX_ASSEMBLY_HANDOFF_RENDERED_IDS_PER_PART) {
    throw new Error(`Assembly Scout found ${ids.length} ${type} identities for one exact part; at most ${MAX_ASSEMBLY_HANDOFF_RENDERED_IDS_PER_PART} are supported.`);
  }
  return ids;
}

export function buildAssemblyHandoffSpotlight(
  elements: AnyCircuitElement[],
  request: AssemblyHandoffSpotlightRequest,
): AssemblyHandoffSpotlightResult {
  const mode = exactMode(request?.mode);
  const report = buildAssemblyHandoffReport(elements);
  if (report.parts.length > MAX_ASSEMBLY_HANDOFF_SPOTLIGHT_PARTS) {
    throw new Error(`Assembly Scout visualizes at most ${MAX_ASSEMBLY_HANDOFF_SPOTLIGHT_PARTS} exact parts; the report contains ${report.parts.length}.`);
  }
  const findings = report.parts
    .filter((part) => mode === 'all' || (mode === 'ready' ? part.readyForTemplate : !part.readyForTemplate))
    .map((part): AssemblyHandoffSpotlightFinding => ({
      sourceComponentId: part.sourceComponentId,
      ref: part.ref,
      state: part.readyForTemplate ? 'ready' : 'blocked',
      issueCodes: part.issues.map((issue) => issue.code),
      schematicComponentIds: projectedIds(elements, 'schematic_component', part.sourceComponentId),
      pcbComponentIds: projectedIds(elements, 'pcb_component', part.sourceComponentId),
    }));
  const blocked = findings.filter((finding) => finding.state === 'blocked').length;
  const ready = findings.length - blocked;
  return {
    mode,
    findings,
    reportSummary: { ...report.summary },
    counts: {
      total: findings.length,
      blocked,
      ready,
      schematicMappedParts: findings.filter((finding) => finding.schematicComponentIds.length > 0).length,
      schematicRenderedElements: findings.reduce((sum, finding) => sum + finding.schematicComponentIds.length, 0),
      pcbMappedParts: findings.filter((finding) => finding.pcbComponentIds.length > 0).length,
      pcbRenderedElements: findings.reduce((sum, finding) => sum + finding.pcbComponentIds.length, 0),
      schematicUnmappedParts: findings.filter((finding) => finding.schematicComponentIds.length === 0).length,
      pcbUnmappedParts: findings.filter((finding) => finding.pcbComponentIds.length === 0).length,
    },
    template: report.template,
    sessionOnly: true,
    readOnly: true,
    sourceChanged: false,
    limitations: [...LIMITATIONS, ...report.limitations],
  };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function assemblyHandoffSpotlightDecorations(
  active: ActiveAssemblyHandoffSpotlight | undefined,
  surface: 'schematic' | 'pcb',
): Array<{ selector: string; className: string }> {
  if (!active) return [];
  return active.result.findings.flatMap((finding) => {
    const ids = surface === 'schematic' ? finding.schematicComponentIds : finding.pcbComponentIds;
    const attribute = surface === 'schematic' ? 'data-schematic-component-id' : 'data-pcb-component-id';
    return ids.map((id) => ({
      selector: `[${attribute}="${escapeAttributeValue(id)}"]`,
      className: `es-assembly-scout-${finding.state}`,
    }));
  });
}
