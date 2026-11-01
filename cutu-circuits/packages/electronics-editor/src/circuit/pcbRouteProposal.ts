import type { AnyCircuitElement } from './circuitJson';
import type { AutorouteRunResult } from '../tscircuit/AutorouteRunner';
import type { NormalizedAutoroutePoint } from '../tscircuit/autorouteContract';

export interface PcbRouteProposalResult {
  status: 'solved' | 'failed';
  inputHash: string;
  traceCount: number;
  layerCounts: Record<string, number>;
  solverProgress: number;
  diagnostics: string[];
  durationMs: number;
  overlayLineCount: number;
  limitation: string;
}

export interface ActivePcbRouteProposal {
  result: PcbRouteProposalResult;
  overlayElements: AnyCircuitElement[];
}

const COLORS: Record<string, string> = {
  top: '#ff4fb3',
  bottom: '#45d6ff',
  inner1: '#b98cff',
  inner2: '#ffad4f',
  inner3: '#78e08f',
  inner4: '#f6e58d',
  inner5: '#7ed6df',
  inner6: '#e056fd',
};
const FALLBACK_COLORS = ['#ff4fb3', '#45d6ff', '#b98cff', '#ffad4f', '#78e08f'];
export const PCB_ROUTE_PROPOSAL_LIMITATION = 'Candidate copper geometry from the pinned local solver for this exact input projection only; session-only and not applied routing, per-net routing truth, clearance/DRC/DFM, fabrication acceptance, manufacturing, or physical validation.';
const round = (value: number): number => Math.round(value * 1_000) / 1_000;

function colorForLayer(layer: string): string {
  if (COLORS[layer]) return COLORS[layer];
  let hash = 0;
  for (const character of layer) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

function firstWire(route: NormalizedAutoroutePoint[]): Extract<NormalizedAutoroutePoint, { route_type: 'wire' }> | undefined {
  return route.find((point): point is Extract<NormalizedAutoroutePoint, { route_type: 'wire' }> => point.route_type === 'wire');
}

export function buildPcbRouteProposal(run: AutorouteRunResult): ActivePcbRouteProposal {
  if (run.status !== 'solved') throw new Error('A failed autoroute run cannot be shown as a route proposal.');
  const layerCounts: Record<string, number> = {};
  const lines: AnyCircuitElement[] = [];
  run.traces.forEach((trace, traceIndex) => {
    const touchedLayers = new Set<string>();
    let previous: { x: number; y: number; layer: string } | undefined;
    let segmentIndex = 0;
    for (const point of trace.route) {
      if (point.route_type === 'wire') {
        touchedLayers.add(point.layer);
        if (previous?.layer === point.layer && (previous.x !== point.x || previous.y !== point.y)) {
          lines.push({
            type: 'pcb_note_line',
            pcb_note_line_id: `pcb-route-proposal-${traceIndex}-${segmentIndex++}`,
            x1: round(previous.x), y1: round(previous.y), x2: round(point.x), y2: round(point.y),
            layer: point.layer,
            stroke_width: Math.max(0.08, Math.min(0.25, round(point.width))),
            color: colorForLayer(point.layer),
            is_dashed: true,
          });
        }
        previous = { x: point.x, y: point.y, layer: point.layer };
      } else if (point.route_type === 'via') {
        touchedLayers.add(point.from_layer);
        touchedLayers.add(point.to_layer);
        if (previous?.layer === point.from_layer && (previous.x !== point.x || previous.y !== point.y)) {
          lines.push({
            type: 'pcb_note_line',
            pcb_note_line_id: `pcb-route-proposal-${traceIndex}-${segmentIndex++}`,
            x1: round(previous.x), y1: round(previous.y), x2: round(point.x), y2: round(point.y),
            layer: point.from_layer,
            stroke_width: 0.12,
            color: colorForLayer(point.from_layer),
            is_dashed: true,
          });
        }
        previous = { x: point.x, y: point.y, layer: point.to_layer };
      } else {
        touchedLayers.add(point.from_layer);
        touchedLayers.add(point.to_layer);
        if (previous?.layer === point.from_layer && (previous.x !== point.start.x || previous.y !== point.start.y)) {
          lines.push({
            type: 'pcb_note_line',
            pcb_note_line_id: `pcb-route-proposal-${traceIndex}-${segmentIndex++}`,
            x1: round(previous.x), y1: round(previous.y), x2: round(point.start.x), y2: round(point.start.y),
            layer: point.from_layer,
            stroke_width: Math.max(0.08, Math.min(0.25, round(point.width))),
            color: colorForLayer(point.from_layer),
            is_dashed: true,
          });
        }
        if (point.start.x !== point.end.x || point.start.y !== point.end.y) {
          lines.push({
            type: 'pcb_note_line',
            pcb_note_line_id: `pcb-route-proposal-${traceIndex}-${segmentIndex++}`,
            x1: round(point.start.x), y1: round(point.start.y), x2: round(point.end.x), y2: round(point.end.y),
            layer: point.from_layer,
            stroke_width: Math.max(0.08, Math.min(0.25, round(point.width))),
            color: colorForLayer(point.from_layer),
            is_dashed: true,
          });
        }
        previous = { x: point.end.x, y: point.end.y, layer: point.to_layer };
      }
    }
    for (const layer of touchedLayers) layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
  });
  const anchor = run.traces.map((trace) => firstWire(trace.route)).find(Boolean);
  const tag: AnyCircuitElement[] = anchor ? [{
    type: 'pcb_note_text',
    pcb_note_text_id: 'pcb-route-proposal-tag',
    anchor_position: { x: round(anchor.x), y: round(anchor.y) },
    anchor_alignment: 'bottom_left',
    text: `Route proposal · ${run.traces.length} trace${run.traces.length === 1 ? '' : 's'} · ${run.inputHash.slice(0, 8)}`,
    font_size: 0.65,
    layer: anchor.layer,
    color: colorForLayer(anchor.layer),
  }] : [];
  return {
    result: {
      status: 'solved',
      inputHash: run.inputHash,
      traceCount: run.traces.length,
      layerCounts,
      solverProgress: run.solverProgress,
      diagnostics: [...run.diagnostics],
      durationMs: run.durationMs,
      overlayLineCount: lines.length,
      limitation: PCB_ROUTE_PROPOSAL_LIMITATION,
    },
    overlayElements: [...lines, ...tag],
  };
}
