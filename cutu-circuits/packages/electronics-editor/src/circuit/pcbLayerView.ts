import type { AnyCircuitElement } from './circuitJson';

export const PCB_LAYER_VIEW_IDS = [
  'top-silkscreen',
  'top-soldermask',
  'top-solderpaste',
  'top-courtyard',
  'top-keepouts',
  'top-copper',
  'inner1-copper',
  'inner2-copper',
  'inner3-copper',
  'inner4-copper',
  'inner5-copper',
  'inner6-copper',
  'bottom-copper',
  'bottom-keepouts',
  'bottom-courtyard',
  'bottom-solderpaste',
  'bottom-soldermask',
  'bottom-silkscreen',
  'board-outline',
  'drill',
  'annotations',
] as const;

export type PcbLayerViewId = typeof PCB_LAYER_VIEW_IDS[number];
export type PcbLayerViewMode = 'show' | 'hide' | 'isolate';

export interface PcbLayerDefinition {
  id: PcbLayerViewId;
  label: string;
  color: string;
  selectors: string[];
}

const PCB_COPPER_TYPES = [
  'pcb_smtpad',
  'pcb_trace',
  'pcb_via',
  'pcb_plated_hole',
  'pcb_copper_pour',
  'pcb_copper_text',
];

function layerSelectors(types: string[], layers: string[]): string[] {
  return types.flatMap((type) => layers.map((layer) => `[data-type="${type}"][data-pcb-layer="${layer}"]`));
}

function surfaceSelectors(type: string, layer: 'top' | 'bottom'): string[] {
  return [`[data-type^="${type}"][data-pcb-layer="${layer}"]`];
}

export const PCB_LAYER_DEFINITIONS: PcbLayerDefinition[] = [
  { id: 'top-silkscreen', label: 'Top silkscreen', color: '#d9c766', selectors: surfaceSelectors('pcb_silkscreen_', 'top') },
  {
    id: 'top-soldermask', label: 'Top solder mask', color: '#7b3fc6', selectors: [
      '[data-type^="pcb_soldermask"][data-pcb-layer="top"]',
      '[data-type^="pcb_soldermask"][data-pcb-layer="soldermask-top"]',
      '[data-type="pcb_trace_soldermask"][data-pcb-layer="top"]',
    ],
  },
  { id: 'top-solderpaste', label: 'Top solder paste', color: '#b0b7c3', selectors: layerSelectors(['pcb_solder_paste'], ['top']) },
  { id: 'top-courtyard', label: 'Top courtyard', color: '#bd58bd', selectors: surfaceSelectors('pcb_courtyard_', 'top') },
  { id: 'top-keepouts', label: 'Top keep-outs', color: '#e06b5f', selectors: layerSelectors(['pcb_keepout'], ['top']) },
  { id: 'top-copper', label: 'Top copper', color: '#c83434', selectors: layerSelectors(PCB_COPPER_TYPES, ['top']) },
  { id: 'inner1-copper', label: 'Inner 1 copper', color: '#77704b', selectors: layerSelectors(PCB_COPPER_TYPES, ['inner1']) },
  { id: 'inner2-copper', label: 'Inner 2 copper', color: '#31935a', selectors: layerSelectors(PCB_COPPER_TYPES, ['inner2']) },
  { id: 'inner3-copper', label: 'Inner 3 copper', color: '#9a7850', selectors: layerSelectors(PCB_COPPER_TYPES, ['inner3']) },
  { id: 'inner4-copper', label: 'Inner 4 copper', color: '#6a8d73', selectors: layerSelectors(PCB_COPPER_TYPES, ['inner4']) },
  { id: 'inner5-copper', label: 'Inner 5 copper', color: '#a56f8d', selectors: layerSelectors(PCB_COPPER_TYPES, ['inner5']) },
  { id: 'inner6-copper', label: 'Inner 6 copper', color: '#7084a9', selectors: layerSelectors(PCB_COPPER_TYPES, ['inner6']) },
  { id: 'bottom-copper', label: 'Bottom copper', color: '#4778d9', selectors: layerSelectors(PCB_COPPER_TYPES, ['bottom']) },
  { id: 'bottom-keepouts', label: 'Bottom keep-outs', color: '#bf4e4e', selectors: layerSelectors(['pcb_keepout'], ['bottom']) },
  { id: 'bottom-courtyard', label: 'Bottom courtyard', color: '#008fa5', selectors: surfaceSelectors('pcb_courtyard_', 'bottom') },
  { id: 'bottom-solderpaste', label: 'Bottom solder paste', color: '#8c96a8', selectors: layerSelectors(['pcb_solder_paste'], ['bottom']) },
  {
    id: 'bottom-soldermask', label: 'Bottom solder mask', color: '#5d2d9c', selectors: [
      '[data-type^="pcb_soldermask"][data-pcb-layer="bottom"]',
      '[data-type^="pcb_soldermask"][data-pcb-layer="soldermask-bottom"]',
      '[data-type="pcb_trace_soldermask"][data-pcb-layer="bottom"]',
    ],
  },
  { id: 'bottom-silkscreen', label: 'Bottom silkscreen', color: '#42a5d5', selectors: surfaceSelectors('pcb_silkscreen_', 'bottom') },
  { id: 'board-outline', label: 'Board outline & cutouts', color: '#a9b2af', selectors: ['[data-type="pcb_board"]', '[data-type="pcb_boundary"]', '[data-type^="pcb_cutout"]'] },
  {
    id: 'drill', label: 'Drill holes', color: '#6f7c77', selectors: [
      '[data-type="pcb_hole"][data-pcb-layer="drill"]',
      '[data-type="pcb_plated_hole_drill"][data-pcb-layer="drill"]',
      '[data-type="pcb_via"][data-pcb-layer="drill"]',
    ],
  },
  {
    id: 'annotations', label: 'Notes & overlays', color: '#e3a84b', selectors: [
      '[data-pcb-layer="overlay"]',
      '[data-type^="pcb_fabrication_note_"]',
      '[data-type^="pcb_note_"]',
      '[data-type="pcb_airwire"]',
      '[data-type$="_error"]',
    ],
  },
];

