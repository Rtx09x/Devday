import type { AnyCircuitElement } from './circuitJson.ts';

export interface MountingHoleRequestItem {
  /** Source/audit identity only; the evaluator does not preserve it on pcb_hole. */
  name: string;
  diameter: number;
  pcbX: number;
  pcbY: number;
}

export interface MountingHoleRequest {
  holes: MountingHoleRequestItem[];
}

export interface MountingHoleGeometry extends MountingHoleRequestItem {}

export interface MountingHolePreview {
  board: { x: number; y: number; width: number; height: number };
  beforeCount: number;
  afterCount: number;
  holes: MountingHoleGeometry[];
  limitation: string;
}

const EPSILON = 0.001;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const rounded = (value: number): number => Math.round(value * 1000) / 1000;
const same = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;

function geometryKey(hole: Omit<MountingHoleGeometry, 'name'>): string {
  return `${rounded(hole.pcbX)}:${rounded(hole.pcbY)}:${rounded(hole.diameter)}`;
}

function sourceNames(source: string): string[] {
  return [...source.matchAll(/\bname=["']([^"']+)["']/g)].map((match) => match[1]);
}

function directBoard(source: string): { insertionIndex: number; indent: string } {
  const openings = [...source.matchAll(/<board\b[^>]*>/g)].filter((match) => !/\/>\s*$/.test(match[0]));
  const closings = [...source.matchAll(/<\/board\s*>/g)];
  if (openings.length !== 1 || closings.length !== 1 || (openings[0].index ?? -1) >= (closings[0].index ?? -1)) {
    throw new Error(`Mounting-hole preview requires exactly one editable direct board; found ${openings.length} opening and ${closings.length} closing board elements.`);
  }
  const closeIndex = closings[0].index as number;
  const lineStart = source.lastIndexOf('\n', closeIndex) + 1;
  const beforeClosingTag = source.slice(lineStart, closeIndex);
  if (!/^\s*$/.test(beforeClosingTag)) {
    throw new Error('Mounting-hole preview requires the direct board closing tag on its own editable source line.');
  }
  return { insertionIndex: lineStart, indent: `${beforeClosingTag}  ` };
}

export function validateMountingHoleRequest(source: string, request: MountingHoleRequest): MountingHoleRequest {
  const holes = request.holes ?? [];
  if (holes.length === 0) throw new Error('Provide at least one mounting hole.');
  if (holes.length > 8) throw new Error('Mounting-hole previews support at most 8 holes.');
  directBoard(source);

  const existingNames = new Set(sourceNames(source));
  const names = new Set<string>();
  const geometries = new Set<string>();
  const normalized = holes.map((hole) => {
    const name = hole.name?.trim();
    if (!name || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new Error('Every mounting hole requires a unique source/audit name using letters, digits, underscores, or hyphens.');
    }
    if (names.has(name)) throw new Error(`Duplicate mounting-hole source/audit name "${name}".`);
    if (existingNames.has(name)) throw new Error(`Source/audit name "${name}" already exists in source.`);
    names.add(name);
    if (!finite(hole.diameter) || hole.diameter < 0.1 || hole.diameter > 100) {
      throw new Error(`${name} diameter must be a finite millimetre value between 0.1 and 100.`);
    }
    for (const [label, value] of [['pcbX', hole.pcbX], ['pcbY', hole.pcbY]] as const) {
      if (!finite(value) || Math.abs(value) > 10_000) {
        throw new Error(`${name} ${label} must be a finite millimetre value between -10000 and 10000.`);
      }
    }
    const normalizedHole = { name, diameter: hole.diameter, pcbX: hole.pcbX, pcbY: hole.pcbY };
    const key = geometryKey(normalizedHole);
    if (geometries.has(key)) throw new Error(`Duplicate mounting-hole geometry requested at (${hole.pcbX}, ${hole.pcbY}) with diameter ${hole.diameter} mm.`);
    geometries.add(key);
    return normalizedHole;
  });
  return { holes: normalized };
}

/** Insert the whole validated batch before the one direct board closing tag. */
export function insertMountingHolesInCode(source: string, request: MountingHoleRequest): { code: string; request: MountingHoleRequest } {
  const validated = validateMountingHoleRequest(source, request);
  const board = directBoard(source);
  const lines = validated.holes.map((hole) =>
    `${board.indent}<hole name="${hole.name}" diameter="${hole.diameter}mm" pcbX={${hole.pcbX}} pcbY={${hole.pcbY}} />`,
  ).join('\n');
  const prefix = source.slice(0, board.insertionIndex);
  const separator = prefix.endsWith('\n') ? '' : '\n';
  return { code: `${prefix}${separator}${lines}\n${source.slice(board.insertionIndex)}`, request: validated };
}

