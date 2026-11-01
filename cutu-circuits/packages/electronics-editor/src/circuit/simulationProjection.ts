import type { AnyCircuitElement } from './circuitJson.ts';

export const SIMULATION_PROJECTION_SCHEMA = 'cutucircuits-electronics/simulation-projection@1' as const;

function identityNamespace(key: string): string | undefined {
  if (key === 'subcircuit_connectivity_map_key') return key;
  if (key.endsWith('_ids')) return key.slice(0, -1);
  if (key.endsWith('_id')) return key;
  return undefined;
}

/** Preserve evaluated values and graph topology while normalizing realm-generated IDs and evaluator metadata. */
export function canonicalSimulationProjection(circuitJson: AnyCircuitElement[]): unknown[] {
  const maps = new Map<string, Map<string, string>>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      const namespace = identityNamespace(key);
      if (!namespace) { collect(item); continue; }
      const values = Array.isArray(item) ? item : [item];
      let map = maps.get(namespace);
      if (!map) { map = new Map(); maps.set(namespace, map); }
      for (const candidate of values) {
        if (typeof candidate === 'string' && !map.has(candidate)) map.set(candidate, `${namespace}#${map.size + 1}`);
      }
    }
  };
  collect(circuitJson);
  const transform = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((item) => transform(item, key));
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const childKey of Object.keys(record).sort()) {
      const item = record[childKey];
      if (childKey === 'software_used_string') { result[childKey] = '<evaluator>'; continue; }
      const namespace = identityNamespace(childKey);
      if (!namespace) { result[childKey] = transform(item, childKey); continue; }
      const map = maps.get(namespace)!;
      result[childKey] = Array.isArray(item)
        ? item.map((candidate) => typeof candidate === 'string' ? map.get(candidate) : candidate)
        : typeof item === 'string' ? map.get(item) : item;
    }
    return result;
  };
  return transform(circuitJson) as unknown[];
}
