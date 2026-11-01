import type { AnyCircuitElement } from './circuitJson.ts';

export const MAX_EVALUATOR_DIAGNOSTICS = 64;
export const MAX_EVALUATOR_DIAGNOSTIC_FIELD_BYTES = 512;
export const MAX_EVALUATOR_RELATED_IDENTITIES = 32;
export const MAX_EVALUATOR_DIAGNOSTIC_TYPES = 32;

export interface EvaluatorDiagnostic {
  id: string;
  idSource: 'evaluated' | 'synthetic-index';
  type: string;
  message: string;
  sourceComponentIds: string[];
  refs: string[];
  pcbComponentIds: string[];
  relatedIdentitiesOmitted?: number;
  location?: { x: number; y: number; source: 'center' | 'component_center' };
}

export interface EvaluatorDiagnosticReport {
  summary: {
    total: number;
    presented: number;
    omitted: number;
    byType: Array<{ type: string; count: number }>;
    otherTypeDiagnostics: number;
  };
  diagnostics: EvaluatorDiagnostic[];
  limitations: string[];
}

const encoder = new TextEncoder();

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function addStrings(value: unknown, target: Set<string>, max: number): number {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  let omitted = 0;
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0 || target.has(item)) continue;
    if (target.size < max) target.add(item);
    else omitted += 1;
  }
  return omitted;
}

function normalizeField(value: string, maxBytes = MAX_EVALUATOR_DIAGNOSTIC_FIELD_BYTES): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unavailable';
  const byteLength = encoder.encode(normalized).length;
  if (byteLength <= maxBytes) return normalized;
  const omitted = byteLength - maxBytes;
  let suffix = `… [${omitted} bytes omitted]`;
  let budget = Math.max(0, maxBytes - encoder.encode(suffix).length);
  let prefix = '';
  for (const codePoint of normalized) {
    const next = prefix + codePoint;
    if (encoder.encode(next).length > budget) break;
    prefix = next;
  }
  const actualOmitted = byteLength - encoder.encode(prefix).length;
  suffix = `… [${actualOmitted} bytes omitted]`;
  budget = Math.max(0, maxBytes - encoder.encode(suffix).length);
  while (encoder.encode(prefix).length > budget) prefix = [...prefix].slice(0, -1).join('');
  return prefix + suffix;
}

function exactErrorId(element: AnyCircuitElement, type: string, index: number): { id: string; idSource: EvaluatorDiagnostic['idSource'] } {
  const preferred = str(element[`${type}_id`]);
  if (preferred) return { id: normalizeField(preferred), idSource: 'evaluated' };
  const fallbackKey = Object.keys(element).filter((key) => key.endsWith('_error_id')).sort()[0];
  const fallback = fallbackKey ? str(element[fallbackKey]) : undefined;
  return fallback
    ? { id: normalizeField(fallback), idSource: 'evaluated' }
    : { id: `${normalizeField(type)}#${index + 1}`, idSource: 'synthetic-index' };
}

function point(element: AnyCircuitElement): EvaluatorDiagnostic['location'] {
  for (const source of ['center', 'component_center'] as const) {
    const value = element[source];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const x = (value as Record<string, unknown>).x;
    const y = (value as Record<string, unknown>).y;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      return { x, y, source };
    }
  }
  return undefined;
}

/**
 * Report only native evaluated `*_error` elements. Relationships are joined
 * through explicit Circuit JSON IDs; messages are never parsed for identity.
 */
