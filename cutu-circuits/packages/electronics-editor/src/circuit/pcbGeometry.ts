import type { AnyCircuitElement } from './circuitJson.ts';

export interface GeometryPartRequest {
  ref: string;
  pcbX: number;
  pcbY: number;
  pcbRotation?: number;
}

export interface GeometryChangeRequest {
  parts?: GeometryPartRequest[];
  board?: { width?: number; height?: number };
}

export interface PcbRect {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface PcbGeometrySnapshot {
  board: { x: number; y: number; width: number; height: number };
  parts: PcbRect[];
}

export interface GeometryDelta {
  ref: string;
  before: { x: number; y: number; rotation: number };
  after: { x: number; y: number; rotation: number };
  delta: { x: number; y: number; rotation: number };
}

export interface GeometryPreview {
  before: PcbGeometrySnapshot;
  after: PcbGeometrySnapshot;
  deltas: GeometryDelta[];
  boardDelta?: {
    before: { width: number; height: number };
    after: { width: number; height: number };
    delta: { width: number; height: number };
  };
  limitation: string;
}

const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const rounded = (value: number): number => Math.round(value * 1000) / 1000;

export function validateGeometryChangeRequest(request: GeometryChangeRequest): GeometryChangeRequest {
  const parts = request.parts ?? [];
  if (parts.length > 12) throw new Error('Geometry previews support at most 12 part refs.');
  const seen = new Set<string>();
  for (const part of parts) {
    const ref = part.ref?.trim();
    if (!ref) throw new Error('Every geometry part requires an exact non-empty ref.');
    if (seen.has(ref)) throw new Error(`Duplicate geometry part ref "${ref}".`);
    seen.add(ref);
    for (const [label, value] of [['pcbX', part.pcbX], ['pcbY', part.pcbY]] as const) {
      if (!Number.isFinite(value) || Math.abs(value) > 10_000) throw new Error(`${ref} ${label} must be a finite millimetre value between -10000 and 10000.`);
    }
    if (part.pcbRotation != null && (!Number.isFinite(part.pcbRotation) || Math.abs(part.pcbRotation) > 360_000)) {
      throw new Error(`${ref} pcbRotation must be a finite degree value between -360000 and 360000.`);
    }
  }
  const board = request.board;
  for (const [label, value] of [['width', board?.width], ['height', board?.height]] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0.1 || value > 10_000)) {
      throw new Error(`Board ${label} must be a finite millimetre value between 0.1 and 10000.`);
    }
  }
  if (parts.length === 0 && board?.width == null && board?.height == null) {
    throw new Error('Provide at least one part placement or an explicit board width/height.');
  }
  return { parts: parts.map((part) => ({ ...part, ref: part.ref.trim() })), ...(board ? { board: { ...board } } : {}) };
}

