/**
 * Circuit JSON helpers
 *
 * Circuit JSON (https://github.com/tscircuit/circuit-json) is tscircuit's open,
 * serializable intermediate format -- the "AST" of a circuit and our on-disk
 * source of truth. These helpers parse it and answer the questions the editor
 * UI and the AI tools need: what components exist, what nets connect them, and
 * what looks wrong (lint).
 *
 * We intentionally keep this dependency-light and tolerant: Circuit JSON is a
 * flat array of typed elements, and we only read the fields we understand.
 */

import { formatElectricalValue, type ElectricalValueUnit } from './valueFormatting.ts';

export type AnyCircuitElement = Record<string, unknown> & { type: string };

export interface ComponentSummary {
  id: string;
  name: string;
  ftype?: string;
  value?: string;
  numericValue?: number;
  valueUnit?: ElectricalValueUnit;
  footprint?: string;
  manufacturerPartNumber?: string;
  schematicComponentId?: string;
  pcbComponentId?: string;
}

export interface NetSummary {
  /** Human label for the net (named net, or first connection). */
  name: string;
  /** "CompName.portName" endpoints joined by this net. */
  endpoints: string[];
  /** Exact internal identity for conservative re-resolution; UI consumers may ignore it. */
  sourceTraceId?: string;
  /** Exact rendered schematic connectivity join when the evaluator supplies one. */
  connectivityKey?: string;
  /** Exact source-port membership, kept separate from display endpoint prose. */
  endpointSourcePortIds?: string[];
}

export interface LintFinding {
  /** Optional stable diagnostic identity supplied by a future/native lint engine. */
  id?: string;
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  /** Optional exact source refs related to the finding. */
  relatedRefs?: string[];
}

/** Parse `.circuit.json` content into a Circuit JSON element array. */
export function parseCircuitJson(content: string): AnyCircuitElement[] {
  return parseCircuitJsonProjection(content).circuitJson;
}

/** Parse Circuit JSON while preserving failure state for freshness-sensitive actions. */
export function parseCircuitJsonProjection(content: string): { circuitJson: AnyCircuitElement[]; error?: string } {
  const trimmed = (content || '').trim();
  if (!trimmed) return { circuitJson: [] };
  try {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) return { circuitJson: data as AnyCircuitElement[] };
    // Tolerate { circuitJson: [...] } or { soup: [...] } wrappers.
    if (data && typeof data === 'object') {
      const inner = (data.circuitJson ?? data.soup ?? data.circuit_json) as unknown;
      if (Array.isArray(inner)) return { circuitJson: inner as AnyCircuitElement[] };
    }
  } catch (err) {
    console.error('[ElectronicsStudio] Failed to parse Circuit JSON:', err);
    return { circuitJson: [], error: err instanceof Error ? err.message : 'Invalid Circuit JSON.' };
  }
  return { circuitJson: [], error: 'Circuit JSON must be an array or contain a circuitJson/soup array.' };
}

export function serializeCircuitJson(elements: AnyCircuitElement[]): string {
  return JSON.stringify(elements, null, 2);
}

