/**
 * Board geometry extraction
 *
 * The quote and enclosure handoff both need the physical board: its outline
 * (width x height) and where the connectors sit. We read that from the PCB side
 * of the Circuit JSON -- the `pcb_board` element when present, else a bounding
 * box of the placed PCB elements -- plus the placed components classified as
 * connectors (headers, jacks) so an enclosure can cut openings for them.
 */

import type { AnyCircuitElement } from '../circuit/circuitJson';

export interface BoardOutline {
  width: number;
  height: number;
  center: { x: number; y: number };
  /** Exact provenance used by readiness automation. */
  source: 'explicit' | 'geometry' | 'default';
  /** Backwards-compatible convenience for quote/enclosure callers. */
  explicit: boolean;
}

export interface ConnectorPlacement {
  name: string;
  ftype?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Board outline in millimetres. Falls back to a bounding box, then a default. */
export function getBoardOutline(
  elements: AnyCircuitElement[],
  options: { ignoreEvaluatedBoard?: boolean } = {},
): BoardOutline {
  const board = options.ignoreEvaluatedBoard ? undefined : elements.find((e) => e.type === 'pcb_board');
  if (board) {
    const w = num(board.width);
    const h = num(board.height);
    const c = board.center as { x?: number; y?: number } | undefined;
    if (w && h) {
      return {
        width: w,
        height: h,
        center: { x: num(c?.x) ?? 0, y: num(c?.y) ?? 0 },
        source: 'explicit',
        explicit: true,
      };
    }
  }
  // Bounding box of any positioned PCB elements.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    if (typeof e.type !== 'string' || !e.type.startsWith('pcb_')) continue;
    if (e.type === 'pcb_board') continue;
    const c = (e.center as { x?: number; y?: number }) ?? { x: num(e.x), y: num(e.y) };
    const x = num(c?.x);
    const y = num(c?.y);
    if (x == null || y == null) continue;
    const w = num(e.width) ?? 1;
    const h = num(e.height) ?? 1;
    minX = Math.min(minX, x - w / 2);
    maxX = Math.max(maxX, x + w / 2);
    minY = Math.min(minY, y - h / 2);
    maxY = Math.max(maxY, y + h / 2);
  }
  if (Number.isFinite(minX)) {
    const pad = 2; // mm margin around parts
    const paddedMinX = minX - pad;
    const paddedMaxX = maxX + pad;
    const paddedMinY = minY - pad;
    const paddedMaxY = maxY + pad;
    // A JSX <board> is origin-centred unless explicitly positioned. Size the
    // inferred envelope symmetrically around that origin so applying the
    // recommendation cannot clip geometry that happens to be off-centre.
    const width = roundUpTenth(Math.max(Math.abs(paddedMinX), Math.abs(paddedMaxX)) * 2);
    const height = roundUpTenth(Math.max(Math.abs(paddedMinY), Math.abs(paddedMaxY)) * 2);
    return {
      width,
      height,
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      source: 'geometry',
      explicit: false,
    };
  }
  return {
    width: 20,
    height: 20,
    center: { x: 0, y: 0 },
    source: 'default',
    explicit: false,
  };
}

function roundUpTenth(value: number): number {
  return Math.ceil((value - Number.EPSILON) * 10) / 10;
}

const CONNECTOR_FTYPES = /pin_header|connector|jack|usb|header|terminal/i;

/** Placed connectors/headers (for enclosure cutouts). */
export function getConnectors(elements: AnyCircuitElement[]): ConnectorPlacement[] {
  // Map source_component_id -> { name, ftype }.
  const src = new Map<string, { name: string; ftype?: string }>();
  for (const e of elements) {
    if (e.type === 'source_component') {
      const id = typeof e.source_component_id === 'string' ? e.source_component_id : undefined;
      if (id) src.set(id, { name: (e.name as string) ?? id, ftype: e.ftype as string | undefined });
    }
  }
  const out: ConnectorPlacement[] = [];
  for (const e of elements) {
    if (e.type !== 'pcb_component') continue;
    const sid = typeof e.source_component_id === 'string' ? e.source_component_id : undefined;
    const meta = sid ? src.get(sid) : undefined;
    if (!meta) continue;
    const isConnector = CONNECTOR_FTYPES.test(meta.ftype ?? '') || CONNECTOR_FTYPES.test(meta.name);
    if (!isConnector) continue;
    const c = (e.center as { x?: number; y?: number }) ?? {};
    out.push({
      name: meta.name,
      ftype: meta.ftype,
      x: num(c.x) ?? 0,
      y: num(c.y) ?? 0,
      width: num(e.width) ?? 5,
      height: num(e.height) ?? 5,
    });
  }
  return out;
}
