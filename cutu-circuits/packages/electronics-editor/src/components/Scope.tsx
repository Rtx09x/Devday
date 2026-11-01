/**
 * Scope
 *
 * Renders simulation traces as stacked oscilloscope rows in a single SVG.
 * Digital traces draw as step lines between 0 and 1; analog traces autoscale to
 * their min/max. A shared time axis runs along the bottom. Pure presentational:
 * it just turns a SimTrace[] into SVG.
 */

import { useMemo } from 'react';
import type { SimTrace } from '../sim/types';

const ROW_H = 44;
const ROW_GAP = 8;
const PAD_L = 96;
const PAD_R = 16;
const PAD_T = 8;
const AXIS_H = 22;

export function Scope({ traces }: { traces: SimTrace[] }) {
  const layout = useMemo(() => {
    const tMax = traces.reduce((m, tr) => Math.max(m, tr.t[tr.t.length - 1] ?? 0), 0) || 1;
    return { tMax };
  }, [traces]);

  if (!traces.length) {
    return <div className="es-scope-empty">No traces. Run a simulation to see signals here.</div>;
  }

  const width = 720;
  const plotW = width - PAD_L - PAD_R;
  const height = PAD_T + traces.length * (ROW_H + ROW_GAP) + AXIS_H;
  const xFor = (t: number) => PAD_L + (t / layout.tMax) * plotW;

  return (
    <svg className="es-scope" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet">
      {traces.map((tr, i) => {
        const top = PAD_T + i * (ROW_H + ROW_GAP);
        const baseY = top + ROW_H;
        const isDigital = tr.unit === 'digital';
        let lo = 0;
        let hi = 1;
        if (!isDigital) {
          lo = Math.min(...tr.v);
          hi = Math.max(...tr.v);
          if (hi === lo) hi = lo + 1;
        }
        const yFor = (v: number) => baseY - ((v - lo) / (hi - lo)) * (ROW_H - 6);
        let d = '';
        for (let k = 0; k < tr.t.length; k++) {
          const x = xFor(tr.t[k]);
          const y = yFor(tr.v[k]);
          if (k === 0) d += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
          else {
            if (isDigital) d += ` L ${x.toFixed(1)} ${yFor(tr.v[k - 1]).toFixed(1)}`; // step
            d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
          }
        }
        return (
          <g key={`${tr.name}-${i}`}>
            <rect className="es-scope-row" x={PAD_L} y={top} width={plotW} height={ROW_H} />
            <text className="es-scope-label" x={PAD_L - 8} y={top + ROW_H / 2} textAnchor="end" dominantBaseline="middle">
              {tr.name}
            </text>
            <text className="es-scope-unit" x={4} y={top + ROW_H / 2 + 12} dominantBaseline="middle">
              {isDigital ? '0/1' : `${tr.unit}`}
            </text>
            {!isDigital && (
              <>
                <text className="es-scope-tick" x={PAD_L - 8} y={yFor(hi)} textAnchor="end" dominantBaseline="middle">
                  {fmt(hi)}
                </text>
                <text className="es-scope-tick" x={PAD_L - 8} y={yFor(lo)} textAnchor="end" dominantBaseline="middle">
                  {fmt(lo)}
                </text>
              </>
            )}
            <path className={isDigital ? 'es-scope-trace es-scope-digital' : 'es-scope-trace'} d={d} />
          </g>
        );
      })}
      {/* time axis */}
      <line className="es-scope-axis" x1={PAD_L} y1={height - AXIS_H} x2={width - PAD_R} y2={height - AXIS_H} />
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} className="es-scope-time" x={xFor(f * layout.tMax)} y={height - 6} textAnchor="middle">
          {fmtTime(f * layout.tMax)}
        </text>
      ))}
    </svg>
  );
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(1);
  return v.toFixed(2);
}

function fmtTime(s: number): string {
  if (s < 1e-3) return `${(s * 1e6).toFixed(0)}µs`;
  if (s < 1) return `${(s * 1e3).toFixed(1)}ms`;
  return `${s.toFixed(2)}s`;
}
