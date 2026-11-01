/**
 * Logical / interactive simulation
 *
 * The cheapest, most responsive axis: no SPICE, no firmware -- just a small
 * connectivity model that answers "press the button -> does the LED light?".
 * It is the right tool for early UX and for parts the analog/MCU engines don't
 * cover well (a servo sweeping, a stepper's position). We build a net graph from
 * the Circuit JSON, classify power/ground rails by name, then derive a display
 * state per part. Pure and synchronous, so the panel can re-run it live as the
 * user toggles inputs.
 */

import type { AnyCircuitElement, ComponentSummary } from '../circuit/circuitJson.ts';
import { listComponents } from '../circuit/circuitJson.ts';
import { emptyResult, type PartState, type SimResult, type SimTrace } from './types.ts';

const POWER_RE = /^(v\+|vcc|vdd|3v3|3\.3v|5v|\+5v?|\+3v3?|vbus|vin)$/i;
const GROUND_RE = /^(gnd|ground|vss|0|agnd|dgnd)$/i;

interface Graph {
  /** Union-find parent per port id. */
  parent: Map<string, string>;
  /** Net-group id -> human label (named net wins). */
  groupLabel: Map<string, string>;
  /** port id -> component id. */
  portComp: Map<string, string>;
  /** component id -> { name, ftype, portIds, portNames } */
  comps: Map<string, { name: string; ftype?: string; ports: Array<{ id: string; name: string }> }>;
}

function find(parent: Map<string, string>, x: string): string {
  let r = x;
  while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
  // Path compression.
  let c = x;
  while (parent.get(c) && parent.get(c) !== r) {
    const next = parent.get(c)!;
    parent.set(c, r);
    c = next;
  }
  return r;
}