interface ParsedSvgTag {
  dataType?: string;
  rawLayer?: string;
  source: string;
}

export interface PcbLayerInventoryEntry {
  id: PcbLayerViewId;
  label: string;
  renderedElementCount: number;
}

export interface PcbUnclassifiedRendered {
  dataType: string;
  rawLayer: string;
  count: number;
}

export interface PcbStructuralRendered {
  kind: string;
  count: number;
}

export interface PcbLayerInventory {
  availableLayers: PcbLayerInventoryEntry[];
  unclassifiedRendered: PcbUnclassifiedRendered[];
  structuralRendered: PcbStructuralRendered[];
  omittedUnclassifiedCount: number;
  omittedStructuralCount: number;
}

const INVENTORY_DETAIL_LIMIT = 32;
const INVENTORY_VALUE_LIMIT = 80;

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function selectorMatchesTag(selector: string, tag: string): boolean {
  const attributes = Array.from(selector.matchAll(/\[([^=\^\$\]]+)(\^|\$)?="([^"]+)"\]/g));
  return attributes.length > 0 && attributes.every(([, name, operator, value]) => {
    const actual = attribute(tag, name);
    if (operator === '^') return actual?.startsWith(value) ?? false;
    if (operator === '$') return actual?.endsWith(value) ?? false;
    return actual === value;
  });
}

function layerMatchesTag(layer: PcbLayerDefinition, tag: string): boolean {
  return layer.selectors.some((selector) => selectorMatchesTag(selector, tag));
}

function boundedValue(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
  return normalized.length <= INVENTORY_VALUE_LIMIT ? normalized : `${normalized.slice(0, INVENTORY_VALUE_LIMIT - 1)}…`;
}

function counted<T>(values: T[], keyOf: (value: T) => string, project: (value: T, count: number) => T): T[] {
  const byKey = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = keyOf(value);
    const current = byKey.get(key);
    if (current) current.count += 1;
    else byKey.set(key, { value, count: 1 });
  }
  return Array.from(byKey.values()).sort((a, b) => keyOf(a.value).localeCompare(keyOf(b.value))).map(({ value, count }) => project(value, count));
}

