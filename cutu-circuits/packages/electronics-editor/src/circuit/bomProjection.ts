import {
  buildAssemblyHandoffReport,
  type AssemblyHandoffIssueCode,
  type AssemblyHandoffPart,
  type AssemblyHandoffReport,
} from './assemblyHandoff.ts';
import type { AnyCircuitElement } from './circuitJson.ts';

export const BOM_PROJECTION_SCHEMA = 'cutucircuits-electronics/bom-projection@1' as const;

export interface BomSupplierNumber {
  provider: string;
  value: string;
}

export interface BomProjectionRef {
  ref: string;
  sourceComponentId: string;
  supplierNumbers: BomSupplierNumber[];
  placementComplete: boolean;
  readyForAssemblyTemplate: boolean;
  blockers: Array<{ code: AssemblyHandoffIssueCode; detail: string }>;
}

export interface BomProjectionLine {
  key: string;
  comment: string;
  footprint: string;
  manufacturerPartNumber: string;
  lcscPartNumber: string;
  refs: BomProjectionRef[];
  quantity: number;
  readyRefs: number;
  blockedRefs: number;
  blockerCodes: AssemblyHandoffIssueCode[];
}

export interface BomProjection {
  schema: typeof BOM_PROJECTION_SCHEMA;
  projectionKey: string;
  lines: BomProjectionLine[];
  assemblyHandoff: AssemblyHandoffReport;
  summary: {
    lineItems: number;
    totalParts: number;
    readyParts: number;
    blockedParts: number;
    missingFootprint: number;
    missingSupplierNumber: number;
    missingOrInvalidPlacement: number;
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function prettyType(value?: string): string | undefined {
  return value?.replace(/^simple_/, '').replace(/_/g, ' ');
}

function manufacturerPart(element: AnyCircuitElement): string {
  return text(element.manufacturer_part_number) ?? text(element.manufacturerPartNumber) ?? '';
}

function componentValue(element: AnyCircuitElement): string {
  return (
    text(element.display_value)
    ?? text(element.resistance)
    ?? text(element.capacitance)
    ?? text(element.inductance)
    ?? (typeof element.resistance === 'number' ? `${element.resistance}` : undefined)
    ?? manufacturerPart(element)
    ?? prettyType(text(element.ftype))
    ?? ''
  );
}

function supplierNumbers(element: AnyCircuitElement): BomSupplierNumber[] {
  const declared = element.supplier_part_numbers;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return [];
  const values: BomSupplierNumber[] = [];
  for (const [provider, candidate] of Object.entries(declared as Record<string, unknown>)) {
    const items = Array.isArray(candidate) ? candidate : [candidate];
    for (const item of items) {
      if (typeof item === 'string' && item.length > 0) values.push({ provider, value: item });
    }
  }
  return values.sort((a, b) => a.provider.localeCompare(b.provider) || a.value.localeCompare(b.value));
}

function refFromPart(part: AssemblyHandoffPart, source: AnyCircuitElement): BomProjectionRef {
  return {
    ref: part.ref,
    sourceComponentId: part.sourceComponentId,
    supplierNumbers: supplierNumbers(source),
    placementComplete: Boolean(part.placement),
    readyForAssemblyTemplate: part.readyForTemplate,
    blockers: part.issues.map((issue) => ({ ...issue })),
  };
}

/**
 * One immutable BOM/assembly projection for UI, exports, review packets, and
 * agent inspection. It intentionally reuses the exact assembly handoff report
 * instead of re-deriving footprint, supplier, or placement completeness.
 */
export function buildBomProjection(
  circuitJson: AnyCircuitElement[],
  assemblyHandoff = buildAssemblyHandoffReport(circuitJson),
): BomProjection {
  const sourceById = new Map(circuitJson.flatMap((element) => {
    if (element.type !== 'source_component') return [];
    const id = text(element.source_component_id);
    return id ? [[id, element] as const] : [];
  }));
  const byKey = new Map<string, Omit<BomProjectionLine, 'quantity' | 'readyRefs' | 'blockedRefs' | 'blockerCodes'>>();

  for (const part of assemblyHandoff.parts) {
    const source = sourceById.get(part.sourceComponentId);
    if (!source) throw new Error(`BOM projection cannot resolve source component ${part.sourceComponentId}.`);
    const comment = componentValue(source);
    const footprint = part.footprint ?? text(source.footprint) ?? '';
    const manufacturerPartNumber = manufacturerPart(source);
    const lcscPartNumber = part.lcscPartNumber ?? '';
    const key = JSON.stringify([comment, footprint, lcscPartNumber, manufacturerPartNumber]);
    const current = byKey.get(key);
    const ref = refFromPart(part, source);
    if (current) current.refs.push(ref);
    else byKey.set(key, { key, comment, footprint, manufacturerPartNumber, lcscPartNumber, refs: [ref] });
  }

  const lines = [...byKey.values()].map((line): BomProjectionLine => {
    const refs = [...line.refs].sort((a, b) => a.ref.localeCompare(b.ref));
    const blockerCodes = [...new Set(refs.flatMap((ref) => ref.blockers.map((blocker) => blocker.code)))]
      .sort((a, b) => a.localeCompare(b));
    const readyRefs = refs.filter((ref) => ref.readyForAssemblyTemplate).length;
    return {
      ...line,
      refs,
      quantity: refs.length,
      readyRefs,
      blockedRefs: refs.length - readyRefs,
      blockerCodes,
    };
  }).sort((a, b) => a.refs[0].ref.localeCompare(b.refs[0].ref));

  const summary = {
    lineItems: lines.length,
    totalParts: assemblyHandoff.summary.total,
    readyParts: assemblyHandoff.summary.ready,
    blockedParts: assemblyHandoff.summary.blocked,
    missingFootprint: assemblyHandoff.summary.missingFootprint,
    missingSupplierNumber: assemblyHandoff.summary.missingOrAmbiguousLcscPartNumber,
    missingOrInvalidPlacement: assemblyHandoff.summary.missingOrInvalidPlacement,
  };
  const projectionKey = JSON.stringify({ schema: BOM_PROJECTION_SCHEMA, lines, summary });
  return { schema: BOM_PROJECTION_SCHEMA, projectionKey, lines, assemblyHandoff, summary };
}