function elementsOfType(elements: AnyCircuitElement[], type: string): AnyCircuitElement[] {
  return elements.filter((el) => el && el.type === type);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Source components with their human-meaningful fields. */
export function listComponents(elements: AnyCircuitElement[]): ComponentSummary[] {
  const schematicBySource = new Map<string, string>();
  for (const el of elementsOfType(elements, 'schematic_component')) {
    const sourceId = str(el.source_component_id);
    const schematicId = str(el.schematic_component_id);
    if (sourceId && schematicId) schematicBySource.set(sourceId, schematicId);
  }
  const pcbBySource = new Map<string, string>();
  for (const el of elementsOfType(elements, 'pcb_component')) {
    const sourceId = str(el.source_component_id);
    const pcbId = str(el.pcb_component_id);
    if (sourceId && pcbId) pcbBySource.set(sourceId, pcbId);
  }
  const footprintBySource = new Map<string, string>();
  for (const el of elementsOfType(elements, 'cad_component')) {
    const sourceId = str(el.source_component_id);
    const footprint = str(el.footprinter_string);
    if (sourceId && footprint) footprintBySource.set(sourceId, footprint);
  }
  return elementsOfType(elements, 'source_component').map((el) => {
    const electricalValues: Array<[ElectricalValueUnit, unknown]> = [
      ['resistance', el.resistance],
      ['capacitance', el.capacitance],
      ['inductance', el.inductance],
    ];
    const electricalValue = electricalValues.find(([, candidate]) => (
      str(candidate) != null || (typeof candidate === 'number' && Number.isFinite(candidate))
    ));
    const rawValue = electricalValue?.[1];
    const numericValue = typeof rawValue === 'number' ? rawValue : undefined;
    const value = str(rawValue) ?? (numericValue != null ? String(numericValue) : str(el.display_value));
    const id = str(el.source_component_id) ?? '';
    return {
      id,
      name: str(el.name) ?? '(unnamed)',
      ftype: str(el.ftype),
      value,
      ...(numericValue != null ? { numericValue, valueUnit: electricalValue![0] } : {}),
      footprint: str(el.footprint) ?? footprintBySource.get(id),
      manufacturerPartNumber: str(el.manufacturer_part_number) ?? str(el.manufacturerPartNumber),
      schematicComponentId: schematicBySource.get(id),
      pcbComponentId: pcbBySource.get(id),
    };
  });
}

/**
 * Resolve nets from source_trace + source_net + source_port + source_component.
 * Each trace is a connection; we render it as the set of "Comp.port" endpoints
 * it ties together, labelled by an attached named net when present.
 */
export function listNets(elements: AnyCircuitElement[]): NetSummary[] {
  const portById = new Map<string, AnyCircuitElement>();
  for (const p of elementsOfType(elements, 'source_port')) {
    const id = str(p.source_port_id);
    if (id) portById.set(id, p);
  }
  const compById = new Map<string, AnyCircuitElement>();
  for (const c of elementsOfType(elements, 'source_component')) {
    const id = str(c.source_component_id);
    if (id) compById.set(id, c);
  }
  const netById = new Map<string, string>();
  for (const n of elementsOfType(elements, 'source_net')) {
    const id = str(n.source_net_id);
    if (id) netById.set(id, str(n.name) ?? id);
  }

  const portLabel = (portId: string): string => {
    const port = portById.get(portId);
    if (!port) return portId;
    const comp = compById.get(str(port.source_component_id) ?? '');
    const compName = comp ? str(comp.name) ?? '?' : '?';
    const portName = str(port.name) ?? (port.pin_number != null ? `pin${port.pin_number}` : portId);
    return `${compName}.${portName}`;
  };

  const nets: NetSummary[] = [];
  for (const trace of elementsOfType(elements, 'source_trace')) {
    const portIds = Array.isArray(trace.connected_source_port_ids)
      ? (trace.connected_source_port_ids as string[])
      : [];
    const netIds = Array.isArray(trace.connected_source_net_ids)
      ? (trace.connected_source_net_ids as string[])
      : [];
    const endpoints = portIds.map(portLabel);
    const netName = netIds.map((id) => netById.get(id)).find(Boolean);
    nets.push({
      name: netName ?? endpoints[0] ?? str(trace.source_trace_id) ?? 'net',
      endpoints,
      ...(str(trace.source_trace_id) ? { sourceTraceId: str(trace.source_trace_id) } : {}),
      ...(str(trace.subcircuit_connectivity_map_key) ? { connectivityKey: str(trace.subcircuit_connectivity_map_key) } : {}),
      ...(portIds.length ? { endpointSourcePortIds: [...portIds] } : {}),
    });
  }
  return nets;
}

export interface PlacedPin {
  /** Selector-friendly pin name, e.g. "GPIO4" or "pin2". */
  name: string;
  pinNumber?: number;
  connected: boolean;
  /** Net this pin joins, when connected. */
  net?: string;
}

export interface PlacedPartInfo {
  name: string;
  ftype?: string;
  value?: string;
  footprint?: string;
  /** Exact pins of the placed instance, ready to wire as `.REF > .PIN`. */
  pins: PlacedPin[];
}

/**
 * Introspect a placed component by ref designator: its exact pins and their
 * connectivity. This is the reliable way for the agent to learn valid wiring
 * selectors (`.U1 > .GPIO4`) for a part already in the circuit, whatever placed
 * it (catalog, block, or hand-authored code).
 */
export function describePlacedPart(elements: AnyCircuitElement[], ref: string): PlacedPartInfo | undefined {
  const comp = elementsOfType(elements, 'source_component').find((c) => str(c.name) === ref);
  if (!comp) return undefined;
  const cid = str(comp.source_component_id);

  // Which port ids are joined, and to what net label.
  const netByPort = new Map<string, string>();
  const connected = new Set<string>();
  const netById = new Map<string, string>();
  for (const n of elementsOfType(elements, 'source_net')) {
    const id = str(n.source_net_id);
    if (id) netById.set(id, str(n.name) ?? id);
  }
  for (const trace of elementsOfType(elements, 'source_trace')) {
    const portIds = Array.isArray(trace.connected_source_port_ids)
      ? (trace.connected_source_port_ids as string[])
      : [];
    const netIds = Array.isArray(trace.connected_source_net_ids)
      ? (trace.connected_source_net_ids as string[])
      : [];
    const label = netIds.map((id) => netById.get(id)).find(Boolean);
    for (const pid of portIds) {
      connected.add(pid);
      if (label) netByPort.set(pid, label);
    }
  }

  const allPorts = elementsOfType(elements, 'source_port').filter((p) => str(p.source_component_id) === cid);
  // For large parts, suppress unconnected `pinN` package noise (same convention
  // as reviewableSourcePorts) so the agent sees the pins worth wiring.
  const suppressNoise = allPorts.length > 8;
  const pins: PlacedPin[] = allPorts
    .map((p) => {
      const id = str(p.source_port_id) ?? '';
      const pinNumber = typeof p.pin_number === 'number' ? (p.pin_number as number) : undefined;
      const rawName = str(p.name);
      return {
        name: rawName ?? (pinNumber != null ? `pin${pinNumber}` : id),
        pinNumber,
        connected: connected.has(id),
        net: netByPort.get(id),
        _anon: !rawName || /^pin\d+$/i.test(rawName),
      };
    })
    .filter((pin) => pin.connected || !(suppressNoise && pin._anon))
    .map(({ _anon, ...pin }) => pin);

  return {
    name: ref,
    ftype: str(comp.ftype),
    value:
      str(comp.resistance) ??
      str(comp.capacitance) ??
      str(comp.inductance) ??
      str(comp.display_value),
    footprint: str(comp.footprint),
    pins,
  };
}

/**
 * Ports worth surfacing as user-authored connectivity obligations.
 *
 * Generic chip footprints can generate dozens of `pin17`-style package ports
 * even when the catalog intentionally models only a handful of named pins. For
 * large components, review the explicitly named ports and suppress that package
 * noise. Small discrete components keep all of their pins.
 */
export function reviewableSourcePorts(elements: AnyCircuitElement[]): AnyCircuitElement[] {
  const ports = elementsOfType(elements, 'source_port');
  const counts = new Map<string, number>();
  for (const port of ports) {
    const componentId = str(port.source_component_id);
    if (componentId) counts.set(componentId, (counts.get(componentId) ?? 0) + 1);
  }
  return ports.filter((port) => {
    const componentId = str(port.source_component_id);
    const componentPortCount = componentId ? counts.get(componentId) ?? 0 : 0;
    const name = str(port.name) ?? '';
    return componentPortCount <= 8 || !/^pin\d+$/i.test(name);
  });
}

/* ------------------------------------------------------------------ */
/* Hover index                                                          */
/* ------------------------------------------------------------------ */

/** A single labelled fact shown in a hover tooltip. */
export interface HoverRow {
  label: string;
  value: string;
}

/** Resolved description of a hovered circuit entity. */
export interface HoverContent {
  /** Coarse kind, for styling: 'component' | 'pin' | 'net'. */
  kind: 'component' | 'pin' | 'net';
  title: string;
  rows: HoverRow[];
}

/** Lookups the schematic / PCB views use to describe a hovered SVG element. */
export interface CircuitIndex {
  /** Describe a part from its `schematic_component_id`. */
  schematicComponent(id: string): HoverContent | null;
  /** Describe a part from its `pcb_component_id`. */
  pcbComponent(id: string): HoverContent | null;
  /** Describe a pin from its `source_port_id` (carried by schematic ports). */
  port(sourcePortId: string): HoverContent | null;
  /** Describe a net from a trace's `subcircuit_connectivity_map_key`. */
  net(connectivityKey: string): HoverContent | null;
  /** Resolve rendered schematic identity back to the source component. */
  schematicSourceComponentId(id: string): string | null;
  /** Resolve rendered PCB identity back to the source component. */
  pcbSourceComponentId(id: string): string | null;
  /** Resolve a rendered schematic port back to its owning source component. */
  portSourceComponentId(sourcePortId: string): string | null;
  /** Build the exact tscircuit selector for a rendered schematic port. */
  portConnectionSelector(sourcePortId: string): string | null;
}

const FTYPE_LABELS: Record<string, string> = {
  simple_resistor: 'Resistor',
  simple_capacitor: 'Capacitor',
  simple_inductor: 'Inductor',
  simple_led: 'LED',
  simple_diode: 'Diode',
  simple_chip: 'Chip / IC',
  simple_push_button: 'Push button',
  simple_switch: 'Switch',
  simple_potentiometer: 'Potentiometer',
  simple_pin_header: 'Pin header',
  simple_crystal: 'Crystal',
  simple_battery: 'Battery',
  simple_transistor: 'Transistor',
};

function prettyFtype(ftype?: string): string | undefined {
  if (!ftype) return undefined;
  return FTYPE_LABELS[ftype] ?? ftype.replace(/^simple_/, '').replace(/_/g, ' ');
}

/** The human-meaningful value of a component (resistance, capacitance, ...). */
function componentValue(el: AnyCircuitElement): string | undefined {
  const displayValue = (
    str(el.display_value) ??
    str(el.display_resistance) ??
    str(el.display_capacitance) ??
    str(el.display_inductance)
  );
  if (displayValue) return displayValue;

  const values: Array<[ElectricalValueUnit, unknown]> = [
    ['resistance', el.resistance],
    ['capacitance', el.capacitance],
    ['inductance', el.inductance],
  ];
  for (const [unit, value] of values) {
    const stringValue = str(value);
    if (stringValue) return stringValue;
    if (typeof value === 'number' && Number.isFinite(value)) return formatElectricalValue(value, unit);
  }
  return undefined;
}

function manufacturerPart(el: AnyCircuitElement): string | undefined {
  const direct = str(el.manufacturer_part_number) ?? str(el.manufacturerPartNumber);
  if (direct) return direct;
  const suppliers = el.supplier_part_numbers;
  if (suppliers && typeof suppliers === 'object') {
    for (const list of Object.values(suppliers as Record<string, unknown>)) {
      if (Array.isArray(list) && typeof list[0] === 'string') return list[0];
    }
  }
  return undefined;
}

/** Build the rows for a `source_component`. */
function componentRows(comp: AnyCircuitElement, extraValue?: string): HoverRow[] {
  const rows: HoverRow[] = [];
  const ftype = prettyFtype(str(comp.ftype));
  if (ftype) rows.push({ label: 'Type', value: ftype });
  const value = componentValue(comp) ?? extraValue;
  if (value) rows.push({ label: 'Value', value });
  const footprint = str(comp.footprint);
  if (footprint) rows.push({ label: 'Footprint', value: footprint });
  const mpn = manufacturerPart(comp);
  if (mpn) rows.push({ label: 'Part #', value: mpn });
  return rows;
}

/**
 * Build the per-render lookups the views need to turn a hovered SVG element
 * (identified by its `data-*` attributes) back into circuit facts. Cheap to
 * rebuild; the views memoize it on `circuitJson`.
 */
export function buildCircuitIndex(elements: AnyCircuitElement[]): CircuitIndex {
  const sourceCompById = new Map<string, AnyCircuitElement>();
  for (const c of elementsOfType(elements, 'source_component')) {
    const id = str(c.source_component_id);
    if (id) sourceCompById.set(id, c);
  }
  const schCompById = new Map<string, AnyCircuitElement>();
  for (const c of elementsOfType(elements, 'schematic_component')) {
    const id = str(c.schematic_component_id);
    if (id) schCompById.set(id, c);
  }
  const pcbCompById = new Map<string, AnyCircuitElement>();
  for (const c of elementsOfType(elements, 'pcb_component')) {
    const id = str(c.pcb_component_id);
    if (id) pcbCompById.set(id, c);
  }
  const sourcePortById = new Map<string, AnyCircuitElement>();
  for (const p of elementsOfType(elements, 'source_port')) {
    const id = str(p.source_port_id);
    if (id) sourcePortById.set(id, p);
  }

  const compName = (sourceComponentId?: string): string => {
    const comp = sourceComponentId ? sourceCompById.get(sourceComponentId) : undefined;
    return (comp && str(comp.name)) || '?';
  };
  const portLabel = (portId: string): string => {
    const port = sourcePortById.get(portId);
    if (!port) return portId;
    const name = str(port.name) ?? (port.pin_number != null ? `pin${port.pin_number}` : portId);
    return `${compName(str(port.source_component_id))}.${name}`;
  };

  // Index nets by connectivity-map key (the stable join the SVG exposes; the
  // schematic_trace's own source_trace_id is not reliably the source_trace id).
  interface NetInfo { label: string; endpoints: string[] }
  const netByKey = new Map<string, NetInfo>();
  const netByPort = new Map<string, NetInfo>();
  const netById = new Map<string, string>();
  for (const n of elementsOfType(elements, 'source_net')) {
    const id = str(n.source_net_id);
    if (id) netById.set(id, str(n.name) ?? id);
  }
  for (const trace of elementsOfType(elements, 'source_trace')) {
    const key = str(trace.subcircuit_connectivity_map_key);
    const portIds = Array.isArray(trace.connected_source_port_ids)
      ? (trace.connected_source_port_ids as string[])
      : [];
    const netIds = Array.isArray(trace.connected_source_net_ids)
      ? (trace.connected_source_net_ids as string[])
      : [];
    const endpoints = portIds.map(portLabel);
    const namedNet = netIds.map((id) => netById.get(id)).find(Boolean);
    const label = namedNet ?? str(trace.display_name) ?? (endpoints.join(' ↔ ') || 'net');
    const info: NetInfo = { label, endpoints };
    if (key) netByKey.set(key, info);
    for (const pid of portIds) netByPort.set(pid, info);
  }

  const netRows = (info: NetInfo): HoverRow[] =>
    info.endpoints.map((ep, i) => ({ label: i === 0 ? 'Pins' : '', value: ep }));

  return {
    schematicComponent(id) {
      const sc = schCompById.get(id);
      const comp = sc && sourceCompById.get(str(sc.source_component_id) ?? '');
      if (!comp) return null;
      return {
        kind: 'component',
        title: str(comp.name) ?? '(unnamed)',
        rows: componentRows(comp, sc ? str(sc.symbol_display_value) : undefined),
      };
    },
    pcbComponent(id) {
      const pc = pcbCompById.get(id);
      const comp = pc && sourceCompById.get(str(pc.source_component_id) ?? '');
      if (!comp) return null;
      const rows = componentRows(comp);
      const layer = pc && str(pc.layer);
      if (layer) rows.push({ label: 'Layer', value: layer });
      return { kind: 'component', title: str(comp.name) ?? '(unnamed)', rows };
    },
    port(sourcePortId) {
      const port = sourcePortById.get(sourcePortId);
      if (!port) return null;
      const name = str(port.name) ?? (port.pin_number != null ? `pin${port.pin_number}` : sourcePortId);
      const rows: HoverRow[] = [];
      if (port.pin_number != null) rows.push({ label: 'Pin', value: `${port.pin_number}` });
      const net = netByPort.get(sourcePortId);
      rows.push({ label: 'Net', value: net ? net.label : 'unconnected' });
      return {
        kind: 'pin',
        title: `${compName(str(port.source_component_id))}.${name}`,
        rows,
      };
    },
    net(connectivityKey) {
      const info = netByKey.get(connectivityKey);
      if (!info) return null;
      return { kind: 'net', title: info.label, rows: netRows(info) };
    },
    schematicSourceComponentId(id) {
      const sourceId = str(schCompById.get(id)?.source_component_id);
      return sourceId && sourceCompById.has(sourceId) ? sourceId : null;
    },
    pcbSourceComponentId(id) {
      const sourceId = str(pcbCompById.get(id)?.source_component_id);
      return sourceId && sourceCompById.has(sourceId) ? sourceId : null;
    },
    portSourceComponentId(sourcePortId) {
      const sourceId = str(sourcePortById.get(sourcePortId)?.source_component_id);
      return sourceId && sourceCompById.has(sourceId) ? sourceId : null;
    },
    portConnectionSelector(sourcePortId) {
      const port = sourcePortById.get(sourcePortId);
      if (!port) return null;
      const sourceId = str(port.source_component_id);
      const component = sourceId ? sourceCompById.get(sourceId) : undefined;
      const componentName = component && str(component.name);
      const portName = str(port.name) ?? (port.pin_number != null ? `pin${port.pin_number}` : undefined);
      return componentName && portName ? `.${componentName} > .${portName}` : null;
    },
  };
}

/**
 * Lightweight ERC-style lint. These are heuristics -- the kind of "you forgot a
 * flyback diode / decoupling cap / current-limit resistor" check the plan calls
 * for -- not a full electrical rule check. Cheap, useful, and AI-readable.
 */
export function lintCircuit(elements: AnyCircuitElement[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const comps = listComponents(elements);
  const exactRefs = (components: ComponentSummary[]): string[] => [...new Set(components
    .map((component) => component.name)
    .filter((name) => Boolean(name) && name !== '(unnamed)'))]
    .sort((a, b) => a.localeCompare(b));

  if (elements.length === 0) {
    findings.push({ severity: 'info', rule: 'empty', message: 'Circuit is empty. Add a board and parts.' });
    return findings;
  }

  const has = (ftype: string) => comps.some((c) => c.ftype === ftype);
  const count = (ftype: string) => comps.filter((c) => c.ftype === ftype).length;

  // LED without a series resistor anywhere.
  if (has('simple_led') && !has('simple_resistor')) {
    findings.push({
      severity: 'warning',
      rule: 'led-current-limit',
      message: 'An LED is present but no resistor was found. LEDs usually need a current-limit resistor.',
      relatedRefs: exactRefs(comps.filter((component) => component.ftype === 'simple_led')),
    });
  }

  // Chip/MCU without any decoupling capacitor.
  const chipCount = count('simple_chip');
  if (chipCount > 0 && count('simple_capacitor') === 0) {
    findings.push({
      severity: 'warning',
      rule: 'decoupling-cap',
      message: `${chipCount} chip(s) present but no decoupling capacitor. Add 100nF caps near power pins.`,
      relatedRefs: exactRefs(comps.filter((component) => component.ftype === 'simple_chip')),
    });
  }

  // Unconnected ports (a port referenced by no trace).
  const ports = reviewableSourcePorts(elements);
  const connectedPortIds = new Set<string>();
  for (const trace of elementsOfType(elements, 'source_trace')) {
    const ids = Array.isArray(trace.connected_source_port_ids)
      ? (trace.connected_source_port_ids as string[])
      : [];
    ids.forEach((id) => connectedPortIds.add(id));
  }
  const unconnected = ports.filter((p) => {
    const id = str(p.source_port_id);
    return id ? !connectedPortIds.has(id) : false;
  });
  if (unconnected.length > 0) {
    const relatedRefs = exactRefs(unconnected
      .map((port) => comps.find((component) => component.id === str(port.source_component_id)))
      .filter((component): component is ComponentSummary => Boolean(component)));
    findings.push({
      severity: 'info',
      rule: 'unconnected-pin',
      message: `${unconnected.length} pin(s) are not connected to any trace.`,
      relatedRefs,
    });
  }

  if (findings.length === 0) {
    findings.push({ severity: 'info', rule: 'ok', message: 'No lint issues found.' });
  }
  return findings;
}

/**
 * Shorten auto-generated schematic net labels for rendering.
 *
 * When a net has no explicit name, tscircuit names it by joining every connected
 * pin with "/", so a ground net becomes a 250-character label smeared across the
 * schematic. This collapses those into readable tags — power/ground rails to
 * `GND` / `3V3` / `5V` / ..., other multi-pin auto-nets to `firstPin +N` — while
 * leaving short, explicitly-named nets (e.g. `TRUCK_SENSE`) untouched. Display
 * only: net labels carry no connectivity, so rewriting the text is safe.
 */
const RAIL_HINTS: Array<[RegExp, string]> = [
  [/(^|_)A?P?GND(_[A-Z0-9]+)?$/i, 'GND'],
  [/(^|_)GROUND$/i, 'GND'],
  [/(^|_)3V3$/i, '3V3'],
  [/(^|_)3\.3V$/i, '3V3'],
  [/(^|_)1V8$/i, '1V8'],
  [/(^|_)5V$/i, '5V'],
  [/(^|_)12V$/i, '12V'],
  [/(^|_)VBAT$/i, 'VBAT'],
  [/(^|_)VCC$/i, 'VCC'],
  [/(^|_)VDD$/i, 'VDD'],
  [/(^|_)VIN$/i, 'VIN'],
];

function shortNetLabel(text: string): string {
  const members = text.split('/').map((s) => s.trim()).filter(Boolean);
  if (members.length <= 1) {
    return text.length <= 24 ? text : `${text.slice(0, 22)}…`;
  }
  for (const [re, label] of RAIL_HINTS) {
    if (members.some((m) => re.test(m))) return label;
  }
  const first = members[0];
  const base = first.length <= 18 ? first : `${first.slice(0, 16)}…`;
  return `${base} +${members.length - 1}`;
}

/**
 * Return a copy of the circuit with over-long schematic net labels shortened for
 * display. Only `schematic_net_label` elements are cloned; everything else is
 * passed through by reference.
 */
export function withReadableNetLabels(elements: AnyCircuitElement[]): AnyCircuitElement[] {
  return elements.map((el) => {
    if (el.type !== 'schematic_net_label') return el;
    const text = str(el.text);
    if (!text) return el;
    const short = shortNetLabel(text);
    return short === text ? el : { ...el, text: short };
  });
}

type NetLabelSide = 'left' | 'right' | 'top' | 'bottom';
type Point = { x: number; y: number };
type LabelBox = { minX: number; minY: number; maxX: number; maxY: number };
type Size = { width: number; height: number };

/**
 * circuit-to-svg 0.0.358 renders ordinary net-label flags with a 0.18 mm font,
 * a 1.2-font-unit body, and the Arial glyph widths below (normalized by the
 * renderer's 27-unit font height). The flag also adds 0.3 font units at each
 * end plus 0.06 per character. Keep these measured renderer constants together
 * so collision tests follow the polygon that is actually drawn.
 */
const NET_LABEL_FONT_SIZE = 0.18;
const NET_LABEL_HEIGHT = NET_LABEL_FONT_SIZE * 1.2;
const NET_LABEL_FIXED_PADDING = 0.3 * 2 + 0.3;
const NET_LABEL_CHARACTER_PADDING = 0.06;
const NET_LABEL_GLYPH_HEIGHT = 27;
const NET_LABEL_DEFAULT_GLYPH_WIDTH = 13;
const NET_LABEL_MAX_NUDGE = 0.6;
const NET_LABEL_NUDGE_STEP = 0.02;
const NET_LABEL_SEPARATION_EPSILON = 1e-6;

const NET_LABEL_GLYPH_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 7, '+': 14, '-': 8, '.': 7, '/': 7, '?': 13, '_': 13,
  '0': 13, '1': 13, '2': 13, '3': 13, '4': 13,
  '5': 13, '6': 13, '7': 13, '8': 13, '9': 13,
  A: 16, B: 16, C: 17, D: 17, E: 16, F: 15, G: 19, H: 17, I: 7,
  J: 12, K: 16, L: 13, M: 20, N: 17, O: 19, P: 16, Q: 19, R: 17,
  S: 16, T: 15, U: 17, V: 16, W: 23, X: 16, Y: 16, Z: 15,
  a: 13, b: 13, c: 12, d: 13, e: 13, f: 7, g: 13, h: 13, i: 5,
  j: 5, k: 12, l: 5, m: 20, n: 13, o: 13, p: 13, q: 13, r: 8,
  s: 12, t: 7, u: 13, v: 12, w: 17, x: 12, y: 12, z: 12,
};

function netLabelWidth(text: string): number {
  let glyphWidth = 0;
  for (const character of text) {
    glyphWidth += NET_LABEL_GLYPH_WIDTHS[character] ?? NET_LABEL_DEFAULT_GLYPH_WIDTH;
  }
  const fontRelativeWidth = glyphWidth / NET_LABEL_GLYPH_HEIGHT
    + NET_LABEL_FIXED_PADDING
    + NET_LABEL_CHARACTER_PADDING * text.length;
  return fontRelativeWidth * NET_LABEL_FONT_SIZE;
}

function netLabelBox(side: NetLabelSide, anchor: Point, text: string): LabelBox {
  const width = netLabelWidth(text);
  const halfHeight = NET_LABEL_HEIGHT / 2;
  switch (side) {
    case 'left':
      return { minX: anchor.x, minY: anchor.y - halfHeight, maxX: anchor.x + width, maxY: anchor.y + halfHeight };
    case 'right':
      return { minX: anchor.x - width, minY: anchor.y - halfHeight, maxX: anchor.x, maxY: anchor.y + halfHeight };
    case 'top':
      return { minX: anchor.x - halfHeight, minY: anchor.y - width, maxX: anchor.x + halfHeight, maxY: anchor.y };
    case 'bottom':
      return { minX: anchor.x - halfHeight, minY: anchor.y, maxX: anchor.x + halfHeight, maxY: anchor.y + width };
  }
}

function labelBoxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

interface LayoutNetLabel {
  elementIndex: number;
  stableId: string;
  side: NetLabelSide;
  originalAnchor: Point;
  anchor: Point;
  originalText: string;
  text: string;
}

interface ObstacleCounts {
  labels: number;
  components: number;
}

function point(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === 'number' && Number.isFinite(candidate.x)
    && typeof candidate.y === 'number' && Number.isFinite(candidate.y)
    ? { x: candidate.x, y: candidate.y }
    : null;
}

function size(value: unknown): Size | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width > 0
    && typeof candidate.height === 'number' && Number.isFinite(candidate.height) && candidate.height > 0
    ? { width: candidate.width, height: candidate.height }
    : null;
}

