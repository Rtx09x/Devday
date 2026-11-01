import React, { useMemo } from 'react';
import type { ParamDef, ParamValues } from './types';

interface ParamsPanelProps {
  defs: ParamDef[];
  values: ParamValues;
  onChange: (name: string, value: ParamValues[string]) => void;
}

const UNGROUPED = 'Parameters';

// Clamp a typed value into the def's bounds. Returns null for non-finite input
// (empty field, lone '-', partial '1e') so the caller can skip committing NaN —
// otherwise NaN flows into the param values and is debounced straight to the
// kernel, producing a confusing compile error or silent garbage geometry.
function sanitizeNumber(def: Pick<ParamDef, 'min' | 'max'>, raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  let clamped = n;
  if (typeof def.min === 'number') clamped = Math.max(def.min, clamped);
  if (typeof def.max === 'number') clamped = Math.min(def.max, clamped);
  return clamped;
}

function NumberControl({ def, value, onChange }: { def: ParamDef; value: number; onChange: (v: number) => void }) {
  const hasRange = typeof def.min === 'number' && typeof def.max === 'number';
  const commit = (raw: string) => {
    const next = sanitizeNumber(def, raw);
    if (next !== null) onChange(next);
  };
  return (
    <div className="replicad-param-control">
      {hasRange ? (
        <input
          type="range"
          min={def.min}
          max={def.max}
          step={def.step ?? 'any'}
          value={value}
          onChange={(event) => commit(event.target.value)}
        />
      ) : null}
      <input
        id={`param-${def.name}`}
        type="number"
        min={def.min}
        max={def.max}
        step={def.step ?? 'any'}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => commit(event.target.value)}
      />
    </div>
  );
}

function VectorControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
}) {
  const safe: [number, number, number] = Array.isArray(value) ? value : [0, 0, 0];
  return (
    <div className="replicad-param-vector">
      {(['x', 'y', 'z'] as const).map((axis, index) => (
        <label key={axis}>
          <span>{axis}</span>
          <input
            type="number"
            step="any"
            aria-label={`${def.label ?? def.name} ${axis}`}
            value={Number.isFinite(safe[index]) ? safe[index] : ''}
            onChange={(event) => {
              const component = Number(event.target.value);
              if (!Number.isFinite(component)) return;
              const next: [number, number, number] = [...safe] as [number, number, number];
              next[index] = component;
              onChange(next);
            }}
          />
        </label>
      ))}
    </div>
  );
}

export function ParamsPanel({ defs, values, onChange }: ParamsPanelProps): React.ReactElement {
  const groups = useMemo(() => {
    const map = new Map<string, ParamDef[]>();
    for (const def of defs) {
      const key = def.group ?? UNGROUPED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(def);
    }
    return [...map.entries()];
  }, [defs]);

  if (defs.length === 0) {
    return (
      <div className="replicad-params-empty">
        This model exposes no parameters. Export a <code>defaultParams</code> object or a{' '}
        <code>parameterDefinitions</code> descriptor to drive it from here.
      </div>
    );
  }

  return (
    <div className="replicad-params">
      <div className="replicad-params-title">Customizer</div>
      {groups.map(([group, groupDefs]) => (
        <fieldset key={group} className="replicad-param-group">
          <legend>{group}</legend>
          {groupDefs.map((def) => {
            const value = values[def.name] ?? def.default;
            return (
              <div key={def.name} className="replicad-param-row">
                <label className="replicad-param-label" htmlFor={`param-${def.name}`} title={def.description}>
                  {def.label ?? def.name}
                </label>
                {def.kind === 'number' ? (
                  <NumberControl def={def} value={value as number} onChange={(v) => onChange(def.name, v)} />
                ) : def.kind === 'boolean' ? (
                  <input
                    id={`param-${def.name}`}
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(event) => onChange(def.name, event.target.checked)}
                  />
                ) : def.kind === 'enum' ? (
                  <select
                    id={`param-${def.name}`}
                    value={String(value)}
                    onChange={(event) => {
                      // Emit the original option (preserving its type) rather than
                      // the raw string, so numeric/typed enums round-trip correctly.
                      const picked = (def.options ?? []).find((option) => String(option) === event.target.value);
                      onChange(def.name, picked ?? event.target.value);
                    }}
                  >
                    {(def.options ?? []).map((option) => (
                      <option key={String(option)} value={String(option)}>
                        {String(option)}
                      </option>
                    ))}
                  </select>
                ) : def.kind === 'vector' ? (
                  <VectorControl
                    def={def}
                    value={value as [number, number, number]}
                    onChange={(v) => onChange(def.name, v)}
                  />
                ) : (
                  <input
                    id={`param-${def.name}`}
                    type="text"
                    value={String(value)}
                    onChange={(event) => onChange(def.name, event.target.value)}
                  />
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