function union(parent: Map<string, string>, a: string, b: string): void {
  if (!parent.has(a)) parent.set(a, a);
  if (!parent.has(b)) parent.set(b, b);
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

function buildGraph(elements: AnyCircuitElement[]): Graph {
  const parent = new Map<string, string>();
  const groupLabel = new Map<string, string>();
  const portComp = new Map<string, string>();
  const comps = new Map<string, { name: string; ftype?: string; ports: Array<{ id: string; name: string }> }>();
  const netName = new Map<string, string>();

  const get = (el: AnyCircuitElement, k: string) => (typeof el[k] === 'string' ? (el[k] as string) : undefined);

  for (const el of elements) {
    if (el.type === 'source_component') {
      const id = get(el, 'source_component_id');
      if (id) comps.set(id, { name: get(el, 'name') ?? id, ftype: get(el, 'ftype'), ports: [] });
    } else if (el.type === 'source_net') {
      const id = get(el, 'source_net_id');
      if (id) netName.set(id, get(el, 'name') ?? id);
    }
  }
  for (const el of elements) {
    if (el.type !== 'source_port') continue;
    const id = get(el, 'source_port_id');
    if (!id) continue;
    parent.set(id, id);
    const compId = get(el, 'source_component_id');
    if (compId) {
      portComp.set(id, compId);
      const portName = get(el, 'name') ?? (el.pin_number != null ? `pin${el.pin_number}` : id);
      comps.get(compId)?.ports.push({ id, name: portName });
    }
  }
  // Join ports that share a trace, and tag groups with any attached net name.
  for (const el of elements) {
    if (el.type !== 'source_trace') continue;
    const portIds = Array.isArray(el.connected_source_port_ids) ? (el.connected_source_port_ids as string[]) : [];
    for (let i = 1; i < portIds.length; i++) union(parent, portIds[0], portIds[i]);
    const netIds = Array.isArray(el.connected_source_net_ids) ? (el.connected_source_net_ids as string[]) : [];
    if (portIds.length && netIds.length) {
      const root = find(parent, portIds[0]);
      const label = netIds.map((n) => netName.get(n)).find(Boolean);
      if (label) groupLabel.set(root, label);
    }
  }
  return { parent, groupLabel, portComp, comps };
}

function groupOf(g: Graph, portId: string): string {
  return find(g.parent, portId);
}
function labelOf(g: Graph, portId: string): string | undefined {
  return g.groupLabel.get(groupOf(g, portId));
}
function isPower(label?: string): boolean {
  return !!label && POWER_RE.test(label.trim());
}
function isGround(label?: string): boolean {
  return !!label && GROUND_RE.test(label.trim());
}

/**
 * Derive a display state per part from connectivity + user stimulus.
 * Heuristics, not physics: enough to drive the live canvas and give the agent a
 * plausible "what happens when..." answer without compiling anything.
 */
export function computePartStates(
  elements: AnyCircuitElement[],
  stimulus: Record<string, unknown> = {},
): PartState[] {
  const g = buildGraph(elements);
  const comps = listComponents(elements);
  const byId = new Map(comps.map((c) => [c.id, c]));
  const states: PartState[] = [];

  // A group is "energised" if any port in it ties to power and the part also
  // reaches ground -- a crude but serviceable "is this powered" test.
  const reachesRail = (compId: string, test: (l?: string) => boolean): boolean => {
    const c = g.comps.get(compId);
    if (!c) return false;
    return c.ports.some((p) => test(labelOf(g, p.id)));
  };

  for (const [compId, c] of g.comps) {
    const summary: ComponentSummary | undefined = byId.get(compId);
    const ftype = c.ftype ?? summary?.ftype;
    const name = c.name;
    const st: Record<string, unknown> = {};
    let kind = ftype ?? 'part';

    if (ftype === 'simple_led') {
      kind = 'led';
      const poweredSide = reachesRail(compId, isPower);
      const groundSide = reachesRail(compId, isGround);
      const forced = stimulus[name];
      st.on = typeof forced === 'boolean' ? forced : poweredSide && groundSide;
    } else if (ftype === 'simple_switch' || ftype === 'simple_push_button') {
      kind = 'switch';
      st.pressed = stimulus[name] === true;
    } else if (ftype === 'simple_potentiometer') {
      kind = 'potentiometer';
      const v = stimulus[name];
      st.position = typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0.5;
    } else if (ftype === 'simple_chip') {
      kind = 'chip';
      st.powered = reachesRail(compId, isPower) && reachesRail(compId, isGround);
    } else if (/pin_header|connector/.test(ftype ?? '')) {
      // Servos/steppers/displays modeled as headers; reflect any stimulus.
      kind = 'header';
      if (typeof stimulus[name] === 'number') st.value = stimulus[name];
    }
    states.push({ sourceComponentId: compId, name, kind, state: st });
  }
  states.sort((a, b) => a.name.localeCompare(b.name));
  return states;
}

/** Full logical SimResult: part states + a flat digital trace per output. */
export function runLogicalSim(
  elements: AnyCircuitElement[],
  stimulus: Record<string, unknown> = {},
  durationMs = 100,
): SimResult {
  const started = performance.now();
  const result = emptyResult('logical', 'logical');
  const parts = computePartStates(elements, stimulus);
  result.parts = parts;
  result.ok = true;
  result.simulatedMs = durationMs;

  // Render LED/chip on/off as a steady digital trace over the window.
  const traces: SimTrace[] = [];
  for (const p of parts) {
    const level = p.state.on === true || p.state.powered === true ? 1 : p.state.pressed === true ? 1 : 0;
    if (p.kind === 'led' || p.kind === 'chip' || p.kind === 'switch') {
      traces.push({ name: p.name, unit: 'digital', t: [0, durationMs / 1000], v: [level, level] });
    }
  }
  result.traces = traces;

  const onLeds = parts.filter((p) => p.kind === 'led' && p.state.on).map((p) => p.name);
  const offLeds = parts.filter((p) => p.kind === 'led' && !p.state.on).map((p) => p.name);
  if (onLeds.length) result.notes.push(`LED(s) lit: ${onLeds.join(', ')}.`);
  if (offLeds.length) result.notes.push(`LED(s) off: ${offLeds.join(', ')} (check power/ground path).`);
  const unpowered = parts.filter((p) => p.kind === 'chip' && !p.state.powered).map((p) => p.name);
  if (unpowered.length) result.notes.push(`Chip(s) without a full power+ground path: ${unpowered.join(', ')}.`);
  if (!result.notes.length) result.notes.push('Logical model ran; no LEDs or chips to report on.');

  result.durationMs = Math.round(performance.now() - started);
  return result;
}