function componentBox(center: Point, componentSize: Size): LabelBox {
  return {
    minX: center.x - componentSize.width / 2,
    minY: center.y - componentSize.height / 2,
    maxX: center.x + componentSize.width / 2,
    maxY: center.y + componentSize.height / 2,
  };
}

function nudgeOffsets(): number[] {
  const offsets = [0];
  const stepCount = Math.floor(NET_LABEL_MAX_NUDGE / NET_LABEL_NUDGE_STEP);
  for (let step = 1; step <= stepCount; step += 1) {
    const distance = Number((step * NET_LABEL_NUDGE_STEP).toFixed(10));
    offsets.push(distance, -distance);
  }
  return offsets;
}

const NET_LABEL_NUDGE_OFFSETS = nudgeOffsets();

function anchorWithFreeAxisOffset(label: LayoutNetLabel, offset: number): Point {
  return label.side === 'left' || label.side === 'right'
    ? { x: label.originalAnchor.x, y: label.originalAnchor.y + offset }
    : { x: label.originalAnchor.x + offset, y: label.originalAnchor.y };
}

function fallbackLabelTexts(text: string): string[] {
  const withoutCount = text.replace(/\s+\+\d+$/, '');
  const candidates: string[] = [];
  if (withoutCount !== text) candidates.push(withoutCount);
  for (let length = Math.min(12, withoutCount.length - 1); length >= 3; length -= 1) {
    candidates.push(`${withoutCount.slice(0, length - 1)}…`);
  }
  return [...new Set(candidates)].filter((candidate) => candidate.length < text.length);
}