function extractBoard(elements: AnyCircuitElement[]): MountingHolePreview['board'] {
  const boards = elements.filter((element) => element.type === 'pcb_board');
  if (boards.length !== 1) throw new Error(`Mounting-hole preview requires exactly one evaluated rectangular PCB board; found ${boards.length}.`);
  const board = boards[0];
  const center = board.center as Record<string, unknown> | undefined;
  if (!finite(center?.x) || !finite(center?.y) || !finite(board.width) || !finite(board.height) || board.width <= 0 || board.height <= 0) {
    throw new Error('The evaluated PCB board does not expose proven rectangular center/width/height geometry.');
  }
  return { x: center.x, y: center.y, width: board.width, height: board.height };
}

function extractCircularHoles(elements: AnyCircuitElement[]): Array<Omit<MountingHoleGeometry, 'name'>> {
  return elements.filter((element) => element.type === 'pcb_hole').map((element) => {
    if (element.hole_shape !== 'circle' || !finite(element.hole_diameter) || !finite(element.x) || !finite(element.y) || element.hole_diameter <= 0) {
      throw new Error('Exact mounting-hole verification does not support an evaluated pcb_hole without finite circular center/diameter geometry.');
    }
    return { diameter: element.hole_diameter, pcbX: element.x, pcbY: element.y };
  });
}

function multiset(holes: Array<Omit<MountingHoleGeometry, 'name'>>): Map<string, number> {
  const result = new Map<string, number>();
  for (const hole of holes) {
    const key = geometryKey(hole);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

export function buildMountingHolePreview(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
  request: MountingHoleRequest,
): MountingHolePreview {
  const beforeBoard = extractBoard(beforeElements);
  const afterBoard = extractBoard(afterElements);
  if (![beforeBoard.x, beforeBoard.y, beforeBoard.width, beforeBoard.height].every((value, index) =>
    same(value, [afterBoard.x, afterBoard.y, afterBoard.width, afterBoard.height][index]))) {
    throw new Error('The proposed mounting-hole source unexpectedly changed evaluated board geometry.');
  }
  const before = extractCircularHoles(beforeElements);
  const after = extractCircularHoles(afterElements);
  if (after.length !== before.length + request.holes.length) {
    throw new Error(`Proposed source did not add exactly ${request.holes.length} circular pcb_hole element(s).`);
  }

  const beforeSet = multiset(before);
  const remaining = multiset(after);
  for (const requested of request.holes) {
    const key = geometryKey(requested);
    if ((beforeSet.get(key) ?? 0) > 0) {
      throw new Error(`A circular pcb_hole already exists at (${requested.pcbX}, ${requested.pcbY}) with diameter ${requested.diameter} mm.`);
    }
    const count = remaining.get(key) ?? 0;
    if (count < 1) throw new Error(`Proposed source did not evaluate the requested center/diameter geometry for ${requested.name}.`);
    remaining.set(key, count - 1);
  }
  for (const [key, count] of beforeSet) {
    if ((remaining.get(key) ?? 0) !== count) {
      throw new Error('The exact before→after circular pcb_hole geometry multiset changed beyond the requested additions.');
    }
  }
  if ([...remaining.values()].some((count) => count !== 0) || remaining.size !== beforeSet.size + request.holes.length) {
    const unexpected = [...remaining.entries()].some(([key, count]) => count !== (beforeSet.get(key) ?? 0));
    if (unexpected) throw new Error('The exact before→after circular pcb_hole geometry multiset contains unexpected additions.');
  }

  const left = beforeBoard.x - beforeBoard.width / 2;
  const right = beforeBoard.x + beforeBoard.width / 2;
  const bottom = beforeBoard.y - beforeBoard.height / 2;
  const top = beforeBoard.y + beforeBoard.height / 2;
  for (const hole of request.holes) {
    const radius = hole.diameter / 2;
    if (hole.pcbX - radius < left - EPSILON || hole.pcbX + radius > right + EPSILON
      || hole.pcbY - radius < bottom - EPSILON || hole.pcbY + radius > top + EPSILON) {
      throw new Error(`${hole.name} does not lie fully within the proven rectangular PCB board.`);
    }
  }

  return {
    board: { ...beforeBoard },
    beforeCount: before.length,
    afterCount: after.length,
    holes: request.holes.map((hole) => ({ ...hole })),
    limitation: 'Unplated circular mechanical holes only. This is not plated-hole, via, annular-ring, keep-out, edge-clearance, DRC, or fabrication validation.',
  };
}
