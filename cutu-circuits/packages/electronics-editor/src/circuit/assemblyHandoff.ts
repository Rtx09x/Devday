import type { AnyCircuitElement } from './circuitJson.ts';

export const ASSEMBLY_HANDOFF_SCHEMA = 'cutucircuits-electronics/assembly-handoff@1' as const;
export const MAX_ASSEMBLY_HANDOFF_PARTS = 512;
export const MAX_ASSEMBLY_HANDOFF_ELEMENTS = 4_096;
export const MAX_ASSEMBLY_REF_BYTES = 160;
export const MAX_ASSEMBLY_ID_BYTES = 240;
export const MAX_ASSEMBLY_FIELD_BYTES = 512;

export type AssemblyHandoffIssueCode =
  | 'missing-footprint'
  | 'conflicting-footprint'
  | 'missing-lcsc-part-number'
  | 'ambiguous-lcsc-part-number'
  | 'missing-pcb-placement'
  | 'ambiguous-pcb-placement'
  | 'incomplete-pcb-placement'
  | 'unsupported-pcb-layer';

export interface AssemblyPlacement {
  xMm: number;
  yMm: number;
  layer: 'top' | 'bottom';
  rotationDeg: number;
  layerSource: 'evaluated' | 'default-top';
  rotationSource: 'evaluated' | 'default-zero';
}

export interface AssemblyHandoffPart {
  ref: string;
  sourceComponentId: string;
  footprint?: string;
  lcscPartNumber?: string;
  placement?: AssemblyPlacement;
  issues: Array<{ code: AssemblyHandoffIssueCode; detail: string }>;
  readyForTemplate: boolean;
}

export interface AssemblyHandoffReport {
  schema: typeof ASSEMBLY_HANDOFF_SCHEMA;
  template: 'jlcpcb-bom-cpl';
  parts: AssemblyHandoffPart[];
  summary: {
    total: number;
    ready: number;
    blocked: number;
    missingFootprint: number;
    missingOrAmbiguousLcscPartNumber: number;
    missingOrInvalidPlacement: number;
  };
  limitations: string[];
}

