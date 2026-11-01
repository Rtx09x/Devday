import type { AnyCircuitElement } from './circuitJson.ts';
import { extractPcbGeometry } from './pcbGeometry.ts';

export interface PcbGridRequest {
  spacingMm?: number;
  majorEvery?: number;
}

export interface PcbGridResult {
  units: 'mm';
  precisionMm: 0.001;
  spacingMm: number;
  majorEvery: number;
  majorSpacingMm: number;
  origin: { x: 0; y: 0 };
  board: { x: number; y: number; width: number; height: number };
  counts: { lines: number; labels: number; axes: number; majorLines: number; minorLines: number };
  limitation: string;
}

export interface ActivePcbGrid {
  result: PcbGridResult;
  overlayElements: AnyCircuitElement[];
}

export const DEFAULT_PCB_GRID_SPACING_MM = 2.5;
export const DEFAULT_PCB_GRID_MAJOR_EVERY = 4;
export const MAX_PCB_GRID_LINES = 240;
export const MAX_PCB_GRID_LABELS = 64;

const PRECISION_MM = 0.001;
const EPSILON = 1e-9;
const MINOR_COLOR = '#75a5bd';
const MAJOR_COLOR = '#55b7d9';
const AXIS_COLOR = '#35d0ad';
const LABEL_COLOR = '#8edbea';
const LIMITATION = 'Read-only evaluated rectangular-board coordinate lattice only; not snapping, free drag, routing, clearance, keep-out enforcement, DRC, or fabrication validation.';

const round = (value: number): number => Math.round(value / PRECISION_MM) * PRECISION_MM;
const indexId = (index: number): string => index < 0 ? `n${Math.abs(index)}` : `p${index}`;
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${round(value).toFixed(3)}`;

function validateSettings(request: PcbGridRequest): { spacingMm: number; majorEvery: number } {
  const spacingMm = request.spacingMm ?? DEFAULT_PCB_GRID_SPACING_MM;
  const majorEvery = request.majorEvery ?? DEFAULT_PCB_GRID_MAJOR_EVERY;
  if (!Number.isFinite(spacingMm) || spacingMm < 0.1 || spacingMm > 100) {
    throw new Error('spacing_mm must be a finite millimetre value between 0.100 and 100.000.');
  }
  if (Math.abs(spacingMm - round(spacingMm)) > EPSILON) {
    throw new Error('spacing_mm supports at most three decimal places.');
  }
  if (!Number.isInteger(majorEvery) || majorEvery < 2 || majorEvery > 10) {
    throw new Error('major_every must be an integer between 2 and 10.');
  }
  return { spacingMm: round(spacingMm), majorEvery };
}

function indicesWithin(minimum: number, maximum: number, spacingMm: number): number[] {
  const first = Math.ceil((minimum - EPSILON) / spacingMm);
  const last = Math.floor((maximum + EPSILON) / spacingMm);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => first + offset);
}

function noteLine(
  axis: 'x' | 'y',
  index: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  kind: 'axis' | 'major' | 'minor',
): AnyCircuitElement {
  return {
    type: 'pcb_note_line',
    pcb_note_line_id: `pcb-grid-${axis}-${indexId(index)}-${kind}`,
    x1: round(start.x), y1: round(start.y), x2: round(end.x), y2: round(end.y),
    layer: 'top',
    stroke_width: kind === 'axis' ? 0.12 : kind === 'major' ? 0.075 : 0.04,
    color: kind === 'axis' ? AXIS_COLOR : kind === 'major' ? MAJOR_COLOR : MINOR_COLOR,
    is_dashed: kind === 'minor',
  };
}

function noteText(axis: 'x' | 'y', index: number, anchor: { x: number; y: number }, value: number): AnyCircuitElement {
  return {
    type: 'pcb_note_text',
    pcb_note_text_id: `pcb-grid-label-${axis}-${indexId(index)}`,
    anchor_position: { x: round(anchor.x), y: round(anchor.y) },
    anchor_alignment: axis === 'x' ? 'bottom_left' : 'top_left',
    text: `${axis.toUpperCase()}=${signed(value)}`,
    font_size: 0.55,
    layer: 'top',
    color: LABEL_COLOR,
  };
}

export function buildPcbGrid(elements: AnyCircuitElement[], rawRequest: PcbGridRequest = {}): ActivePcbGrid {
  const { spacingMm, majorEvery } = validateSettings(rawRequest);
  const board = extractPcbGeometry(elements, []).board;
  const left = board.x - board.width / 2;
  const right = board.x + board.width / 2;
  const bottom = board.y - board.height / 2;
  const top = board.y + board.height / 2;
  const xIndices = indicesWithin(left, right, spacingMm);
  const yIndices = indicesWithin(bottom, top, spacingMm);
  const lineCount = xIndices.length + yIndices.length;
  if (lineCount > MAX_PCB_GRID_LINES) {
    throw new Error(`The requested PCB grid would generate ${lineCount} lines; increase spacing_mm to stay at or below ${MAX_PCB_GRID_LINES}.`);
  }
  const majorX = xIndices.filter((index) => index % majorEvery === 0);
  const majorY = yIndices.filter((index) => index % majorEvery === 0);
  const labelCount = majorX.length + majorY.length;
  if (labelCount > MAX_PCB_GRID_LABELS) {
    throw new Error(`The requested PCB grid would generate ${labelCount} labels; increase spacing_mm or major_every to stay at or below ${MAX_PCB_GRID_LABELS}.`);
  }

  let axes = 0;
  let majorLines = 0;
  let minorLines = 0;
  const classify = (index: number): 'axis' | 'major' | 'minor' => {
    if (index === 0) { axes += 1; return 'axis'; }
    if (index % majorEvery === 0) { majorLines += 1; return 'major'; }
    minorLines += 1;
    return 'minor';
  };
  const overlayElements: AnyCircuitElement[] = [
    ...xIndices.map((index) => noteLine('x', index, { x: index * spacingMm, y: bottom }, { x: index * spacingMm, y: top }, classify(index))),
    ...yIndices.map((index) => noteLine('y', index, { x: left, y: index * spacingMm }, { x: right, y: index * spacingMm }, classify(index))),
    ...majorX.map((index) => noteText('x', index, { x: index * spacingMm, y: bottom }, index * spacingMm)),
    ...majorY.map((index) => noteText('y', index, { x: left, y: index * spacingMm }, index * spacingMm)),
  ];

  return {
    result: {
      units: 'mm', precisionMm: 0.001,
      spacingMm, majorEvery, majorSpacingMm: round(spacingMm * majorEvery),
      origin: { x: 0, y: 0 },
      board: { x: round(board.x), y: round(board.y), width: round(board.width), height: round(board.height) },
      counts: { lines: lineCount, labels: labelCount, axes, majorLines, minorLines },
      limitation: LIMITATION,
    },
    overlayElements,
  };
}
