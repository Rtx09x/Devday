/**
 * Engine + MCU detection
 *
 * `mode: 'auto'` picks the cheapest engine that fits the design, and the MCU
 * sims need to know which controller family to emulate. Both are derived from
 * the components present in the Circuit JSON by matching manufacturer part
 * numbers / names against the known controller families.
 */

import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import { listComponents } from '../circuit/circuitJson.ts';
import type { McuTarget, SimMode } from './types.ts';

function partText(elements: AnyCircuitElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.type === 'source_component') {
      for (const k of ['name', 'manufacturer_part_number', 'manufacturerPartNumber']) {
        if (typeof el[k] === 'string') parts.push((el[k] as string).toLowerCase());
      }
    }
  }
  return parts.join(' ');
}

/** Which MCU family does this circuit contain, if any? */
export function detectMcu(elements: AnyCircuitElement[]): McuTarget | null {
  const text = partText(elements);
  if (/esp32|esp-?32|wroom|wrover/.test(text)) return 'esp32';
  if (/rp2040|pico/.test(text)) return 'rp2040';
  if (/atmega|atmel|arduino|uno|328p|mega2560|attiny/.test(text)) return 'avr';
  return null;
}

/** Pick an engine for `auto` mode: MCU if a controller is present, else analog. */
export function pickAutoMode(elements: AnyCircuitElement[]): Exclude<SimMode, 'auto'> {
  if (detectMcu(elements)) return 'mcu';
  // Any source/passive worth a SPICE pass?
  const comps = listComponents(elements);
  const analoglike = comps.some((c) =>
    ['simple_resistor', 'simple_capacitor', 'simple_inductor', 'simple_diode', 'voltage_source', 'simple_power_source'].includes(
      c.ftype ?? '',
    ),
  );
  return analoglike ? 'analog' : 'logical';
}
