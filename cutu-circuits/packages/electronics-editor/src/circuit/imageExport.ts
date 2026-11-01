/**
 * Design-image export
 *
 * Renders the circuit to standalone SVG files — the schematic, the PCB, and the
 * fabrication/assembly drawing — for embedding in a README, an issue, a
 * datasheet, or a design review. SVG is deliberate: it is scalable, diff-able,
 * embeds directly in Markdown/HTML, and (unlike PNG) needs no native
 * rasteriser, so it works entirely in the renderer realm. Open an SVG in any
 * browser or vector tool to export a PNG if a raster is required.
 *
 * Uses the export-only `circuit-to-svg` backend to produce deterministic image
 * artifacts without a browser DOM.
 */

import type { AnyCircuitElement } from './circuitJson';
import {
  hasPcbElements,
  hasSchematicElements,
  withDecollidedNetLabels,
  withReadableNetLabels,
} from './circuitJson';

export type CircuitView = 'schematic' | 'pcb' | 'assembly';

export interface ImageBundle {
  files: Record<string, string>;
  warnings: string[];
}

async function renderView(circuitJson: AnyCircuitElement[], view: CircuitView): Promise<string> {
  const svg = await import('circuit-to-svg');
  if (view === 'pcb') return svg.convertCircuitJsonToPcbSvg(circuitJson as never);
  if (view === 'assembly') return svg.convertCircuitJsonToAssemblySvg(circuitJson as never);
  // Schematic net labels get shortened so exported drawings stay readable.
  return svg.convertCircuitJsonToSchematicSvg(
    withDecollidedNetLabels(withReadableNetLabels(circuitJson)) as never,
  );
}

/** Render one or more views to SVG. `views` defaults to schematic + PCB. */
export async function buildImageBundle(
  circuitJson: AnyCircuitElement[],
  baseName: string,
  views: CircuitView[],
): Promise<ImageBundle> {
  const warnings: string[] = [];
  const files: Record<string, string> = {};

  for (const view of views) {
    if (view === 'schematic' && !hasSchematicElements(circuitJson)) {
      warnings.push('No schematic elements to render — skipping schematic.svg.');
      continue;
    }
    if ((view === 'pcb' || view === 'assembly') && !hasPcbElements(circuitJson)) {
      warnings.push(`No PCB elements to render — skipping ${view}.svg.`);
      continue;
    }
    try {
      files[`${baseName}-${view}.svg`] = await renderView(circuitJson, view);
    } catch (err) {
      warnings.push(`${view} render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { files, warnings };
}
