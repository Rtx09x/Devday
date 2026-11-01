import type { AnyCircuitElement } from './circuitJson.ts';

export type KeepoutLayer = 'top' | 'bottom';

interface KeepoutRequestBase {
  /** Source/audit identity only; evaluated pcb_keepout elements do not preserve it. */
  name: string;
  pcbX: number;
  pcbY: number;
  layers: KeepoutLayer[];
}

export interface CircularKeepoutRequestItem extends KeepoutRequestBase {
  shape: 'circle';
  radius: number;
}

export interface RectangularKeepoutRequestItem extends KeepoutRequestBase {
  shape: 'rect';
  width: number;
  height: number;
}

export type KeepoutRequestItem = CircularKeepoutRequestItem | RectangularKeepoutRequestItem;
type KeepoutGeometry = Omit<CircularKeepoutRequestItem, 'name'> | Omit<RectangularKeepoutRequestItem, 'name'>;

export interface KeepoutRequest {
  keepouts: KeepoutRequestItem[];
}

export interface KeepoutPreview {
  board: { x: number; y: number; width: number; height: number };
  beforeCount: number;
  afterCount: number;
  keepouts: KeepoutRequestItem[];
  limitation: string;
}

const EPSILON = 0.001;
const SUPPORTED_LAYERS = new Set<KeepoutLayer>(['top', 'bottom']);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const rounded = (value: number): number => Math.round(value * 1000) / 1000;
const same = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;

function sortedLayers(layers: string[]): string[] {
  return [...layers].sort();
}

function geometryKey(keepout: KeepoutGeometry): string {
  const common = `${keepout.shape}:${rounded(keepout.pcbX)}:${rounded(keepout.pcbY)}:${sortedLayers(keepout.layers).join(',')}`;
  return keepout.shape === 'circle'
    ? `${common}:r:${rounded(keepout.radius)}`
    : `${common}:w:${rounded(keepout.width)}:h:${rounded(keepout.height)}`;
}

function sourceNames(source: string): string[] {
  const jsxNames = [...source.matchAll(/\bname=["']([^"']+)["']/g)].map((match) => match[1]);
  const auditNames = [...source.matchAll(/\{\/\*\s*keepout:\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*\*\/\}/g)].map((match) => match[1]);
  return [...jsxNames, ...auditNames];
}

function directBoard(source: string): { insertionIndex: number; indent: string } {
  const openings = [...source.matchAll(/<board\b[^>]*>/g)].filter((match) => !/\/>\s*$/.test(match[0]));
  const closings = [...source.matchAll(/<\/board\s*>/g)];
  if (openings.length !== 1 || closings.length !== 1 || (openings[0].index ?? -1) >= (closings[0].index ?? -1)) {
    throw new Error(`Keep-out preview requires exactly one editable direct board; found ${openings.length} opening and ${closings.length} closing board elements.`);
  }
  const closeIndex = closings[0].index as number;
  const lineStart = source.lastIndexOf('\n', closeIndex) + 1;
  const beforeClosingTag = source.slice(lineStart, closeIndex);
  if (!/^\s*$/.test(beforeClosingTag)) {
    throw new Error('Keep-out preview requires the direct board closing tag on its own editable source line.');
  }
  return { insertionIndex: lineStart, indent: `${beforeClosingTag}  ` };
}

function validateLayers(name: string, layers: unknown): KeepoutLayer[] {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error(`${name} requires at least one explicit keep-out layer.`);
  }
  if (layers.some((layer) => typeof layer !== 'string' || !SUPPORTED_LAYERS.has(layer as KeepoutLayer))) {
    throw new Error(`${name} layers support only exact "top" and "bottom" values in this initial contract.`);
  }
  if (new Set(layers).size !== layers.length) throw new Error(`${name} contains a duplicate keep-out layer.`);
  return sortedLayers(layers as KeepoutLayer[]) as KeepoutLayer[];
}

