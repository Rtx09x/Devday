/**
 * Circuit JSON -> SPICE netlist
 *
 * The analog axis needs a SPICE deck, not Circuit JSON. tscircuit's
 * `circuit-json-to-spice` walks the same Circuit JSON we already hold and emits
 * a `SpiceNetlist`; we stringify it and, when the design lacks any analysis
 * directive, append a sensible default transient/op analysis so ngspice has
 * something to compute. Kept lazy: the converter only loads when the analog
 * path actually runs.
 */

import type { AnyCircuitElement } from '../circuit/circuitJson.ts';

export interface NetlistResult {
  netlist: string;
  /** True when we synthesised an analysis directive (no .tran/.op in source). */
  addedAnalysis: boolean;
  componentCount: number;
}

/** Build a SPICE netlist string from Circuit JSON. */
export async function buildSpiceNetlist(
  circuitJson: AnyCircuitElement[],
  opts: { tranStop?: string; tranStep?: string } = {},
): Promise<NetlistResult> {
  const mod = await import('circuit-json-to-spice');
  const netlistObj = mod.circuitJsonToSpice(circuitJson as never);
  let netlist =
    typeof mod.convertSpiceNetlistToString === 'function'
      ? mod.convertSpiceNetlistToString(netlistObj)
      : (netlistObj as { toSpiceString(): string }).toSpiceString();

  const componentCount = (netlistObj as { components?: unknown[] }).components?.length ?? 0;

  // eecircuit-engine runs the deck and captures the result vectors itself, so it
  // wants the analysis expressed as a bare dot-card (".tran step stop"), NOT a
  // ".control ... .endc" block (which suppresses the vectors it reads back). If
  // the design has no analysis directive, synthesise a short transient sweep.
  const lower = netlist.toLowerCase();
  const hasAnalysis = /^\s*\.(tran|op|dc|ac)\b/m.test(lower) || /\.control/.test(lower);
  let addedAnalysis = false;
  // Strip any trailing .end so we can append the analysis before re-terminating.
  const body = ensureTitle(netlist).replace(/\n?\.end\s*$/i, '').trimEnd();
  if (!hasAnalysis) {
    const step = opts.tranStep ?? '10u';
    const stop = opts.tranStop ?? '5m';
    netlist = `${body}\n.tran ${step} ${stop}\n.end\n`;
    addedAnalysis = true;
  } else {
    netlist = `${body}\n.end\n`;
  }

  return { netlist, addedAnalysis, componentCount };
}

/** SPICE decks treat the first line as a title comment; guarantee one exists. */
function ensureTitle(netlist: string): string {
  const trimmed = netlist.replace(/\n?\.end\s*$/i, '').trimEnd();
  if (trimmed.startsWith('*') || /\S/.test(trimmed.split('\n')[0] ?? '')) return trimmed;
  return '* CutuCircuits Electronics Studio netlist\n' + trimmed;
}
