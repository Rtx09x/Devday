/**
 * SPICE netlist export
 *
 * Emits a portable `.cir` SPICE netlist from Circuit JSON so the design can be
 * carried into ngspice, LTspice, or any SPICE-compatible simulator for analysis
 * this extension does not do in-app. Pure conversion — no simulation, no CDN.
 */

import type { AnyCircuitElement } from './circuitJson';

export interface SpiceExport {
  netlist: string;
  warnings: string[];
}

export async function buildSpiceNetlist(circuitJson: AnyCircuitElement[]): Promise<SpiceExport> {
  const warnings: string[] = [];
  try {
    const mod = await import('circuit-json-to-spice');
    const netlist = mod.circuitJsonToSpice(circuitJson as never);
    const text =
      typeof (netlist as { toSpiceString?: () => string }).toSpiceString === 'function'
        ? (netlist as { toSpiceString: () => string }).toSpiceString()
        : mod.convertSpiceNetlistToString(netlist);
    if (!text.trim() || /^\*[^\n]*\n\.END/i.test(text.trim())) {
      warnings.push('Netlist is essentially empty — SPICE export only covers parts it can model (R/L/C, sources, diodes, transistors).');
    }
    return { netlist: text, warnings };
  } catch (err) {
    return { netlist: '', warnings: [`SPICE export failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
