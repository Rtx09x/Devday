/**
 * Bill-of-materials export
 *
 * The universal fab bundle (`fab.ts`) already emits a generic BOM CSV. This
 * module makes the BOM a first-class, standalone artifact in the formats people
 * actually hand off:
 *
 *  - `generic`  — vendor-neutral CSV (the same rows `fab.ts` emits).
 *  - `jlcpcb`   — the paired BOM + CPL (placement) CSVs JLCPCB assembly expects.
 *  - `markdown` — a Markdown table to paste into a README, issue, or doc.
 *
 * Everything is derived from Circuit JSON; nothing here talks to a vendor.
 */

import type { AnyCircuitElement } from './circuitJson';
import {
  type AssemblyHandoffReport,
} from './assemblyHandoff.ts';
import { buildBomProjection } from './bomProjection.ts';

export type BomFormat = 'generic' | 'jlcpcb' | 'markdown';

export interface BomBundle {
  files: Record<string, string>;
  warnings: string[];
  format: BomFormat;
  /** Distinct line items (grouped by value + footprint + part number). */
  lineItems: number;
  /** Exact JLC-style completeness evidence; present only for that template. */
  assemblyHandoff?: AssemblyHandoffReport;
}

export interface BomGroup {
  comment: string; // value / type
  footprint: string;
  lcsc: string;
  mpn: string;
  designators: string[];
}

/** Group source components into BOM line items by (value, footprint, part #). */
export function groupBomLines(
  circuitJson: AnyCircuitElement[],
  assemblyHandoff?: AssemblyHandoffReport,
): BomGroup[] {
  return buildBomProjection(circuitJson, assemblyHandoff).lines.map((line) => ({
    comment: line.comment,
    footprint: line.footprint,
    lcsc: line.lcscPartNumber,
    mpn: line.manufacturerPartNumber,
    designators: line.refs.map((ref) => ref.ref),
  }));
}

/* ---- CSV helpers ---------------------------------------------------- */

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

/* ---- JLCPCB placement (CPL) ---------------------------------------- */

interface Placement {
  designator: string;
  x: number;
  y: number;
  layer: string;
  rotation: number;
}

/** Component placements for the CPL file, from `pcb_component` elements. */
function placements(report: AssemblyHandoffReport): Placement[] {
  return report.parts.flatMap((part) => part.placement ? [{
    designator: part.ref,
    x: part.placement.xMm,
    y: part.placement.yMm,
    layer: part.placement.layer === 'bottom' ? 'Bottom' : 'Top',
    rotation: part.placement.rotationDeg,
  }] : []);
}

/* ---- Format builders ------------------------------------------------ */

function buildJlcpcbBom(lines: BomGroup[]): string {
  const header = csvRow(['Comment', 'Designator', 'Footprint', 'LCSC Part #']);
  const rows = lines.map((l) =>
    csvRow([l.comment, l.designators.join(','), l.footprint, l.lcsc]),
  );
  return [header, ...rows].join('\n') + '\n';
}

function buildJlcpcbCpl(places: Placement[]): string {
  const header = csvRow(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']);
  const rows = places.map((p) =>
    csvRow([p.designator, `${p.x.toFixed(4)}mm`, `${p.y.toFixed(4)}mm`, p.layer, `${p.rotation}`]),
  );
  return [header, ...rows].join('\n') + '\n';
}

function buildMarkdownBom(lines: BomGroup[], baseName: string): string {
  const totalParts = lines.reduce((n, l) => n + l.designators.length, 0);
  const head = [
    `# Bill of materials — ${baseName}`,
    '',
    `${lines.length} line item(s), ${totalParts} placed part(s).`,
    '',
    '| # | Qty | Value | Designators | Footprint | Part # |',
    '| - | --- | ----- | ----------- | --------- | ------ |',
  ];
  const rows = lines.map((l, i) => {
    const part = l.lcsc || l.mpn || '';
    return `| ${i + 1} | ${l.designators.length} | ${l.comment || '—'} | ${l.designators.join(', ')} | ${l.footprint || '—'} | ${part || '—'} |`;
  });
  return [...head, ...rows, ''].join('\n');
}

/* ---- Entry point ---------------------------------------------------- */

export async function buildBomBundle(
  circuitJson: AnyCircuitElement[],
  baseName: string,
  format: BomFormat,
): Promise<BomBundle> {
  const warnings: string[] = [];
  const files: Record<string, string> = {};
  const projection = buildBomProjection(circuitJson);
  const assemblyHandoff = format === 'jlcpcb' ? projection.assemblyHandoff : undefined;
  const lines = projection.lines.map((line) => ({
    comment: line.comment,
    footprint: line.footprint,
    lcsc: line.lcscPartNumber,
    mpn: line.manufacturerPartNumber,
    designators: line.refs.map((ref) => ref.ref),
  }));

  if (lines.length === 0) {
    warnings.push('No source components found — the BOM will be empty. Add parts to the circuit first.');
  }

  if (format === 'markdown') {
    files[`${baseName}-bom.md`] = buildMarkdownBom(lines, baseName);
  } else if (format === 'jlcpcb') {
    files[`${baseName}-bom-jlcpcb.csv`] = buildJlcpcbBom(lines);
    const places = placements(assemblyHandoff!);
    if (places.length === 0) {
      warnings.push('No PCB placements found — the CPL (placement) file will be empty. Give parts board positions.');
    }
    files[`${baseName}-cpl-jlcpcb.csv`] = buildJlcpcbCpl(places);
    const blocked = assemblyHandoff!.parts.filter((part) => !part.readyForTemplate);
    if (blocked.length > 0) {
      warnings.push(`Assembly handoff blockers: ${blocked.map((part) => `${part.ref} (${part.issues.map((issue) => issue.code).join(', ')})`).join('; ')}. No missing field was guessed.`);
    }
  } else {
    // Generic vendor-neutral CSV via tscircuit's converter (same rows fab.ts uses).
    try {
      const bomMod = await import('circuit-json-to-bom-csv');
      const rows = await bomMod.convertCircuitJsonToBomRows({ circuitJson: circuitJson as never });
      files[`${baseName}-bom.csv`] = bomMod.convertBomRowsToCsv(rows);
    } catch (err) {
      warnings.push(`Generic BOM export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    files,
    warnings,
    format,
    lineItems: lines.length,
    ...(assemblyHandoff ? { assemblyHandoff } : {}),
  };
}
