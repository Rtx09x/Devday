/**
 * tscircuit code authoring
 *
 * The cleanest AI-mutable surface for a circuit is the tscircuit `.tsx` source:
 * placing a part is inserting a JSX element, wiring a net is inserting a
 * `<trace>`. These helpers give the AI tools a small, reliable string-level API
 * over that source plus a catalog of the part classes the plan calls out
 * (MCUs, motor drivers, motors, sensors, inputs, outputs, passives).
 *
 * We keep mutation deterministic and conservative: insert before the last
 * `</board>`, never reformat the user's existing code.
 */

export interface PartSpec {
  key: string;
  label: string;
  category: 'mcu' | 'driver' | 'motor' | 'sensor' | 'input' | 'output' | 'passive' | 'connector';
  /** Build the JSX for an instance with the given ref designator + position. */
  jsx: (name: string, pos: { schX: number; schY: number }) => string;
}

const chip = (
  name: string,
  pos: { schX: number; schY: number },
  manufacturerPartNumber: string,
  footprint: string,
  pinLabels: Record<string, string>,
): string => {
  const labels = JSON.stringify(pinLabels);
  return `    <chip name="${name}" manufacturerPartNumber="${manufacturerPartNumber}" footprint="${footprint}" pinLabels={${labels}} schX={${pos.schX}} schY={${pos.schY}} />`;
};

/**
 * Part catalog. MCUs and drivers are generic `<chip>`s with labelled pins so they
 * evaluate fully offline (no registry fetch); passives and common parts use
 * tscircuit's native elements.
 */
