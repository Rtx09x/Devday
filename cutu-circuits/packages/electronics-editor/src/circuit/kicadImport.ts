import type { AnyCircuitElement } from './circuitJson.ts';

export interface KicadSourceFile {
  path: string;
  content: string;
}

export interface KicadImportReport {
  formatVersion: 1;
  mode: 'diagnostic-migration';
  editable: false;
  canonicalSource: 'kicad';
  sourceFiles: string[];
  stats: Record<string, number>;
  warnings: string[];
  knownLimitations: string[];
}

export interface KicadImportBundle {
  circuitJson: AnyCircuitElement[];
  report: KicadImportReport;
  files: Record<string, string>;
}

const KNOWN_LIMITATIONS = [
  'Net labels and power symbols have partial support.',
  'Multi-sheet schematics are not fully supported.',
  'Component sizes and some port positions are approximated.',
  'Some pad shapes and routed-segment grouping may be approximated.',
  'The imported Circuit JSON is an inspection projection, not editable native TSX.',
];

export async function buildDiagnosticKicadImport(
  sourceFiles: KicadSourceFile[],
  projectName: string,
): Promise<KicadImportBundle> {
  const supported = sourceFiles.filter((file) => /\.kicad_(?:pro|sch|pcb|sym)$/i.test(file.path));
  if (!supported.some((file) => /\.kicad_(?:sch|pcb)$/i.test(file.path))) {
    throw new Error('KiCad diagnostic import needs at least one .kicad_sch or .kicad_pcb file.');
  }

  const { KicadToCircuitJsonConverter } = await import('kicad-to-circuit-json');
  const converter = new KicadToCircuitJsonConverter();
  for (const file of supported) converter.addFile(baseName(file.path), file.content);
  converter.runUntilFinished();

  const circuitJson = converter.getOutput() as AnyCircuitElement[];
  const stats = Object.fromEntries(
    Object.entries(converter.getStats()).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
  const report: KicadImportReport = {
    formatVersion: 1,
    mode: 'diagnostic-migration',
    editable: false,
    canonicalSource: 'kicad',
    sourceFiles: supported.map((file) => baseName(file.path)).sort(),
    stats,
    warnings: [...converter.getWarnings()].sort(),
    knownLimitations: KNOWN_LIMITATIONS,
  };
  const safeName = sanitizeName(projectName);
  const files: Record<string, string> = {
    [`${safeName}.imported.circuit.json`]: `${JSON.stringify(circuitJson, null, 2)}\n`,
    [`${safeName}-IMPORT_REPORT.md`]: renderImportReport(safeName, report),
    [`${safeName}-IMPORT_PROVENANCE.json`]: `${JSON.stringify(report, null, 2)}\n`,
  };
  for (const file of supported) files[`originals/${baseName(file.path)}`] = file.content;

  return { circuitJson, report, files };
}

function renderImportReport(projectName: string, report: KicadImportReport): string {
  return [
    `# KiCad diagnostic import: ${projectName}`,
    '',
    '**Status:** inspection projection only; original KiCad files remain canonical.',
    '',
    'Open the `.imported.circuit.json` file in Electronics Studio to inspect the converted schematic and PCB. Do not enable native edits or assume round-trip synchronization.',
    '',
    '## Source files',
    '',
    ...report.sourceFiles.map((file) => `- \`${file}\``),
    '',
    '## Converter statistics',
    '',
    ...(Object.keys(report.stats).length
      ? Object.entries(report.stats).map(([key, value]) => `- ${key}: ${value}`)
      : ['- No converter statistics were reported.']),
    '',
    '## Converter warnings',
    '',
    ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ['- None reported.']),
    '',
    '## Known limitations',
    '',
    ...report.knownLimitations.map((limitation) => `- ${limitation}`),
    '',
  ].join('\n');
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || 'source.kicad_sch';
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'kicad-import';
}