/**
 * Return a rendering-only copy whose colliding ordinary schematic net-label
 * flags are spread along their short/free axis. Schematic component center/size
 * boxes are static obstacles, and a body-overlapping label tries the direction
 * away from that body's center first. Each flag stays within 0.6 mm (three
 * common 0.2 mm pin rows) of its original tip. If no placement inside that cap
 * clears a collision, only that display label may lose its `+N` suffix or be
 * ellipsized more aggressively. If shortening still cannot clear a component,
 * the original attached placement wins. Symbol labels and malformed labels are
 * left untouched.
 *
 * Work is bounded by a fixed placement candidate set for each label, so the
 * worst case is O(labels × (labels + components)). Processing order is stable
 * by label id while output order continues to match the input Circuit JSON.
 */
export function withDecollidedNetLabels(elements: AnyCircuitElement[]): AnyCircuitElement[] {
  const componentBoxes = elements.flatMap((element): LabelBox[] => {
    if (element.type !== 'schematic_component') return [];
    const center = point(element.center);
    const componentSize = size(element.size);
    return center && componentSize ? [componentBox(center, componentSize)] : [];
  });
  const labels = elements.flatMap((element, elementIndex): LayoutNetLabel[] => {
    if (element.type !== 'schematic_net_label' || element.symbol_name) return [];
    const text = str(element.text);
    const anchor = point(element.anchor_position);
    const side = element.anchor_side;
    if (!text || !anchor || (side !== 'left' && side !== 'right' && side !== 'top' && side !== 'bottom')) return [];
    const id = str(element.schematic_net_label_id) || str(element.id) || `~${String(elementIndex).padStart(10, '0')}`;
    return [{
      elementIndex,
      stableId: `${id}\u0000${String(elementIndex).padStart(10, '0')}`,
      side,
      originalAnchor: anchor,
      anchor,
      originalText: text,
      text,
    }];
  }).sort((a, b) => a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0);

  const obstacleCounts = (label: LayoutNetLabel, anchor = label.anchor, text = label.text): ObstacleCounts => {
    const box = netLabelBox(label.side, anchor, text);
    let labelCount = 0;
    for (const other of labels) {
      if (other === label) continue;
      if (labelBoxesOverlap(box, netLabelBox(other.side, other.anchor, other.text))) labelCount += 1;
    }
    let componentCount = 0;
    for (const bodyBox of componentBoxes) {
      if (labelBoxesOverlap(box, bodyBox)) componentCount += 1;
    }
    return { labels: labelCount, components: componentCount };
  };

  const isBetter = (candidate: ObstacleCounts, current: ObstacleCounts): boolean => (
    candidate.components < current.components
    || (candidate.components === current.components && candidate.labels < current.labels)
  );

  if (!labels.some((label) => {
    const counts = obstacleCounts(label);
    return counts.labels > 0 || counts.components > 0;
  })) return elements.map((element) => element);

  // Resolve same-direction stacks as a unit first. Centering the accumulated
  // 0.016 mm row deficit keeps every flag close to its own pin instead of
  // making a later greedy placement jump across several rows.
  const parents = labels.map((_, index) => index);
  const findParent = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const join = (a: number, b: number): void => {
    const rootA = findParent(a);
    const rootB = findParent(b);
    if (rootA !== rootB) parents[rootB] = rootA;
  };
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      if (labels[i]!.side !== labels[j]!.side) continue;
      const boxA = netLabelBox(labels[i]!.side, labels[i]!.anchor, labels[i]!.text);
      const boxB = netLabelBox(labels[j]!.side, labels[j]!.anchor, labels[j]!.text);
      if (labelBoxesOverlap(boxA, boxB)) join(i, j);
    }
  }
  const parallelClusters = new Map<number, LayoutNetLabel[]>();
  labels.forEach((label, index) => {
    const root = findParent(index);
    parallelClusters.set(root, [...(parallelClusters.get(root) ?? []), label]);
  });
  for (const cluster of parallelClusters.values()) {
    if (cluster.length < 2) continue;
    const horizontalFlags = cluster[0]!.side === 'left' || cluster[0]!.side === 'right';
    cluster.sort((a, b) => {
      const axisA = horizontalFlags ? a.originalAnchor.y : a.originalAnchor.x;
      const axisB = horizontalFlags ? b.originalAnchor.y : b.originalAnchor.x;
      return axisA - axisB || (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0);
    });
    const positions = cluster.map((label) => horizontalFlags ? label.originalAnchor.y : label.originalAnchor.x);
    for (let index = 1; index < positions.length; index += 1) {
      positions[index] = Math.max(
        positions[index]!,
        positions[index - 1]! + NET_LABEL_HEIGHT + NET_LABEL_SEPARATION_EPSILON,
      );
    }
    const shifts = positions.map((position, index) => position - (
      horizontalFlags ? cluster[index]!.originalAnchor.y : cluster[index]!.originalAnchor.x
    ));
    const centeringShift = -(Math.min(...shifts) + Math.max(...shifts)) / 2;
    const centeredPositions = positions.map((position) => position + centeringShift);
    const fitsCap = centeredPositions.every((position, index) => Math.abs(position - (
      horizontalFlags ? cluster[index]!.originalAnchor.y : cluster[index]!.originalAnchor.x
    )) <= NET_LABEL_MAX_NUDGE);
    const clearsComponents = centeredPositions.every((position, index) => {
      const label = cluster[index]!;
      const anchor = horizontalFlags
        ? { x: label.originalAnchor.x, y: position }
        : { x: position, y: label.originalAnchor.y };
      return obstacleCounts(label, anchor).components === 0;
    });
    if (!fitsCap || !clearsComponents) continue;
    cluster.forEach((label, index) => {
      label.anchor = horizontalFlags
        ? { x: label.originalAnchor.x, y: centeredPositions[index]! }
        : { x: centeredPositions[index]!, y: label.originalAnchor.y };
    });
  }

  const preferredOffsetSign = (label: LayoutNetLabel, text: string): 1 | -1 => {
    const box = netLabelBox(label.side, label.anchor, text);
    const overlappingBody = componentBoxes.find((bodyBox) => labelBoxesOverlap(box, bodyBox));
    if (!overlappingBody) return 1;
    const bodyCenter = label.side === 'left' || label.side === 'right'
      ? (overlappingBody.minY + overlappingBody.maxY) / 2
      : (overlappingBody.minX + overlappingBody.maxX) / 2;
    const labelPosition = label.side === 'left' || label.side === 'right'
      ? label.originalAnchor.y
      : label.originalAnchor.x;
    return labelPosition < bodyCenter ? -1 : 1;
  };

  const placementOffsets = (label: LayoutNetLabel, text: string): number[] => {
    const preferredSign = preferredOffsetSign(label, text);
    return NET_LABEL_NUDGE_OFFSETS.map((offset, index) => (
      index === 0 || offset === 0 ? 0 : Math.abs(offset) * (index % 2 === 1 ? preferredSign : -preferredSign)
    ));
  };

  const bestPlacement = (label: LayoutNetLabel, text: string): { anchor: Point; counts: ObstacleCounts } => {
    let best = { anchor: label.anchor, counts: obstacleCounts(label, label.anchor, text) };
    for (const offset of placementOffsets(label, text)) {
      const candidateAnchor = anchorWithFreeAxisOffset(label, offset);
      const counts = obstacleCounts(label, candidateAnchor, text);
      if (isBetter(counts, best.counts)) {
        best = { anchor: candidateAnchor, counts };
        if (counts.components === 0 && counts.labels === 0) break;
      }
    }
    return best;
  };

  // First try movement only, in stable id order.
  for (const label of labels) {
    const currentCounts = obstacleCounts(label);
    if (currentCounts.labels === 0 && currentCounts.components === 0) continue;
    const best = bestPlacement(label, label.text);
    if (isBetter(best.counts, currentCounts)
      && (currentCounts.components === 0 || best.counts.components === 0)) label.anchor = best.anchor;
  }

  // Remaining clusters exceeded the movement cap; shorten only involved labels.
  for (const label of labels) {
    let currentCounts = obstacleCounts(label);
    if (currentCounts.labels === 0 && currentCounts.components === 0) continue;
    for (const candidateText of fallbackLabelTexts(label.text)) {
      const best = bestPlacement(label, candidateText);
      if (isBetter(best.counts, currentCounts)
        && (currentCounts.components === 0 || best.counts.components === 0)) {
        label.text = candidateText;
        label.anchor = best.anchor;
        currentCounts = best.counts;
      }
      if (currentCounts.components === 0 && currentCounts.labels === 0) break;
    }
    if (obstacleCounts(label).components > 0) {
      label.anchor = label.originalAnchor;
      label.text = label.originalText;
    }
  }

  const layoutByIndex = new Map(labels.map((label) => [label.elementIndex, label]));
  return elements.map((element, index) => {
    const layout = layoutByIndex.get(index);
    if (!layout) return element;
    const anchorChanged = layout.anchor.x !== layout.originalAnchor.x || layout.anchor.y !== layout.originalAnchor.y;
    const textChanged = layout.text !== layout.originalText;
    if (!anchorChanged && !textChanged) return element;
    return {
      ...element,
      ...(anchorChanged ? { anchor_position: layout.anchor } : {}),
      ...(textChanged ? { text: layout.text } : {}),
    };
  });
}

/** Does this circuit have anything renderable on the PCB view? */
export function hasPcbElements(elements: AnyCircuitElement[]): boolean {
  return elements.some((el) => typeof el.type === 'string' && el.type.startsWith('pcb_'));
}

/** Does this circuit have anything renderable on the schematic view? */
export function hasSchematicElements(elements: AnyCircuitElement[]): boolean {
  return elements.some((el) => typeof el.type === 'string' && el.type.startsWith('schematic_'));
}