export const PART_CATALOG: PartSpec[] = [
  // --- Microcontrollers ---
  {
    key: 'esp32',
    label: 'ESP32 (WROOM)',
    category: 'mcu',
    jsx: (n, p) => chip(n, p, 'ESP32-WROOM-32', 'soic38', { pin1: '3V3', pin2: 'EN', pin8: 'GPIO4', pin38: 'GND' }),
  },
  {
    key: 'arduino_uno',
    label: 'Arduino Uno (ATmega328P)',
    category: 'mcu',
    jsx: (n, p) => chip(n, p, 'ATMEGA328P-PU', 'dip28', { pin7: 'VCC', pin8: 'GND', pin14: 'D8', pin19: 'D13' }),
  },
  {
    key: 'rp2040',
    label: 'RP2040 / Raspberry Pi Pico',
    category: 'mcu',
    jsx: (n, p) => chip(n, p, 'RP2040', 'qfn56', { pin1: 'GPIO0', pin44: '3V3', pin56: 'GND' }),
  },
  // --- Motor drivers ---
  {
    key: 'a4988',
    label: 'A4988 stepper driver',
    category: 'driver',
    jsx: (n, p) => chip(n, p, 'A4988', 'qfn28', { pin1: 'EN', pin12: 'STEP', pin11: 'DIR', pin8: 'VMOT', pin18: 'VDD' }),
  },
  {
    key: 'drv8825',
    label: 'DRV8825 stepper driver',
    category: 'driver',
    jsx: (n, p) => chip(n, p, 'DRV8825', 'htssop28', { pin22: 'STEP', pin21: 'DIR', pin1: 'VMOT' }),
  },
  {
    key: 'l298n',
    label: 'L298N dual H-bridge',
    category: 'driver',
    jsx: (n, p) => chip(n, p, 'L298N', 'multiwatt15', { pin4: 'VS', pin5: 'IN1', pin7: 'IN2', pin8: 'GND' }),
  },
  // --- Motors / actuators ---
  {
    key: 'servo',
    label: 'Servo (3-pin)',
    category: 'motor',
    jsx: (n, p) => `    <pinheader name="${n}" pinCount={3} pinLabels={["GND","V+","SIG"]} footprint="pinrow3" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'stepper_nema17',
    label: 'Stepper NEMA17 (4-wire)',
    category: 'motor',
    jsx: (n, p) => `    <pinheader name="${n}" pinCount={4} pinLabels={["A1","A2","B1","B2"]} footprint="pinrow4" schX={${p.schX}} schY={${p.schY}} />`,
  },
  // --- Sensors / inputs ---
  {
    key: 'limit_switch',
    label: 'Limit / endstop switch',
    category: 'input',
    jsx: (n, p) => `    <switch name="${n}" type="spst" footprint="pushbutton" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'pushbutton',
    label: 'Push button',
    category: 'input',
    jsx: (n, p) => `    <pushbutton name="${n}" footprint="pushbutton" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'potentiometer',
    label: 'Potentiometer / dial',
    category: 'input',
    jsx: (n, p) => `    <potentiometer name="${n}" maxResistance="10k" footprint="potentiometer" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'temp_sensor',
    label: 'Temperature sensor (3-pin)',
    category: 'sensor',
    jsx: (n, p) => `    <pinheader name="${n}" pinCount={3} pinLabels={["VCC","DATA","GND"]} footprint="pinrow3" schX={${p.schX}} schY={${p.schY}} />`,
  },
  // --- Outputs ---
  {
    key: 'led',
    label: 'LED',
    category: 'output',
    jsx: (n, p) => `    <led name="${n}" footprint="0603" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'neopixel',
    label: 'NeoPixel (WS2812B)',
    category: 'output',
    jsx: (n, p) => chip(n, p, 'WS2812B', 'soic4', { pin1: 'VDD', pin2: 'DOUT', pin3: 'GND', pin4: 'DIN' }),
  },
  {
    key: 'oled',
    label: 'OLED / LCD (I2C, 4-pin)',
    category: 'output',
    jsx: (n, p) => `    <pinheader name="${n}" pinCount={4} pinLabels={["GND","VCC","SCL","SDA"]} footprint="pinrow4" schX={${p.schX}} schY={${p.schY}} />`,
  },
  // --- Passives ---
  {
    key: 'resistor',
    label: 'Resistor',
    category: 'passive',
    jsx: (n, p) => `    <resistor name="${n}" resistance="1k" footprint="0402" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'capacitor',
    label: 'Capacitor (decoupling)',
    category: 'passive',
    jsx: (n, p) => `    <capacitor name="${n}" capacitance="100nF" footprint="0402" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'diode',
    label: 'Diode (e.g. flyback)',
    category: 'passive',
    jsx: (n, p) => `    <diode name="${n}" footprint="0805" schX={${p.schX}} schY={${p.schY}} />`,
  },
  {
    key: 'pinheader',
    label: 'Pin header / connector',
    category: 'connector',
    jsx: (n, p) => `    <pinheader name="${n}" pinCount={2} footprint="pinrow2" schX={${p.schX}} schY={${p.schY}} />`,
  },
];

export function findPart(key: string): PartSpec | undefined {
  return PART_CATALOG.find((p) => p.key === key);
}

const EMPTY_BOARD = `export default () => (\n  <board width="20mm" height="20mm">\n  </board>\n)\n`;

/** Ensure the source has a board to insert into; create a default if not. */
export function ensureBoard(code: string): string {
  if (/<board[\s>]/.test(code)) return code;
  return EMPTY_BOARD;
}

/** Count existing instances whose name starts with a prefix (for auto-naming). */
export function nextRefDesignator(code: string, prefix: string): string {
  const re = new RegExp(`name=["']${prefix}(\\d+)["']`, 'g');
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/** Default ref-designator prefix per part category. */
export function prefixForPart(part: PartSpec): string {
  switch (part.category) {
    case 'mcu':
    case 'driver':
      return 'U';
    case 'passive':
      return part.key === 'resistor' ? 'R' : part.key === 'capacitor' ? 'C' : part.key === 'diode' ? 'D' : 'X';
    case 'output':
      return part.key === 'led' ? 'LED' : 'U';
    case 'input':
      return part.key === 'potentiometer' ? 'RV' : 'SW';
    case 'motor':
      return 'M';
    case 'sensor':
      return 'SEN';
    case 'connector':
      return 'J';
    default:
      return 'X';
  }
}

/**
 * Approximate schematic footprint (width x height, in tscircuit schematic grid
 * units) of a placed part. A `<chip>` (MCU/driver) is many times larger than an
 * 0402 passive, so a fixed grid stride collides large chips with their
 * neighbours. Sizing placement by the part keeps everything clear.
 */
function sizeForTag(tag: string, attrs: string): { w: number; h: number } {
  switch (tag) {
    case 'chip': {
      // Roughly scale the box with the declared pin count when present.
      const m = /pinLabels=\{(\{[^}]*\}|\[[^\]]*\])/.exec(attrs);
      const pins = m ? (m[1].match(/[:,]/g)?.length ?? 0) + 1 : 8;
      const side = Math.max(6, Math.min(14, Math.round(2 + pins * 0.6)));
      return { w: side, h: side };
    }
    case 'pinheader': {
      const m = /pinCount=\{?(\d+)/.exec(attrs);
      const pins = m ? Number(m[1]) : 2;
      return { w: 4, h: Math.max(3, pins + 1) };
    }
    case 'potentiometer':
    case 'pushbutton':
    case 'switch':
      return { w: 3, h: 3 };
    case 'resistor':
    case 'capacitor':
    case 'diode':
    case 'led':
      return { w: 2, h: 2 };
    default:
      return { w: 3, h: 3 };
  }
}

const ROW_MAX_WIDTH = 18; // schematic units to scan across before dropping a row
const PART_GAP = 1.5;

interface PlacedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Read a numeric schematic coordinate (`schX={-2}` or `schX="2"`) from attrs. */
function readCoord(attrs: string, key: string): number {
  const m = new RegExp(`\\b${key}=\\{?["']?(-?[0-9.]+)`).exec(attrs);
  return m ? Number(m[1]) : 0;
}

/**
 * The bounding boxes of every named part already placed in the source, at their
 * *actual* schematic coordinates. Unlike a re-derived layout, this respects
 * hand-, AI-, and example-authored positions, so the next part can be slotted
 * into real free space instead of assuming a layout the source doesn't follow.
 */
function placedBoxes(code: string): PlacedBox[] {
  const re = /<(\w+)\b([^>]*?\bname=["'][^"']+["'][^>]*?)\/?>/g;
  const boxes: PlacedBox[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1] === 'trace') continue;
    const { w, h } = sizeForTag(m[1], m[2]);
    boxes.push({ cx: readCoord(m[2], 'schX'), cy: readCoord(m[2], 'schY'), w, h });
  }
  return boxes;
}

/** Do two boxes (plus a clearance gap) overlap? */
function boxesOverlap(a: PlacedBox, b: PlacedBox): boolean {
  return (
    Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + PART_GAP &&
    Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + PART_GAP
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Find a free schematic slot for the next part. Scans top-to-bottom,
 * left-to-right starting from the existing parts' top-left, returning the first
 * cell that doesn't collide with any placed part. This never stacks the new
 * part on an existing one regardless of how the source was laid out; the view
 * keeps its pan/zoom so the part appears in place.
 */
export function nextPlacement(code: string, part: PartSpec): { schX: number; schY: number } {
  const boxes = placedBoxes(code);
  const size = sizeForTag(tagForPart(part), '');
  if (boxes.length === 0) return { schX: 0, schY: 0 };

  const left = Math.min(...boxes.map((b) => b.cx - b.w / 2));
  const right = Math.max(...boxes.map((b) => b.cx + b.w / 2));
  const top = Math.max(...boxes.map((b) => b.cy + b.h / 2));
  const bottom = Math.min(...boxes.map((b) => b.cy - b.h / 2));
  const scanRight = Math.max(left + ROW_MAX_WIDTH, right + size.w + PART_GAP * 2);

  for (let y = top - size.h / 2; y > bottom - size.h - 40; y -= 1) {
    for (let x = left + size.w / 2; x <= scanRight; x += 1) {
      const cand: PlacedBox = { cx: round1(x), cy: round1(y), w: size.w, h: size.h };
      if (!boxes.some((b) => boxesOverlap(cand, b))) {
        return { schX: cand.cx, schY: cand.cy };
      }
    }
  }
  // Pathological fallback: drop below everything, aligned to the left edge.
  return { schX: round1(left + size.w / 2), schY: round1(bottom - size.h / 2 - PART_GAP) };
}

/** The primary JSX tag a catalog part renders as (for sizing). */
function tagForPart(part: PartSpec): string {
  const m = /<(\w+)\b/.exec(part.jsx('X', { schX: 0, schY: 0 }));
  return m ? m[1] : 'chip';
}

/** Stagger placement so newly-added parts don't stack on the origin. */
export function placementForIndex(index: number): { schX: number; schY: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { schX: -3 + col * 2, schY: 2 - row * 2 };
}

/** How many parts (named elements) are currently in the source. */
export function countParts(code: string): number {
  const m = code.match(/name=["'][^"']+["']/g);
  return m ? m.length : 0;
}

/** Insert a JSX element string before the last `</board>`. */
export function insertIntoBoard(code: string, jsx: string): string {
  const ensured = ensureBoard(code);
  const idx = ensured.lastIndexOf('</board>');
  if (idx === -1) {
    // No closing tag found (e.g. self-closing board) -- append a fresh board.
    return `${ensured}\n${EMPTY_BOARD.replace('  </board>', `${jsx}\n  </board>`)}`;
  }
  return `${ensured.slice(0, idx)}${jsx}\n  ${ensured.slice(idx)}`;
}

/**
 * Build a `<trace>` connecting two selectors. Selectors are tscircuit connection
 * strings, e.g. ".R1 > .pin2" or "net.GND" or ".U1 > .GPIO4".
 */
export function buildTrace(from: string, to: string): string {
  return `    <trace from="${from}" to="${to}" />`;
}

/* ------------------------------------------------------------------ */
/* Editing existing source (remove / update / board)                  */
/*                                                                    */
/* The agent needs to fix its own mistakes, not just append. These    */
/* string-level edits stay as conservative as the insert helpers: they */
/* touch only the element they target and never reformat the rest.     */
/* ------------------------------------------------------------------ */

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Set (or replace) one JSX attribute on a single element string. `rawValue` is
 * the literal source of the value, quotes/braces included (e.g. `"0402"` or
 * `{-2}`). Works for both self-closing (`... />`) and open (`<board ...>`) tags.
 */
function setJsxAttr(element: string, attr: string, rawValue: string): string {
  const attrRe = new RegExp(`\\s${attr}=(?:"[^"]*"|'[^']*'|\\{[^}]*\\})`);
  if (attrRe.test(element)) return element.replace(attrRe, ` ${attr}=${rawValue}`);
  return element.replace(/\s*(\/?>)\s*$/, ` ${attr}=${rawValue} $1`);
}

/** The value-bearing attribute for a discrete part's primary tag. */
function valueAttrForTag(tag: string): string {
  switch (tag) {
    case 'resistor':
      return 'resistance';
    case 'capacitor':
      return 'capacitance';
    case 'inductor':
      return 'inductance';
    case 'potentiometer':
      return 'maxResistance';
    default:
      return 'value';
  }
}

/** Remove `<trace>`s whose `from`/`to` reference the named part (e.g. `.R1`). */
function removeTracesReferencing(code: string, name: string): { code: string; removedTraces: number } {
  // `.R1` as a whole token so removing R1 never also strips R12's traces.
  const refRe = new RegExp(`\\.${escapeRe(name)}(?![\\w])`);
  let removedTraces = 0;
  // Selectors legitimately contain `>` (".U1 > .STEP"), so match up to the
  // closing `/>` with [\s\S] rather than [^>].
  const next = code.replace(/[ \t]*<trace\b[\s\S]*?\/>[ \t]*\n?/g, (match) => {
    if (refRe.test(match)) {
      removedTraces++;
      return '';
    }
    return match;
  });
  return { code: next, removedTraces };
}

export interface RemovePartResult {
  code: string;
  removed: boolean;
  removedTraces: number;
}

/** Remove a named part element and every trace that referenced it. */
export function removePartFromCode(code: string, name: string): RemovePartResult {
  const elRe = new RegExp(
    `[ \\t]*<(\\w+)\\b[^>]*?\\bname=["']${escapeRe(name)}["'][^>]*?/>[ \\t]*\\n?`,
    'g',
  );
  let removed = false;
  let next = code.replace(elRe, (match, tag: string) => {
    if (tag === 'trace') return match; // traces are handled below
    removed = true;
    return '';
  });
  const traces = removeTracesReferencing(next, name);
  next = traces.code;
  return { code: next, removed, removedTraces: traces.removedTraces };
}

export interface RemoveConnectionResult {
  code: string;
  removed: boolean;
}

/** Remove a `<trace>` matching the given endpoints (order-insensitive). */
export function removeConnectionFromCode(code: string, from: string, to: string): RemoveConnectionResult {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const a = norm(from);
  const b = norm(to);
  let removed = false;
  const next = code.replace(/[ \t]*<trace\b[\s\S]*?\/>[ \t]*\n?/g, (match) => {
    const f = norm(/from=["']([^"']*)["']/.exec(match)?.[1] ?? '');
    const t = norm(/to=["']([^"']*)["']/.exec(match)?.[1] ?? '');
    if ((f === a && t === b) || (f === b && t === a)) {
      removed = true;
      return '';
    }
    return match;
  });
  return { code: next, removed };
}

export interface UpdatePartChanges {
  /** New primary value (resistance/capacitance/... per part), e.g. "4.7k". */
  value?: string;
  footprint?: string;
  manufacturerPartNumber?: string;
}

export interface UpdatePartResult {
  code: string;
  found: boolean;
  changed: string[];
}

/** Change value / footprint / manufacturer part number of a named part. */
export function updatePartInCode(code: string, name: string, changes: UpdatePartChanges): UpdatePartResult {
  const re = new RegExp(`<(\\w+)\\b[^>]*?\\bname=["']${escapeRe(name)}["'][^>]*?/>`);
  const m = re.exec(code);
  if (!m) return { code, found: false, changed: [] };
  const original = m[0];
  const tag = m[1];
  let updated = original;
  const changed: string[] = [];
  if (changes.footprint != null) {
    updated = setJsxAttr(updated, 'footprint', `"${changes.footprint}"`);
    changed.push('footprint');
  }
  if (changes.manufacturerPartNumber != null) {
    updated = setJsxAttr(updated, 'manufacturerPartNumber', `"${changes.manufacturerPartNumber}"`);
    changed.push('manufacturerPartNumber');
  }
  if (changes.value != null) {
    const attr = valueAttrForTag(tag);
    updated = setJsxAttr(updated, attr, `"${changes.value}"`);
    changed.push(attr);
  }
  const next = code.slice(0, m.index) + updated + code.slice(m.index + original.length);
  return { code: next, found: true, changed };
}

export interface TransformPartOptions {
  surface: 'schematic' | 'pcb';
  dx?: number;
  dy?: number;
  rotationDelta?: number;
}

/** Nudge or rotate one named part without reformatting unrelated source. */
export function transformPartInCode(code: string, name: string, options: TransformPartOptions): UpdatePartResult {
  const re = new RegExp(`<(\\w+)\\b[^>]*?\\bname=["']${escapeRe(name)}["'][^>]*?/>`);
  const match = re.exec(code);
  if (!match) return { code, found: false, changed: [] };
  const original = match[0];
  let updated = original;
  const changed: string[] = [];
  const prefix = options.surface === 'schematic' ? 'sch' : 'pcb';

  const readNumber = (attr: string): number => {
    const value = new RegExp(`\\b${attr}=\\{?["']?(-?[0-9.]+)`).exec(original)?.[1];
    return value == null ? 0 : Number(value);
  };
  const setDelta = (attr: string, delta?: number) => {
    if (!delta) return;
    const next = Math.round((readNumber(attr) + delta) * 1000) / 1000;
    updated = setJsxAttr(updated, attr, `{${next}}`);
    changed.push(attr);
  };

  setDelta(`${prefix}X`, options.dx);
  setDelta(`${prefix}Y`, options.dy);
  if (options.rotationDelta) {
    const attr = `${prefix}Rotation`;
    const next = ((readNumber(attr) + options.rotationDelta) % 360 + 360) % 360;
    updated = setJsxAttr(updated, attr, `{${next}}`);
    changed.push(attr);
  }

  if (updated === original) return { code, found: true, changed: [] };
  return {
    code: code.slice(0, match.index) + updated + code.slice(match.index + original.length),
    found: true,
    changed,
  };
}

export interface DuplicatePartResult {
  code: string;
  found: boolean;
  name?: string;
}

/** Clone one self-closing part with a fresh ref and offset placement; traces are intentionally not copied. */
export function duplicatePartInCode(code: string, name: string, requestedName?: string): DuplicatePartResult {
  const re = new RegExp(`<(\\w+)\\b[^>]*?\\bname=["']${escapeRe(name)}["'][^>]*?/>`);
  const match = re.exec(code);
  if (!match) return { code, found: false };
  const original = match[0];
  const prefix = name.replace(/\d+$/, '') || 'X';
  const duplicateName = requestedName?.trim() || nextRefDesignator(code, prefix);
  if (new RegExp(`\\bname=["']${escapeRe(duplicateName)}["']`).test(code)) {
    throw new Error(`A part named "${duplicateName}" already exists.`);
  }

  const readNumber = (attr: string): number => {
    const value = new RegExp(`\\b${attr}=\\{?["']?(-?[0-9.]+)`).exec(original)?.[1];
    return value == null ? 0 : Number(value);
  };
  let duplicate = setJsxAttr(original, 'name', `"${duplicateName}"`);
  duplicate = setJsxAttr(duplicate, 'schX', `{${readNumber('schX') + 2}}`);
  duplicate = setJsxAttr(duplicate, 'pcbX', `{${readNumber('pcbX') + 2}}`);
  const lineStart = code.lastIndexOf('\n', match.index) + 1;
  const indent = code.slice(lineStart, match.index).match(/^\s*/)?.[0] ?? '';
  const insertion = `${original}\n${indent}${duplicate}`;
  return {
    code: code.slice(0, match.index) + insertion + code.slice(match.index + original.length),
    found: true,
    name: duplicateName,
  };
}

export interface SetBoardSizeResult {
  code: string;
  changed: boolean;
}

/** Set the board outline size (width/height as tscircuit dimension strings). */
export function setBoardSizeInCode(code: string, opts: { width?: string; height?: string }): SetBoardSizeResult {
  const ensured = ensureBoard(code);
  const re = /<board\b[^>]*?>/;
  const m = re.exec(ensured);
  if (!m) return { code: ensured, changed: false };
  let el = m[0];
  if (opts.width != null) el = setJsxAttr(el, 'width', `"${opts.width}"`);
  if (opts.height != null) el = setJsxAttr(el, 'height', `"${opts.height}"`);
  const next = ensured.slice(0, m.index) + el + ensured.slice(m.index + m[0].length);
  return { code: next, changed: el !== m[0] };
}

export interface AbsoluteGeometryChange {
  parts?: Array<{ ref: string; pcbX: number; pcbY: number; pcbRotation?: number }>;
  board?: { width?: number; height?: number };
}

/** Atomically rewrite literal named self-closing parts and the existing board to absolute PCB geometry. */
export function applyAbsoluteGeometryInCode(code: string, request: AbsoluteGeometryChange): SetBoardSizeResult {
  let next = code;
  for (const part of request.parts ?? []) {
    const re = new RegExp(`<(\\w+)\\b[^>]*?\\bname=["']${escapeRe(part.ref)}["'][^>]*?/>`, 'g');
    const matches = [...next.matchAll(re)];
    if (matches.length === 0) throw new Error(`No direct self-closing part named "${part.ref}" exists in source.`);
    if (matches.length > 1) throw new Error(`Part ref "${part.ref}" appears more than once in source.`);
    const match = matches[0];
    let element = match[0];
    element = setJsxAttr(element, 'pcbX', `{${part.pcbX}}`);
    element = setJsxAttr(element, 'pcbY', `{${part.pcbY}}`);
    if (part.pcbRotation != null) element = setJsxAttr(element, 'pcbRotation', `{${part.pcbRotation}}`);
    next = next.slice(0, match.index) + element + next.slice((match.index ?? 0) + match[0].length);
  }
  if (request.board?.width != null || request.board?.height != null) {
    const boardMatches = [...next.matchAll(/<board\b[^>]*?>/g)];
    if (boardMatches.length !== 1) throw new Error(`Geometry preview requires exactly one direct board element; found ${boardMatches.length}.`);
    const result = setBoardSizeInCode(next, {
      ...(request.board.width != null ? { width: `${request.board.width}mm` } : {}),
      ...(request.board.height != null ? { height: `${request.board.height}mm` } : {}),
    });
    next = result.code;
  }
  return { code: next, changed: next !== code };
}

export interface CatalogPartInfo {
  key: string;
  label: string;
  category: PartSpec['category'];
  /** Primary JSX tag the part renders as. */
  tag: string;
  footprint?: string;
  manufacturerPartNumber?: string;
  /** Pin labels usable as `.REF > .PIN` selectors when wiring. */
  pins: string[];
}

/** Extract the pin labels a catalog part exposes (for wiring selectors). */
function extractPinLabels(jsx: string, tag: string): string[] {
  const obj = /pinLabels=\{(\{[^}]*\})\}/.exec(jsx);
  if (obj) {
    try {
      return Object.values(JSON.parse(obj[1]) as Record<string, string>).map(String);
    } catch {
      /* fall through */
    }
  }
  const arr = /pinLabels=\{(\[[^\]]*\])\}/.exec(jsx);
  if (arr) {
    try {
      return (JSON.parse(arr[1]) as string[]).map(String);
    } catch {
      /* fall through */
    }
  }
  if (tag === 'resistor' || tag === 'capacitor' || tag === 'inductor') return ['pin1', 'pin2'];
  if (tag === 'led' || tag === 'diode') return ['anode', 'cathode'];
  if (tag === 'potentiometer') return ['pin1', 'pin2', 'pin3'];
  return [];
}

/** Describe a catalog part statically (tag/footprint/MPN/pins) without placing it. */
export function describeCatalogPart(key: string): CatalogPartInfo | undefined {
  const spec = findPart(key);
  if (!spec) return undefined;
  const jsx = spec.jsx('X', { schX: 0, schY: 0 });
  const tag = /<(\w+)\b/.exec(jsx)?.[1] ?? 'chip';
  return {
    key: spec.key,
    label: spec.label,
    category: spec.category,
    tag,
    footprint: /footprint=["']([^"']+)["']/.exec(jsx)?.[1],
    manufacturerPartNumber: /manufacturerPartNumber=["']([^"']+)["']/.exec(jsx)?.[1],
    pins: extractPinLabels(jsx, tag),
  };
}

/** The whole catalog as lightweight rows (key/label/category), for discovery. */
export function catalogSummary(): Array<{ key: string; label: string; category: PartSpec['category'] }> {
  return PART_CATALOG.map((p) => ({ key: p.key, label: p.label, category: p.category }));
}