export function inspectPcbLayerInventory(svg: string): PcbLayerInventory {
  const tags: ParsedSvgTag[] = (svg.match(/<[^>]+>/g) ?? [])
    .filter((source) => source.includes('data-type=') || source.includes('data-pcb-layer='))
    .map((source) => ({ source, dataType: attribute(source, 'data-type'), rawLayer: attribute(source, 'data-pcb-layer') }));
  const availableLayers = PCB_LAYER_DEFINITIONS.flatMap((layer) => {
    const count = tags.filter((tag) => layerMatchesTag(layer, tag.source)).length;
    return count > 0 ? [{ id: layer.id, label: layer.label, renderedElementCount: count }] : [];
  });
  const unmatched = tags.filter((tag) => !PCB_LAYER_DEFINITIONS.some((layer) => layerMatchesTag(layer, tag.source)));
  const unclassifiedAll = counted(
    unmatched.filter((tag) => tag.rawLayer).map((tag) => ({
      dataType: boundedValue(tag.dataType, 'unknown'),
      rawLayer: boundedValue(tag.rawLayer, 'unknown'),
      count: 0,
    })),
    (entry) => `${entry.dataType}\u0000${entry.rawLayer}`,
    (entry, count) => ({ ...entry, count }),
  );
  const structuralAll = counted(
    unmatched.filter((tag) => !tag.rawLayer).map((tag) => ({ kind: boundedValue(tag.dataType, 'untyped'), count: 0 })),
    (entry) => entry.kind,
    (entry, count) => ({ ...entry, count }),
  );
  return {
    availableLayers,
    unclassifiedRendered: unclassifiedAll.slice(0, INVENTORY_DETAIL_LIMIT),
    structuralRendered: structuralAll.slice(0, INVENTORY_DETAIL_LIMIT),
    omittedUnclassifiedCount: Math.max(0, unclassifiedAll.length - INVENTORY_DETAIL_LIMIT),
    omittedStructuralCount: Math.max(0, structuralAll.length - INVENTORY_DETAIL_LIMIT),
  };
}

export function buildPcbLayerInventory(elements: AnyCircuitElement[]): PcbLayerInventory {
  const counts = new Map<PcbLayerViewId, number>();
  const unclassified: PcbUnclassifiedRendered[] = [];
  const structural: PcbStructuralRendered[] = [];
  for (const element of elements) {
    if (!element.type.startsWith('pcb_')) continue;
    const ids = directLayerIdsForElement(element);
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (ids.length > 0) continue;
    const rawLayer = typeof element.layer === 'string' && element.layer ? element.layer : undefined;
    if (rawLayer) unclassified.push({ dataType: boundedValue(element.type, 'unknown'), rawLayer: boundedValue(rawLayer, 'unknown'), count: 0 });
    else structural.push({ kind: boundedValue(element.type, 'untyped'), count: 0 });
  }
  const unclassifiedAll = counted(
    unclassified,
    (entry) => `${entry.dataType}\u0000${entry.rawLayer}`,
    (entry, count) => ({ ...entry, count }),
  );
  const structuralAll = counted(
    structural,
    (entry) => entry.kind,
    (entry, count) => ({ ...entry, count }),
  );
  return {
    availableLayers: PCB_LAYER_DEFINITIONS.flatMap((layer) => {
      const renderedElementCount = counts.get(layer.id) ?? 0;
      return renderedElementCount > 0 ? [{ id: layer.id, label: layer.label, renderedElementCount }] : [];
    }),
    unclassifiedRendered: unclassifiedAll.slice(0, INVENTORY_DETAIL_LIMIT),
    structuralRendered: structuralAll.slice(0, INVENTORY_DETAIL_LIMIT),
    omittedUnclassifiedCount: Math.max(0, unclassifiedAll.length - INVENTORY_DETAIL_LIMIT),
    omittedStructuralCount: Math.max(0, structuralAll.length - INVENTORY_DETAIL_LIMIT),
  };
}