export function inspectEvaluatorDiagnostics(elements: AnyCircuitElement[]): EvaluatorDiagnosticReport {
  const sourceById = new Map<string, AnyCircuitElement>();
  const pcbComponentToSource = new Map<string, string>();
  const pcbPrimitiveToComponent = new Map<string, string>();
  for (const element of elements) {
    if (element.type === 'source_component') {
      const id = str(element.source_component_id);
      if (id) sourceById.set(id, element);
    }
    if (element.type === 'pcb_component') {
      const pcbId = str(element.pcb_component_id);
      const sourceId = str(element.source_component_id);
      if (pcbId && sourceId) pcbComponentToSource.set(pcbId, sourceId);
    }
    const pcbComponentId = str(element.pcb_component_id);
    if (pcbComponentId) {
      for (const [key, value] of Object.entries(element)) {
        if (key !== 'pcb_component_id' && key.endsWith('_id') && typeof value === 'string') {
          pcbPrimitiveToComponent.set(value, pcbComponentId);
        }
      }
    }
  }

  const errors: AnyCircuitElement[] = [];
  const byType = new Map<string, number>();
  let total = 0;
  let otherTypeDiagnostics = 0;
  for (const element of elements) {
    if (typeof element.type !== 'string' || !element.type.endsWith('_error')) continue;
    total += 1;
    if (errors.length < MAX_EVALUATOR_DIAGNOSTICS) errors.push(element);
    if (byType.has(element.type)) byType.set(element.type, (byType.get(element.type) ?? 0) + 1);
    else if (byType.size < MAX_EVALUATOR_DIAGNOSTIC_TYPES) byType.set(element.type, 1);
    else otherTypeDiagnostics += 1;
  }

  const diagnostics = errors.slice(0, MAX_EVALUATOR_DIAGNOSTICS).map((element, index): EvaluatorDiagnostic => {
    const pcbComponentIds = new Set<string>();
    const sourceComponentIds = new Set<string>();
    let relatedIdentitiesOmitted = 0;
    for (const [key, value] of Object.entries(element)) {
      if (key === 'source_component_id' || key === 'source_component_ids') {
        relatedIdentitiesOmitted += addStrings(value, sourceComponentIds, MAX_EVALUATOR_RELATED_IDENTITIES);
      }
      if (key === 'pcb_component_id' || key === 'pcb_component_ids') {
        relatedIdentitiesOmitted += addStrings(value, pcbComponentIds, MAX_EVALUATOR_RELATED_IDENTITIES);
      }
      if (key.startsWith('pcb_') && key !== 'pcb_component_id' && key !== 'pcb_component_ids'
        && (key.endsWith('_id') || key.endsWith('_ids'))) {
        const rawIds = new Set<string>();
        relatedIdentitiesOmitted += addStrings(value, rawIds, MAX_EVALUATOR_RELATED_IDENTITIES);
        for (const id of rawIds) {
          const owner = pcbPrimitiveToComponent.get(id);
          if (owner && !pcbComponentIds.has(owner)) {
            if (pcbComponentIds.size < MAX_EVALUATOR_RELATED_IDENTITIES) pcbComponentIds.add(owner);
            else relatedIdentitiesOmitted += 1;
          }
        }
      }
    }
    for (const pcbId of pcbComponentIds) {
      const sourceId = pcbComponentToSource.get(pcbId);
      if (sourceId && !sourceComponentIds.has(sourceId)) {
        if (sourceComponentIds.size < MAX_EVALUATOR_RELATED_IDENTITIES) sourceComponentIds.add(sourceId);
        else relatedIdentitiesOmitted += 1;
      }
    }
    const refs = [...sourceComponentIds]
      .map((id) => str(sourceById.get(id)?.name))
      .filter((value): value is string => Boolean(value));
    const type = normalizeField(element.type);
    const location = point(element);
    return {
      ...exactErrorId(element, element.type, index),
      type,
      message: normalizeField(str(element.message) ?? 'Evaluator error element has no message.'),
      sourceComponentIds: [...sourceComponentIds].map((id) => normalizeField(id)).sort(),
      refs: [...new Set(refs.map((ref) => normalizeField(ref)))].sort(),
      pcbComponentIds: [...pcbComponentIds].map((id) => normalizeField(id)).sort(),
      ...(relatedIdentitiesOmitted > 0 ? { relatedIdentitiesOmitted } : {}),
      ...(location ? { location } : {}),
    };
  });

  return {
    summary: {
      total,
      presented: diagnostics.length,
      omitted: total - diagnostics.length,
      byType: [...byType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, count]) => ({ type: normalizeField(type), count })),
      otherTypeDiagnostics,
    },
    diagnostics,
    limitations: [
      'Exact current Circuit JSON elements whose type ends in _error only; absence is not comprehensive ERC, DRC, DFM, fabrication, manufacturing, or physical validation.',
      'Related parts are joined only through explicit source/PCB element IDs. Diagnostic messages are presentation only and are never parsed for identity.',
      'Synthetic index identities are presentation-local when the evaluator supplies no stable error ID.',
      'Diagnostic, type, and related-identity collections are bounded; every omitted diagnostic or identity is counted instead of inferred.',
    ],
  };
}