export function extractPcbGeometry(elements: AnyCircuitElement[], refs: string[]): PcbGeometrySnapshot {
  const boards = elements.filter((element) => element.type === 'pcb_board');
  if (boards.length !== 1) throw new Error(`Geometry preview requires exactly one evaluated rectangular PCB board; found ${boards.length}.`);
  const board = boards[0];
  const boardId = text(board.pcb_board_id);
  const center = board.center as Record<string, unknown> | undefined;
  const width = number(board.width);
  const height = number(board.height);
  const x = number(center?.x);
  const y = number(center?.y);
  if (!boardId || width == null || height == null || x == null || y == null || width <= 0 || height <= 0) {
    throw new Error('The evaluated PCB board does not expose proven rectangular center/width/height geometry.');
  }
  const requested = new Set(refs);
  const sourceNames = new Map<string, string[]>();
  for (const element of elements.filter((item) => item.type === 'source_component')) {
    const id = text(element.source_component_id);
    const name = text(element.name);
    if (id && name && requested.has(name)) sourceNames.set(name, [...(sourceNames.get(name) ?? []), id]);
  }
  const parts: PcbRect[] = [];
  for (const ref of refs) {
    const ids = sourceNames.get(ref) ?? [];
    if (ids.length === 0) throw new Error(`Unknown evaluated part ref "${ref}".`);
    if (ids.length > 1) throw new Error(`Part ref "${ref}" is ambiguous in the evaluated circuit.`);
    const matches = elements.filter((item) => item.type === 'pcb_component' && item.source_component_id === ids[0]);
    if (matches.length !== 1) throw new Error(`Part ref "${ref}" must resolve to exactly one evaluated PCB component.`);
    const component = matches[0];
    if (text(component.positioned_relative_to_pcb_board_id) !== boardId) {
      throw new Error(`Part ref "${ref}" is not positioned on the supported PCB board.`);
    }
    const componentCenter = component.center as Record<string, unknown> | undefined;
    const values = {
      x: number(componentCenter?.x), y: number(componentCenter?.y),
      width: number(component.width), height: number(component.height),
      rotation: number(component.rotation) ?? 0,
    };
    if (values.x == null || values.y == null || values.width == null || values.height == null || values.width <= 0 || values.height <= 0) {
      throw new Error(`Part ref "${ref}" does not expose proven PCB rectangle geometry.`);
    }
    parts.push({ ref, x: values.x, y: values.y, width: values.width, height: values.height, rotation: values.rotation });
  }
  return { board: { x, y, width, height }, parts };
}

export function buildGeometryPreview(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
  request: GeometryChangeRequest,
): GeometryPreview {
  const refs = (request.parts ?? []).map((part) => part.ref);
  const before = extractPcbGeometry(beforeElements, refs);
  const after = extractPcbGeometry(afterElements, refs);
  const deltas = before.parts.map((part, index) => {
    const next = after.parts[index];
    return {
      ref: part.ref,
      before: { x: rounded(part.x), y: rounded(part.y), rotation: rounded(part.rotation ?? 0) },
      after: { x: rounded(next.x), y: rounded(next.y), rotation: rounded(next.rotation ?? 0) },
      delta: { x: rounded(next.x - part.x), y: rounded(next.y - part.y), rotation: rounded((next.rotation ?? 0) - (part.rotation ?? 0)) },
    };
  });
  for (const desired of request.parts ?? []) {
    const actual = after.parts.find((part) => part.ref === desired.ref)!;
    if (Math.abs(actual.x - desired.pcbX) > 0.001 || Math.abs(actual.y - desired.pcbY) > 0.001) {
      throw new Error(`Proposed source did not evaluate to the requested PCB position for ${desired.ref}.`);
    }
    if (desired.pcbRotation != null) {
      const normalized = ((desired.pcbRotation % 360) + 360) % 360;
      const actualNormalized = (((actual.rotation ?? 0) % 360) + 360) % 360;
      if (Math.abs(actualNormalized - normalized) > 0.001) throw new Error(`Proposed source did not evaluate to the requested PCB rotation for ${desired.ref}.`);
    }
  }
  if (request.board?.width != null && Math.abs(after.board.width - request.board.width) > 0.001) throw new Error('Proposed source did not evaluate to the requested board width.');
  if (request.board?.height != null && Math.abs(after.board.height - request.board.height) > 0.001) throw new Error('Proposed source did not evaluate to the requested board height.');
  const boardChanged = before.board.width !== after.board.width || before.board.height !== after.board.height;
  const partChanged = deltas.some((delta) => delta.delta.x !== 0 || delta.delta.y !== 0 || delta.delta.rotation !== 0);
  if (!boardChanged && !partChanged) throw new Error('The requested geometry is already applied.');
  return {
    before, after, deltas,
    ...(boardChanged ? { boardDelta: {
      before: { width: rounded(before.board.width), height: rounded(before.board.height) },
      after: { width: rounded(after.board.width), height: rounded(after.board.height) },
      delta: { width: rounded(after.board.width - before.board.width), height: rounded(after.board.height - before.board.height) },
    } } : {}),
    limitation: 'Rectangles are evaluated PCB bounding geometry, not courtyards, copper clearance, routing, or DRC.',
  };
}