function copperLayers(element: AnyCircuitElement): string[] {
  if (element.type === 'pcb_via') {
    if (typeof element.from_layer === 'string' && typeof element.to_layer === 'string') return [element.from_layer, element.to_layer];
    if (Array.isArray(element.layers)) return element.layers.filter((value): value is string => typeof value === 'string');
    return ['top', 'bottom'];
  }
  if (element.type === 'pcb_plated_hole') return ['top', 'bottom'];
  return typeof element.layer === 'string' ? [element.layer] : [];
}

function copperLayerId(layer: string): PcbLayerViewId | undefined {
  if (layer === 'top') return 'top-copper';
  if (layer === 'bottom') return 'bottom-copper';
  return /^inner[1-6]$/.test(layer) ? `${layer}-copper` as PcbLayerViewId : undefined;
}

export function directLayerIdsForElement(element: AnyCircuitElement): PcbLayerViewId[] {
  const type = element.type;
  const layer = typeof element.layer === 'string' ? element.layer : '';
  const ids = new Set<PcbLayerViewId>();
  if (type.startsWith('pcb_silkscreen_')) {
    if (layer === 'top') ids.add('top-silkscreen');
    if (layer === 'bottom') ids.add('bottom-silkscreen');
  }
  if (type.startsWith('pcb_soldermask') || type === 'pcb_trace_soldermask') {
    if (layer === 'top' || layer === 'soldermask-top') ids.add('top-soldermask');
    if (layer === 'bottom' || layer === 'soldermask-bottom') ids.add('bottom-soldermask');
  }
  if (type === 'pcb_solder_paste') {
    if (layer === 'top') ids.add('top-solderpaste');
    if (layer === 'bottom') ids.add('bottom-solderpaste');
  }
  if (type.startsWith('pcb_courtyard_')) {
    if (layer === 'top') ids.add('top-courtyard');
    if (layer === 'bottom') ids.add('bottom-courtyard');
  }
  if (type === 'pcb_keepout') {
    if (layer === 'top') ids.add('top-keepouts');
    if (layer === 'bottom') ids.add('bottom-keepouts');
  }
  if (PCB_COPPER_TYPES.includes(type)) {
    for (const copperLayer of copperLayers(element)) {
      const id = copperLayerId(copperLayer);
      if (id) ids.add(id);
    }
  }
  if (type === 'pcb_board' || type === 'pcb_boundary' || type.startsWith('pcb_cutout')) ids.add('board-outline');
  if (type === 'pcb_hole' || type === 'pcb_plated_hole' || type === 'pcb_via') ids.add('drill');
  if (type.startsWith('pcb_note_') || type.startsWith('pcb_fabrication_note_') || type === 'pcb_airwire' || type.endsWith('_error')) ids.add('annotations');
  return [...ids];
}

export function renderedPcbLayers(svg: string): PcbLayerDefinition[] {
  const available = new Set(inspectPcbLayerInventory(svg).availableLayers.map((layer) => layer.id));
  return PCB_LAYER_DEFINITIONS.filter((layer) => available.has(layer.id));
}

export function hidePcbLayers(svg: string, layers: PcbLayerDefinition[], hidden: Set<string>): string {
  const selectors = layers.filter((layer) => hidden.has(layer.id)).flatMap((layer) => layer.selectors);
  if (selectors.length === 0) return svg;
  return svg.replace(/(<svg[^>]*>)/, `$1<style>${selectors.join(',')} { display: none !important; }</style>`);
}

export interface PcbLayerViewRequest {
  mode: PcbLayerViewMode;
  layers: string[];
}

export interface PcbLayerViewResult extends PcbLayerInventory {
  mode: PcbLayerViewMode;
  requestedLayerIds: PcbLayerViewId[];
  visibleLayerIds: PcbLayerViewId[];
  hiddenLayerIds: PcbLayerViewId[];
  suppressedSessionOverlays: string[];
  changed: boolean;
  sessionOnly: true;
  sourceChanged: false;
  limitations: string[];
}

