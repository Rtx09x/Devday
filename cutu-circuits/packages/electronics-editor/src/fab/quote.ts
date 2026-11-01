/**
 * Fab cost estimate
 *
 * A local, offline estimate of what a board costs to manufacture, from its area,
 * layer count, and quantity -- the kind of "is this ~$5 or ~$50" answer the
 * agent and user want before committing. It is a heuristic based on published
 * prototype pricing (JLCPCB/PCBWay-class), NOT a live vendor quote: live quoting
 * and ordering are outward-facing actions that need vendor credentials and a
 * network/backend path, which this extension deliberately does not perform
 * automatically. The result is structured so a future backend module could
 * submit it to a real API once the host exposes renderer->backend RPC.
 */

import type { AnyCircuitElement } from '../circuit/circuitJson';
import { getBoardOutline } from './board';
import { listComponents } from '../circuit/circuitJson';

export interface QuoteRequest {
  quantity?: number;
  layers?: number;
  /** Include assembly (SMT) cost estimate based on placed part count. */
  assembly?: boolean;
}

export interface QuoteEstimate {
  vendorClass: string;
  currency: 'USD';
  boardMm: { width: number; height: number };
  areaCm2: number;
  layers: number;
  quantity: number;
  uniqueParts: number;
  totalPlacements: number;
  pcbCost: number;
  assemblyCost: number;
  setupCost: number;
  total: number;
  perBoard: number;
  notes: string[];
}

/** Estimate cost. Heuristic prototype pricing; rounds to cents. */
export function estimateQuote(elements: AnyCircuitElement[], req: QuoteRequest = {}): QuoteEstimate {
  const outline = getBoardOutline(elements);
  const quantity = Math.max(1, Math.floor(req.quantity ?? 5));
  const layers = req.layers ?? 2;
  const areaCm2 = (outline.width / 10) * (outline.height / 10);

  const comps = listComponents(elements);
  const uniqueParts = comps.length;
  const totalPlacements = comps.length; // one placement per source component

  const notes: string[] = [];

  // Prototype PCB pricing: a low flat base for <=100cm2 at small qty, then area
  // and layer multipliers; bumps for larger boards. Coarse but realistic.
  let pcbBase = layers >= 4 ? 12 : 2; // 5pcs base ($2 for 2-layer protos is typical)
  const areaFactor = Math.max(1, areaCm2 / 100); // boards over 100cm2 scale up
  const layerFactor = layers >= 6 ? 4 : layers >= 4 ? 2 : 1;
  let pcbCost = pcbBase * areaFactor * layerFactor;
  // Quantity scaling above the 5pc base tier.
  if (quantity > 5) pcbCost += (quantity - 5) * 0.15 * areaFactor * layerFactor;
  pcbCost = round2(pcbCost);

  const setupCost = req.assembly ? 8 : 0; // stencil/setup fee for assembly
  let assemblyCost = 0;
  if (req.assembly) {
    // ~$0.0017/joint is below real cost; use a simple per-placement proxy.
    const perPlacement = 0.02;
    assemblyCost = round2(totalPlacements * perPlacement * quantity + uniqueParts * 0.5);
    notes.push('Assembly is a rough proxy (per-placement); real cost depends on part stock/price.');
  }

  const total = round2(pcbCost + assemblyCost + setupCost);
  if (!outline.explicit) notes.push('Board size inferred from part bounding box; add a sized <board> for an accurate area.');
  notes.push('Estimate only -- not a live vendor quote. Ordering needs vendor credentials and is not automated.');

  return {
    vendorClass: 'JLCPCB/PCBWay-class prototype',
    currency: 'USD',
    boardMm: { width: round2(outline.width), height: round2(outline.height) },
    areaCm2: round2(areaCm2),
    layers,
    quantity,
    uniqueParts,
    totalPlacements,
    pcbCost,
    assemblyCost,
    setupCost,
    total,
    perBoard: round2(total / quantity),
    notes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