export function validateKeepoutRequest(source: string, request: KeepoutRequest): KeepoutRequest {
  const keepouts = request.keepouts ?? [];
  if (keepouts.length === 0) throw new Error('Provide at least one keep-out.');
  if (keepouts.length > 8) throw new Error('Keep-out previews support at most 8 additions.');
  directBoard(source);

  const existingNames = new Set(sourceNames(source));
  const names = new Set<string>();
  const geometries = new Set<string>();
  const normalized = keepouts.map((raw) => {
    const item = raw as KeepoutRequestItem & { rotation?: unknown; pcbRotation?: unknown };
    const name = item.name?.trim();
    if (!name || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new Error('Every keep-out requires a unique source/audit name using letters, digits, underscores, or hyphens.');
    }
    if (names.has(name)) throw new Error(`Duplicate keep-out source/audit name "${name}".`);
    if (existingNames.has(name)) throw new Error(`Source/audit name "${name}" already exists in source.`);
    names.add(name);
    if (item.rotation != null || item.pcbRotation != null) {
      throw new Error(`${name} rotation is unsupported; rectangular keep-outs must be axis-aligned.`);
    }
    if (!finite(item.pcbX) || Math.abs(item.pcbX) > 10_000 || !finite(item.pcbY) || Math.abs(item.pcbY) > 10_000) {
      throw new Error(`${name} pcbX and pcbY must be finite millimetre values between -10000 and 10000.`);
    }
    const layers = validateLayers(name, item.layers);
    let keepout: KeepoutRequestItem;
    if (item.shape === 'circle') {
      if (!finite(item.radius) || item.radius < 0.1 || item.radius > 100) {
        throw new Error(`${name} radius must be a finite millimetre value between 0.1 and 100.`);
      }
      keepout = { name, shape: 'circle', radius: item.radius, pcbX: item.pcbX, pcbY: item.pcbY, layers };
    } else if (item.shape === 'rect') {
      if (!finite(item.width) || item.width < 0.1 || item.width > 100 || !finite(item.height) || item.height < 0.1 || item.height > 100) {
        throw new Error(`${name} width and height must be finite millimetre values between 0.1 and 100.`);
      }
      keepout = { name, shape: 'rect', width: item.width, height: item.height, pcbX: item.pcbX, pcbY: item.pcbY, layers };
    } else {
      throw new Error(`${name} shape must be exactly "circle" or "rect".`);
    }
    const key = geometryKey(keepout);
    if (geometries.has(key)) throw new Error(`Duplicate keep-out geometry requested for ${name}.`);
    geometries.add(key);
    return keepout;
  });
  return { keepouts: normalized };
}

/** Insert the whole validated batch before the one direct board closing tag. */
export function insertKeepoutsInCode(source: string, request: KeepoutRequest): { code: string; request: KeepoutRequest } {
  const validated = validateKeepoutRequest(source, request);
  const board = directBoard(source);
  const lines = validated.keepouts.flatMap((keepout) => {
    const layers = JSON.stringify(keepout.layers);
    const geometry = keepout.shape === 'circle'
      ? `radius="${keepout.radius}mm"`
      : `width="${keepout.width}mm" height="${keepout.height}mm"`;
    return [
      `${board.indent}{/* keepout: ${keepout.name} */}`,
      `${board.indent}<keepout shape="${keepout.shape}" ${geometry} pcbX={${keepout.pcbX}} pcbY={${keepout.pcbY}} layers={${layers}} />`,
    ];
  }).join('\n');
  const prefix = source.slice(0, board.insertionIndex);
  const separator = prefix.endsWith('\n') ? '' : '\n';
  return { code: `${prefix}${separator}${lines}\n${source.slice(board.insertionIndex)}`, request: validated };
}

function extractBoard(elements: AnyCircuitElement[]): KeepoutPreview['board'] {
  const boards = elements.filter((element) => element.type === 'pcb_board');
  if (boards.length !== 1) throw new Error(`Keep-out preview requires exactly one evaluated rectangular PCB board; found ${boards.length}.`);
  const board = boards[0];
  const center = board.center as Record<string, unknown> | undefined;
  if (!finite(center?.x) || !finite(center?.y) || !finite(board.width) || !finite(board.height) || board.width <= 0 || board.height <= 0) {
    throw new Error('The evaluated PCB board does not expose proven rectangular center/width/height geometry.');
  }
  return { x: center.x, y: center.y, width: board.width, height: board.height };
}

