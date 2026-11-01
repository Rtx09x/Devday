/**
 * Analog simulation (ngspice via bundled eecircuit-engine)
 *
 * SPICE is the right engine for power rails, sensor front-ends, LED current and
 * the analog behaviour of motor drivers. We run ngspice compiled to WASM through
 * `eecircuit-engine`. Its self-contained module inlines WASM as a data URL, so
 * it is large but deterministic and available offline. Everything is lazy and
 * guarded so a failure degrades clearly instead of breaking the editor.
 */

import type { AnyCircuitElement } from '../circuit/circuitJson.ts';
import { buildSpiceNetlist } from './netlist.ts';
import { emptyResult, type SimResult, type SimTrace } from './types.ts';

interface EecircuitSimulation {
  start(): Promise<void>;
  setNetList(input: string): void;
  runSim(): Promise<EecircuitResult>;
}
interface EecircuitResult {
  variableNames: string[];
  numPoints: number;
  dataType: 'real' | 'complex';
  data: Array<{ name: string; values: number[] | Array<{ real: number; img: number }> }>;
}

let modulePromise: Promise<{ Simulation: new () => EecircuitSimulation }> | null = null;

async function loadEngine() {
  if (!modulePromise) {
    modulePromise = import('eecircuit-engine')
      .then((m) => m as { Simulation: new () => EecircuitSimulation })
      .catch((err) => {
        modulePromise = null; // allow retry
        throw err;
      });
  }
  return modulePromise;
}

/** Run a transient/op analysis and return node-voltage traces. Never throws. */
export async function runAnalogSim(
  circuitJson: AnyCircuitElement[],
  opts: { durationMs?: number } = {},
): Promise<SimResult> {
  const started = performance.now();
  const result = emptyResult('analog', 'ngspice');
  try {
    const stopMs = opts.durationMs ?? 5;
    const { netlist, addedAnalysis, componentCount } = await buildSpiceNetlist(circuitJson, {
      tranStop: `${stopMs}m`,
      tranStep: `${Math.max(stopMs / 500, 0.001)}m`,
    });
    if (componentCount === 0) {
      result.notes.push('No SPICE-modelable components found. Analog sim needs passives/sources with values.');
      result.error = 'Empty netlist';
      result.durationMs = Math.round(performance.now() - started);
      return result;
    }

    const { Simulation } = await loadEngine();
    const sim = new Simulation();
    await sim.start();
    sim.setNetList(netlist);
    const raw = await sim.runSim();

    const { traces, sweepName } = parseResult(raw);
    result.traces = traces;
    result.ok = true;
    if (addedAnalysis) result.notes.push('No analysis directive in the design; ran a default transient sweep.');
    result.notes.push(
      `ngspice produced ${raw.numPoints} point(s) across ${traces.length} signal(s)` +
        ` (vars: ${(raw.variableNames ?? []).join(', ') || 'none'}) over ${sweepName}.`,
    );
    if (!traces.length) {
      // Surface the deck so the cause (no nodes / bad netlist) is diagnosable.
      result.notes.push(`Netlist:\n${netlist.trim()}`);
    }
    summarizeRails(traces, result.notes);
    result.simulatedMs = stopMs;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.notes.push(`Analog sim failed: ${result.error}.`);
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

/** Convert an eecircuit result into our trace shape (real values only). */
function parseResult(raw: EecircuitResult): { traces: SimTrace[]; sweepName: string } {
  if (raw.dataType !== 'real' || !raw.data?.length) return { traces: [], sweepName: 'n/a' };
  // The first variable is the independent sweep axis (time or voltage).
  const sweep = raw.data[0];
  const sweepVals = (sweep.values as number[]).map((x) => Number(x));
  const sweepName = sweep.name;
  const isTime = /time/i.test(sweepName);
  const traces: SimTrace[] = [];
  for (let i = 1; i < raw.data.length; i++) {
    const d = raw.data[i];
    const vals = (d.values as number[]).map((x) => Number(x));
    traces.push({
      name: d.name,
      unit: /^i\(|current/i.test(d.name) ? 'A' : 'V',
      // Normalise sweep to seconds when it is time (eecircuit reports seconds).
      t: isTime ? sweepVals : sweepVals,
      v: vals,
    });
  }
  return { traces, sweepName };
}

/** Flag rails that sag noticeably -- the kind of insight the agent reasons over. */
function summarizeRails(traces: SimTrace[], notes: string[]): void {
  for (const tr of traces) {
    if (tr.unit !== 'V' || tr.v.length === 0) continue;
    const min = Math.min(...tr.v);
    const max = Math.max(...tr.v);
    if (max - min > 0.1 && /v\(|vdd|vcc|3v3|5v|rail/i.test(tr.name)) {
      notes.push(`${tr.name}: ${min.toFixed(3)}V min / ${max.toFixed(3)}V max (swing ${(max - min).toFixed(3)}V).`);
    }
  }
}
