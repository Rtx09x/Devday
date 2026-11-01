/** Higher-level circuit operations shared by the human palette and AI tools. */

import {
  buildTrace,
  findPart,
  insertIntoBoard,
  nextPlacement,
  nextRefDesignator,
  prefixForPart,
} from './tscircuitCode.ts';

export interface FunctionalBlockSpec {
  key: string;
  label: string;
  description: string;
  accent: 'mint' | 'blue' | 'amber' | 'violet';
  partKeys: string[];
  /** Connections refer to zero-based entries in partKeys. */
  connections: Array<{ from: [number, string]; to: [number, string] | string }>;
}

export interface FunctionalBlockResult {
  code: string;
  block: string;
  parts: Array<{ key: string; name: string }>;
  connections: Array<{ from: string; to: string }>;
}

export const FUNCTIONAL_BLOCKS: FunctionalBlockSpec[] = [
  {
    key: 'status_led',
    label: 'Status LED',
    description: 'Current-limited indicator ready to connect to a GPIO.',
    accent: 'mint',
    partKeys: ['resistor', 'led'],
    connections: [{ from: [0, 'pin2'], to: [1, 'anode'] }],
  },
  {
    key: 'mcu_blink',
    label: 'Arduino Blink',
    description: 'ATmega328P, resistor, and LED wired for firmware simulation.',
    accent: 'blue',
    partKeys: ['arduino_uno', 'resistor', 'led'],
    connections: [
      { from: [0, 'D13'], to: [1, 'pin1'] },
      { from: [1, 'pin2'], to: [2, 'anode'] },
      { from: [2, 'cathode'], to: [0, 'GND'] },
    ],
  },
  {
    key: 'i2c_sensor',
    label: 'I²C Sensor Port',
    description: 'Four-wire sensor header with SDA and SCL pull-ups.',
    accent: 'violet',
    partKeys: ['oled', 'resistor', 'resistor'],
    connections: [
      { from: [0, 'VCC'], to: 'net.V3_3' },
      { from: [0, 'GND'], to: 'net.GND' },
      { from: [0, 'SDA'], to: [1, 'pin1'] },
      { from: [1, 'pin2'], to: 'net.V3_3' },
      { from: [0, 'SCL'], to: [2, 'pin1'] },
      { from: [2, 'pin2'], to: 'net.V3_3' },
    ],
  },
  {
    key: 'neopixel_output',
    label: 'NeoPixel Output',
    description: 'Addressable RGB output with local 100 nF decoupling.',
    accent: 'amber',
    partKeys: ['neopixel', 'capacitor'],
    connections: [
      { from: [0, 'VDD'], to: [1, 'pin1'] },
      { from: [0, 'GND'], to: [1, 'pin2'] },
    ],
  },
];

export function findFunctionalBlock(key: string): FunctionalBlockSpec | undefined {
  return FUNCTIONAL_BLOCKS.find((block) => block.key === key);
}

/** Insert all parts and internal wiring for a reusable functional block. */
export function insertFunctionalBlock(code: string, key: string): FunctionalBlockResult {
  const block = findFunctionalBlock(key);
  if (!block) throw new Error(`Unknown functional block "${key}".`);

  let nextCode = code;
  const parts: FunctionalBlockResult['parts'] = [];
  for (const partKey of block.partKeys) {
    const part = findPart(partKey);
    if (!part) throw new Error(`Functional block "${key}" references unknown part "${partKey}".`);
    const name = nextRefDesignator(nextCode, prefixForPart(part));
    const position = nextPlacement(nextCode, part);
    nextCode = insertIntoBoard(nextCode, part.jsx(name, position));
    parts.push({ key: part.key, name });
  }

  const connections = block.connections.map((connection) => {
    const from = selector(parts, connection.from);
    const to = typeof connection.to === 'string' ? connection.to : selector(parts, connection.to);
    nextCode = insertIntoBoard(nextCode, buildTrace(from, to));
    return { from, to };
  });

  return { code: nextCode, block: block.key, parts, connections };
}

function selector(parts: FunctionalBlockResult['parts'], endpoint: [number, string]): string {
  const part = parts[endpoint[0]];
  if (!part) throw new Error(`Functional block endpoint references missing part index ${endpoint[0]}.`);
  return `.${part.name} > .${endpoint[1]}`;
}
