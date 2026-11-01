import type { AnyCircuitElement } from './circuitJson.ts';
import { extractPcbGeometry, type PcbRect } from './pcbGeometry.ts';

export type PcbMeasurementMode = 'center' | 'edge' | 'board';

export interface PcbMeasurementRequest {
  mode: PcbMeasurementMode;
  fromRef: string;
  toRef?: string;
}

export interface PcbPoint {
  x: number;
  y: number;
}

interface MeasurementBase {
  mode: PcbMeasurementMode;
  units: 'mm';
  precisionMm: 0.001;
  from: PcbRect;
  limitation: string;
}

export interface CenterPcbMeasurement extends MeasurementBase {
  mode: 'center';
  to: PcbRect;
  endpoints: { from: PcbPoint; to: PcbPoint };
  dxMm: number;
  dyMm: number;
  distanceMm: number;
  relation: 'distinct' | 'coincident';
}

export interface EdgePcbMeasurement extends MeasurementBase {
  mode: 'edge';
  to: PcbRect;
  closestPoints: { from: PcbPoint; to: PcbPoint };
  distanceMm: number;
  relation: 'separated' | 'touching' | 'overlapping';
}

export type BoardSide = 'left' | 'right' | 'bottom' | 'top';

export interface BoardPcbMeasurement extends MeasurementBase {
  mode: 'board';
  board: { x: number; y: number; width: number; height: number };
  clearancesMm: Record<BoardSide, number>;
  minimum: { side: BoardSide; clearanceMm: number };
  relation: 'inside' | 'touching' | 'outside';
}

export type PcbMeasurementResult = CenterPcbMeasurement | EdgePcbMeasurement | BoardPcbMeasurement;

export interface ActivePcbMeasurement {
  result: PcbMeasurementResult;
  overlayElements: AnyCircuitElement[];
}

const LIMITATION = 'Evaluated PCB bounding rectangles only; not courtyard, package-body, copper, routing, keep-out, clearance, collision, DRC, or DFM evidence.';
const EPSILON = 1e-9;
const OVERLAY_COLOR = '#ffb84d';

const round = (value: number): number => Math.round(value * 1000) / 1000;
const point = (value: PcbPoint): PcbPoint => ({ x: round(value.x), y: round(value.y) });
const rect = (value: PcbRect): PcbRect => ({
  ...value,
  x: round(value.x),
  y: round(value.y),
  width: round(value.width),
  height: round(value.height),
  rotation: round(value.rotation ?? 0),
});

function validateRequest(request: PcbMeasurementRequest): Required<Pick<PcbMeasurementRequest, 'mode' | 'fromRef'>> & Pick<PcbMeasurementRequest, 'toRef'> {
  if (!['center', 'edge', 'board'].includes(request.mode)) throw new Error('Measurement mode must be "center", "edge", or "board".');
  const fromRef = request.fromRef?.trim();
  const toRef = request.toRef?.trim();
  if (!fromRef) throw new Error('A case-sensitive exact from_ref is required.');
  if (request.mode === 'board') {
    if (toRef) throw new Error('Board-edge measurement does not accept to_ref.');
    return { mode: request.mode, fromRef };
  }
  if (!toRef) throw new Error(`${request.mode} measurement requires a case-sensitive exact to_ref.`);
  if (fromRef === toRef) throw new Error('Part-to-part measurement requires two different exact refs.');
  return { mode: request.mode, fromRef, toRef };
}

function corners(value: PcbRect): PcbPoint[] {
  const angle = (value.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    { x: -value.width / 2, y: -value.height / 2 },
    { x: value.width / 2, y: -value.height / 2 },
    { x: value.width / 2, y: value.height / 2 },
    { x: -value.width / 2, y: value.height / 2 },
  ].map(({ x, y }) => ({ x: value.x + x * cos - y * sin, y: value.y + x * sin + y * cos }));
}

function axes(points: PcbPoint[]): PcbPoint[] {
  return [0, 1].map((index) => {
    const edge = { x: points[index + 1].x - points[index].x, y: points[index + 1].y - points[index].y };
    const length = Math.hypot(edge.x, edge.y);
    return { x: -edge.y / length, y: edge.x / length };
  });
}

function overlapOnAxis(a: PcbPoint[], b: PcbPoint[], axis: PcbPoint): number {
  const ap = a.map((p) => p.x * axis.x + p.y * axis.y);
  const bp = b.map((p) => p.x * axis.x + p.y * axis.y);
  return Math.min(Math.max(...ap), Math.max(...bp)) - Math.max(Math.min(...ap), Math.min(...bp));
}

function closestPointOnSegment(p: PcbPoint, a: PcbPoint, b: PcbPoint): PcbPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function closestRectanglePoints(a: PcbPoint[], b: PcbPoint[]): { from: PcbPoint; to: PcbPoint; distance: number } {
  let closest = { from: a[0], to: b[0], distance: Number.POSITIVE_INFINITY };
  const consider = (from: PcbPoint, to: PcbPoint) => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < closest.distance - EPSILON) closest = { from, to, distance };
  };
  for (let index = 0; index < 4; index += 1) {
    const a0 = a[index];
    const a1 = a[(index + 1) % 4];
    const b0 = b[index];
    const b1 = b[(index + 1) % 4];
    for (const vertex of a) consider(vertex, closestPointOnSegment(vertex, b0, b1));
    for (const vertex of b) consider(closestPointOnSegment(vertex, a0, a1), vertex);
  }
  return closest;
}