function extractKeepouts(elements: AnyCircuitElement[]): KeepoutGeometry[] {
  return elements.filter((element) => element.type === 'pcb_keepout').map((element) => {
    const center = element.center as Record<string, unknown> | undefined;
    const layers = element.layers;
    if (!finite(center?.x) || !finite(center?.y) || !Array.isArray(layers) || layers.length === 0
      || layers.some((layer) => typeof layer !== 'string') || new Set(layers).size !== layers.length) {
      throw new Error('Exact keep-out verification requires finite center geometry and a nonempty unique evaluated layer list.');
    }
    const common = { pcbX: center.x, pcbY: center.y, layers: sortedLayers(layers as string[]) as KeepoutLayer[] };
    if (element.shape === 'circle' && finite(element.radius) && element.radius > 0) {
      return { ...common, shape: 'circle', radius: element.radius };
    }
    if (element.shape === 'rect' && finite(element.width) && element.width > 0 && finite(element.height) && element.height > 0) {
      return { ...common, shape: 'rect', width: element.width, height: element.height };
    }
    throw new Error('Exact keep-out verification supports only evaluated circles and axis-aligned rectangles with finite positive dimensions.');
  });
}

function multiset(keepouts: KeepoutGeometry[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const keepout of keepouts) {
    const key = geometryKey(keepout);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

export function buildKeepoutPreview(
  beforeElements: AnyCircuitElement[],
  afterElements: AnyCircuitElement[],
  request: KeepoutRequest,
): KeepoutPreview {
  const beforeBoard = extractBoard(beforeElements);
  const afterBoard = extractBoard(afterElements);
  if (![beforeBoard.x, beforeBoard.y, beforeBoard.width, beforeBoard.height].every((value, index) =>
    same(value, [afterBoard.x, afterBoard.y, afterBoard.width, afterBoard.height][index]))) {
    throw new Error('The proposed keep-out source unexpectedly changed evaluated board geometry.');
  }
  const before = extractKeepouts(beforeElements);
  const after = extractKeepouts(afterElements);
  if (after.length !== before.length + request.keepouts.length) {
    throw new Error(`Proposed source did not add exactly ${request.keepouts.length} pcb_keepout element(s).`);
  }
  const beforeSet = multiset(before);
  const afterSet = multiset(after);
  const requestedSet = multiset(request.keepouts);
  for (const requested of request.keepouts) {
    const key = geometryKey(requested);
    if ((beforeSet.get(key) ?? 0) > 0) {
      throw new Error(`A matching pcb_keepout already exists for ${requested.name}.`);
    }
    const actualDelta = (afterSet.get(key) ?? 0) - (beforeSet.get(key) ?? 0);
    if (actualDelta !== 1) {
      throw new Error(`Proposed source did not evaluate the exact requested keep-out geometry and layers for ${requested.name}.`);
    }
  }
  const keys = new Set([...beforeSet.keys(), ...afterSet.keys(), ...requestedSet.keys()]);
  for (const key of keys) {
    const actualDelta = (afterSet.get(key) ?? 0) - (beforeSet.get(key) ?? 0);
    const requestedDelta = requestedSet.get(key) ?? 0;
    if (actualDelta !== requestedDelta) {
      throw new Error('The exact before→after pcb_keepout geometry/layer multiset contains an unexpected change.');
    }
  }

  const left = beforeBoard.x - beforeBoard.width / 2;
  const right = beforeBoard.x + beforeBoard.width / 2;
  const bottom = beforeBoard.y - beforeBoard.height / 2;
  const top = beforeBoard.y + beforeBoard.height / 2;
  for (const keepout of request.keepouts) {
    const halfWidth = keepout.shape === 'circle' ? keepout.radius : keepout.width / 2;
    const halfHeight = keepout.shape === 'circle' ? keepout.radius : keepout.height / 2;
    if (keepout.pcbX - halfWidth < left - EPSILON || keepout.pcbX + halfWidth > right + EPSILON
      || keepout.pcbY - halfHeight < bottom - EPSILON || keepout.pcbY + halfHeight > top + EPSILON) {
      throw new Error(`${keepout.name} does not lie fully within the proven rectangular PCB board.`);
    }
  }

  return {
    board: { ...beforeBoard },
    beforeCount: before.length,
    afterCount: after.length,
    keepouts: request.keepouts.map((keepout) => ({ ...keepout, layers: [...keepout.layers] })),
    limitation: 'Exact local keep-out geometry on explicit top/bottom layers only. This does not prove routing enforcement, copper clearance, comprehensive keep-out DRC, edge clearance, or fabrication validation.',
  };
}