function exactText(value: unknown, label: string, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Assembly handoff ${label} contains control characters.`);
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > maxBytes) {
    throw new Error(`Assembly handoff ${label} exceeds ${maxBytes} UTF-8 bytes.`);
  }
  return value;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function exactUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

function supplierCandidates(source: AnyCircuitElement): string[] {
  const suppliers = source.supplier_part_numbers;
  if (!suppliers || typeof suppliers !== 'object' || Array.isArray(suppliers)) return [];
  const values: string[] = [];
  for (const [key, candidate] of Object.entries(suppliers as Record<string, unknown>)) {
    if (!['lcsc', 'jlcpcb'].includes(key.toLowerCase())) continue;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const value = exactText(item, 'supplier part number', MAX_ASSEMBLY_FIELD_BYTES);
        if (value) values.push(value);
      }
    } else if (typeof candidate === 'string' && candidate) {
      values.push(exactText(candidate, 'supplier part number', MAX_ASSEMBLY_FIELD_BYTES)!);
    }
  }
  return exactUnique(values);
}

function resolvePlacement(element: AnyCircuitElement): { placement?: AssemblyPlacement; issue?: AssemblyHandoffPart['issues'][number] } {
  const center = element.center && typeof element.center === 'object' && !Array.isArray(element.center)
    ? element.center as Record<string, unknown>
    : {};
  const xMm = finite(element.x) ?? finite(center.x);
  const yMm = finite(element.y) ?? finite(center.y);
  if (xMm == null || yMm == null) {
    return { issue: { code: 'incomplete-pcb-placement', detail: 'The evaluated pcb_component has no finite X/Y center.' } };
  }
  const rawLayer = exactText(element.layer, 'placement layer', 32);
  if (rawLayer && rawLayer !== 'top' && rawLayer !== 'bottom') {
    return { issue: { code: 'unsupported-pcb-layer', detail: 'The evaluated placement layer is not top or bottom.' } };
  }
  const rawRotation = element.rotation;
  const rotation = rawRotation == null ? 0 : finite(rawRotation);
  if (rotation == null) {
    return { issue: { code: 'incomplete-pcb-placement', detail: 'The evaluated pcb_component rotation is not finite.' } };
  }
  return {
    placement: {
      xMm,
      yMm,
      layer: rawLayer === 'bottom' ? 'bottom' : 'top',
      rotationDeg: rotation,
      layerSource: rawLayer ? 'evaluated' : 'default-top',
      rotationSource: rawRotation == null ? 'default-zero' : 'evaluated',
    },
  };
}

export function buildAssemblyHandoffReport(elements: AnyCircuitElement[]): AssemblyHandoffReport {
  if (elements.length > MAX_ASSEMBLY_HANDOFF_ELEMENTS) {
    throw new Error(`Assembly handoff supports at most ${MAX_ASSEMBLY_HANDOFF_ELEMENTS} Circuit JSON elements.`);
  }
  const sources = elements.filter((element) => element.type === 'source_component');
  if (sources.length > MAX_ASSEMBLY_HANDOFF_PARTS) {
    throw new Error(`Assembly handoff supports at most ${MAX_ASSEMBLY_HANDOFF_PARTS} placed source components.`);
  }
  const sourceIds = sources.map((source) => exactText(source.source_component_id, 'source component ID', MAX_ASSEMBLY_ID_BYTES));
  const refs = sources.map((source) => exactText(source.name, 'source component ref', MAX_ASSEMBLY_REF_BYTES));
  if (sourceIds.some((id) => !id) || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('Assembly handoff requires one non-empty unique source_component_id per placed part.');
  }
  if (refs.some((ref) => !ref) || new Set(refs).size !== refs.length) {
    throw new Error('Assembly handoff requires one non-empty unique source-component ref per placed part.');
  }

  const cadBySource = new Map<string, string[]>();
  const pcbBySource = new Map<string, AnyCircuitElement[]>();
  for (const element of elements) {
    const sourceId = exactText(element.source_component_id, 'source component ID', MAX_ASSEMBLY_ID_BYTES);
    if (!sourceId) continue;
    if (element.type === 'cad_component') {
      const footprint = exactText(element.footprinter_string, 'evaluated CAD footprint', MAX_ASSEMBLY_FIELD_BYTES);
      if (footprint) cadBySource.set(sourceId, [...(cadBySource.get(sourceId) ?? []), footprint]);
    }
    if (element.type === 'pcb_component') {
      pcbBySource.set(sourceId, [...(pcbBySource.get(sourceId) ?? []), element]);
    }
  }

  const parts = sources.map((source): AssemblyHandoffPart => {
    const sourceComponentId = exactText(source.source_component_id, 'source component ID', MAX_ASSEMBLY_ID_BYTES)!;
    const ref = exactText(source.name, 'source component ref', MAX_ASSEMBLY_REF_BYTES)!;
    const issues: AssemblyHandoffPart['issues'] = [];
    const footprints = exactUnique([
      exactText(source.footprint, 'source footprint', MAX_ASSEMBLY_FIELD_BYTES),
      ...(cadBySource.get(sourceComponentId) ?? []),
    ]);
    const footprint = footprints.length === 1 ? footprints[0] : undefined;
    if (footprints.length === 0) {
      issues.push({ code: 'missing-footprint', detail: 'No exact source or evaluated CAD footprint is present.' });
    } else if (footprints.length > 1) {
      issues.push({ code: 'conflicting-footprint', detail: `${footprints.length} exact source/evaluated footprint candidates conflict.` });
    }

    const lcscCandidates = supplierCandidates(source);
    const lcscPartNumber = lcscCandidates.length === 1 ? lcscCandidates[0] : undefined;
    if (lcscCandidates.length === 0) {
      issues.push({ code: 'missing-lcsc-part-number', detail: 'No exact LCSC/JLCPCB supplier part number is declared.' });
    } else if (lcscCandidates.length > 1) {
      issues.push({ code: 'ambiguous-lcsc-part-number', detail: `${lcscCandidates.length} exact LCSC/JLCPCB candidates are declared.` });
    }

    const pcbCandidates = pcbBySource.get(sourceComponentId) ?? [];
    let placement: AssemblyPlacement | undefined;
    if (pcbCandidates.length === 0) {
      issues.push({ code: 'missing-pcb-placement', detail: 'No evaluated pcb_component placement is present.' });
    } else if (pcbCandidates.length > 1) {
      issues.push({ code: 'ambiguous-pcb-placement', detail: `${pcbCandidates.length} evaluated pcb_component placements share this source identity.` });
    } else {
      const resolved = resolvePlacement(pcbCandidates[0]);
      placement = resolved.placement;
      if (resolved.issue) issues.push(resolved.issue);
    }

    return {
      ref,
      sourceComponentId,
      ...(footprint ? { footprint } : {}),
      ...(lcscPartNumber ? { lcscPartNumber } : {}),
      ...(placement ? { placement } : {}),
      issues,
      readyForTemplate: issues.length === 0,
    };
  }).sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceComponentId.localeCompare(b.sourceComponentId));

  return {
    schema: ASSEMBLY_HANDOFF_SCHEMA,
    template: 'jlcpcb-bom-cpl',
    parts,
    summary: {
      total: parts.length,
      ready: parts.filter((part) => part.readyForTemplate).length,
      blocked: parts.filter((part) => !part.readyForTemplate).length,
      missingFootprint: parts.filter((part) => part.issues.some((issue) => issue.code === 'missing-footprint' || issue.code === 'conflicting-footprint')).length,
      missingOrAmbiguousLcscPartNumber: parts.filter((part) => part.issues.some((issue) => issue.code === 'missing-lcsc-part-number' || issue.code === 'ambiguous-lcsc-part-number')).length,
      missingOrInvalidPlacement: parts.filter((part) => part.issues.some((issue) => issue.code.includes('placement') || issue.code === 'unsupported-pcb-layer')).length,
    },
    limitations: [
      'This is a deterministic completeness check for the installed JLC-style BOM/CPL text template, not confirmation that a current vendor portal will accept or assemble it.',
      'It does not validate package orientation, centroid convention, pin 1, rotation correction, stock, price, minimum order, substitutions, panelization, ERC, DRC, DFM, fabrication, assembly, or physical hardware.',
      'Missing fields remain explicit blockers; no footprint, supplier part number, placement, layer, or rotation is guessed from ref names or nearby geometry.',
      'An omitted evaluated layer or rotation uses the Circuit JSON defaults top and zero degrees and reports that provenance on the exact part row.',
    ],
  };
}