export interface ResolvedPcbLayerView {
  hidden: Set<string>;
  result: PcbLayerViewResult;
}

const LIMITATIONS = [
  'Layer Lens changes only session-local direct-viewer visibility preferences; it does not edit or export the circuit.',
  'The groups and counts are exact for the current pinned direct PCB viewer projection, not a fabrication stackup or Gerber inspection.',
  'Hidden geometry still exists in Circuit JSON and exports; visibility is not routing, clearance, DRC, DFM, manufacturing, or physical validation.',
  'Unknown renderer elements remain visible and are reported rather than guessed into a layer group.',
];

function exactRequestedLayers(mode: PcbLayerViewMode, raw: unknown): PcbLayerViewId[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PCB_LAYER_VIEW_IDS.length) {
    throw new Error(`${mode} requires 1-${PCB_LAYER_VIEW_IDS.length} exact layer ids.`);
  }
  const supported = new Set<string>(PCB_LAYER_VIEW_IDS);
  const result: PcbLayerViewId[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !supported.has(value)) {
      throw new Error(`Unsupported PCB layer id ${JSON.stringify(value)}. Use one of: ${PCB_LAYER_VIEW_IDS.join(', ')}.`);
    }
    if (seen.has(value)) throw new Error(`Duplicate PCB layer id: ${value}.`);
    seen.add(value);
    result.push(value as PcbLayerViewId);
  }
  return result;
}

export function resolvePcbLayerView(
  request: PcbLayerViewRequest,
  currentHidden: Iterable<string>,
  inventory: PcbLayerInventory,
  activeSessionOverlays: string[] = [],
): ResolvedPcbLayerView {
  if (!request || typeof request !== 'object') throw new Error('PCB layer view request must be an object.');
  if (!['show', 'hide', 'isolate'].includes(request.mode)) {
    throw new Error('PCB layer view mode must be show, hide, or isolate.');
  }
  const requestedLayerIds = exactRequestedLayers(request.mode, request.layers);
  const availableIds = inventory.availableLayers.map((layer) => layer.id);
  const available = new Set<PcbLayerViewId>(availableIds);
  const absent = requestedLayerIds.filter((id) => !available.has(id));
  if (absent.length > 0) {
    throw new Error(`Requested layer groups are not present in the exact current PCB render: ${absent.join(', ')}. Available: ${availableIds.join(', ') || 'none'}.`);
  }
  const hidden = new Set(Array.from(currentHidden).filter((id): id is PcbLayerViewId => available.has(id as PcbLayerViewId)));
  const before = availableIds.filter((id) => hidden.has(id)).join('\u0000');
  if (request.mode === 'isolate') {
    hidden.clear();
    const visible = new Set(requestedLayerIds);
    for (const id of availableIds) if (!visible.has(id)) hidden.add(id);
  } else if (request.mode === 'show') {
    for (const id of requestedLayerIds) hidden.delete(id);
  } else {
    for (const id of requestedLayerIds) hidden.add(id);
  }
  const hiddenLayerIds = availableIds.filter((id) => hidden.has(id));
  const visibleLayerIds = availableIds.filter((id) => !hidden.has(id));
  const suppressedSessionOverlays = hidden.has('annotations')
    ? Array.from(new Set(activeSessionOverlays.map((value) => boundedValue(value, 'session overlay')))).slice(0, 16)
    : [];
  return {
    hidden,
    result: {
      mode: request.mode,
      requestedLayerIds,
      availableLayers: inventory.availableLayers,
      visibleLayerIds,
      hiddenLayerIds,
      unclassifiedRendered: inventory.unclassifiedRendered,
      structuralRendered: inventory.structuralRendered,
      omittedUnclassifiedCount: inventory.omittedUnclassifiedCount,
      omittedStructuralCount: inventory.omittedStructuralCount,
      suppressedSessionOverlays,
      changed: before !== hiddenLayerIds.join('\u0000'),
      sessionOnly: true,
      sourceChanged: false,
      limitations: LIMITATIONS,
    },
  };
}