function noteDimension(id: string, from: PcbPoint, to: PcbPoint, text: string): AnyCircuitElement {
  return {
    type: 'pcb_note_dimension',
    pcb_note_dimension_id: `pcb-measurement-${id}`,
    from,
    to,
    text,
    font_size: 0.8,
    arrow_size: 0.65,
    color: OVERLAY_COLOR,
  };
}
function noteText(id: string, anchor: PcbPoint, text: string): AnyCircuitElement {
  return {
    type: 'pcb_note_text',
    pcb_note_text_id: `pcb-measurement-${id}`,
    anchor_position: anchor,
    anchor_alignment: 'center',
    text,
    font_size: 0.8,
    color: OVERLAY_COLOR,
  };
}

function measurementLabel(value: number, suffix = ''): string {
  return `${value.toFixed(3)} mm${suffix}`;
}

export function measurePcb(elements: AnyCircuitElement[], rawRequest: PcbMeasurementRequest): ActivePcbMeasurement {
  const request = validateRequest(rawRequest);
  const refs = request.toRef ? [request.fromRef, request.toRef] : [request.fromRef];
  const geometry = extractPcbGeometry(elements, refs);
  const from = geometry.parts[0];

  if (request.mode === 'center') {
    const to = geometry.parts[1];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const result: CenterPcbMeasurement = {
      mode: 'center', units: 'mm', precisionMm: 0.001,
      from: rect(from), to: rect(to),
      endpoints: { from: point(from), to: point(to) },
      dxMm: round(dx), dyMm: round(dy), distanceMm: round(distance),
      relation: distance <= EPSILON ? 'coincident' : 'distinct',
      limitation: LIMITATION,
    };
    const overlayElements = distance <= EPSILON
      ? [noteText('center', from, measurementLabel(0, ' · coincident centers'))]
      : [noteDimension('center', from, to, measurementLabel(result.distanceMm, ' center'))];
    return { result, overlayElements };
  }

  if (request.mode === 'edge') {
    const to = geometry.parts[1];
    const fromCorners = corners(from);
    const toCorners = corners(to);
    const overlaps = [...axes(fromCorners), ...axes(toCorners)].map((axis) => overlapOnAxis(fromCorners, toCorners, axis));
    const minimumOverlap = Math.min(...overlaps);
    const relation: EdgePcbMeasurement['relation'] = minimumOverlap > EPSILON
      ? 'overlapping'
      : minimumOverlap >= -EPSILON ? 'touching' : 'separated';
    const closest = relation === 'separated'
      ? closestRectanglePoints(fromCorners, toCorners)
      : { from: from, to: to, distance: 0 };
    const result: EdgePcbMeasurement = {
      mode: 'edge', units: 'mm', precisionMm: 0.001,
      from: rect(from), to: rect(to),
      closestPoints: { from: point(closest.from), to: point(closest.to) },
      distanceMm: round(closest.distance), relation, limitation: LIMITATION,
    };
    const overlayElements = relation === 'separated'
      ? [noteDimension('edge', closest.from, closest.to, measurementLabel(result.distanceMm, ' edge gap'))]
      : [noteText('edge', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, measurementLabel(0, ` · ${relation}`))];
    return { result, overlayElements };
  }

  const board = geometry.board;
  const partCorners = corners(from);
  const leftPoint = partCorners.reduce((best, value) => value.x < best.x ? value : best);
  const rightPoint = partCorners.reduce((best, value) => value.x > best.x ? value : best);
  const bottomPoint = partCorners.reduce((best, value) => value.y < best.y ? value : best);
  const topPoint = partCorners.reduce((best, value) => value.y > best.y ? value : best);
  const boardEdges = {
    left: board.x - board.width / 2,
    right: board.x + board.width / 2,
    bottom: board.y - board.height / 2,
    top: board.y + board.height / 2,
  };
  const clearances = {
    left: leftPoint.x - boardEdges.left,
    right: boardEdges.right - rightPoint.x,
    bottom: bottomPoint.y - boardEdges.bottom,
    top: boardEdges.top - topPoint.y,
  };
  const minimum = (Object.entries(clearances) as Array<[BoardSide, number]>).reduce(
    (best, entry) => entry[1] < best[1] ? entry : best,
  );
  const relation: BoardPcbMeasurement['relation'] = minimum[1] < -EPSILON
    ? 'outside'
    : Object.values(clearances).some((value) => Math.abs(value) <= EPSILON) ? 'touching' : 'inside';
  const result: BoardPcbMeasurement = {
    mode: 'board', units: 'mm', precisionMm: 0.001,
    from: rect(from),
    board: { x: round(board.x), y: round(board.y), width: round(board.width), height: round(board.height) },
    clearancesMm: {
      left: round(clearances.left), right: round(clearances.right),
      bottom: round(clearances.bottom), top: round(clearances.top),
    },
    minimum: { side: minimum[0], clearanceMm: round(minimum[1]) },
    relation,
    limitation: LIMITATION,
  };
  const dimension = (side: BoardSide, start: PcbPoint, end: PcbPoint) => noteDimension(
    `board-${side}`, start, end, measurementLabel(result.clearancesMm[side], result.clearancesMm[side] < 0 ? ' · outside' : ` ${side}`),
  );
  return {
    result,
    overlayElements: [
      dimension('left', { x: boardEdges.left, y: leftPoint.y }, leftPoint),
      dimension('right', rightPoint, { x: boardEdges.right, y: rightPoint.y }),
      dimension('bottom', { x: bottomPoint.x, y: boardEdges.bottom }, bottomPoint),
      dimension('top', topPoint, { x: topPoint.x, y: boardEdges.top }),
    ],
  };
}
