export const PROJECT_GUIDANCE_SCHEMA_VERSION = 1;

export interface ProjectRequirements {
  powerSources: string[];
  interfaces: string[];
  connectors: string[];
  environment: string[];
  quantity?: number;
  assemblyPreference?: string;
  targetFab?: string;
  board?: { maxWidthMm?: number; maxHeightMm?: number };
}

export interface ProjectRules {
  preferredFootprints: string[];
  preferredSuppliers: string[];
  traceWidthsMm: Record<string, number>;
  /** Optional global scalar minima for the read-only PCB Rule Lens. These are authored requirements, not fab validation. */
  pcbScalarMinimums?: PcbScalarMinimums;
  naming: Record<string, string>;
  reusableBlocks: string[];
}

export interface PcbScalarMinimums {
  minTraceWidthMm?: number;
  minViaHoleDiameterMm?: number;
  minViaPadDiameterMm?: number;
  minBoardEdgeClearanceMm?: number;
  minPadToPadEdgeClearanceMm?: number;
  minPlatedHoleAnnularRingMm?: number;
}

export interface ProjectGuidance {
  schemaVersion: 1;
  requirements: ProjectRequirements;
  rules: ProjectRules;
}

export interface ProjectGuidanceSummary {
  powerSources: number;
  interfaces: number;
  connectors: number;
  environmentConstraints: number;
  preferredFootprints: number;
  preferredSuppliers: number;
  traceClasses: number;
  reusableBlocks: number;
}

/** Parse the versioned local JSON contract shared by the agent and advisor. */
export function parseProjectGuidance(content: string): ProjectGuidance {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Project guidance is not valid JSON: ${message(error)}`);
  }
  if (!isRecord(value)) throw new Error('Project guidance must be a JSON object.');
  if (value.schemaVersion !== PROJECT_GUIDANCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported project guidance schemaVersion. Expected ${PROJECT_GUIDANCE_SCHEMA_VERSION}.`);
  }
  const requirements = record(value.requirements, 'requirements');
  const rules = record(value.rules, 'rules');
  const board = rulesOrUndefined(requirements.board, 'requirements.board');
  return {
    schemaVersion: 1,
    requirements: {
      powerSources: strings(requirements.powerSources, 'requirements.powerSources'),
      interfaces: strings(requirements.interfaces, 'requirements.interfaces'),
      connectors: strings(requirements.connectors, 'requirements.connectors'),
      environment: strings(requirements.environment, 'requirements.environment'),
      ...(optionalPositive(requirements.quantity, 'requirements.quantity') != null
        ? { quantity: optionalPositive(requirements.quantity, 'requirements.quantity') }
        : {}),
      ...(optionalString(requirements.assemblyPreference, 'requirements.assemblyPreference')
        ? { assemblyPreference: optionalString(requirements.assemblyPreference, 'requirements.assemblyPreference') }
        : {}),
      ...(optionalString(requirements.targetFab, 'requirements.targetFab')
        ? { targetFab: optionalString(requirements.targetFab, 'requirements.targetFab') }
        : {}),
      ...(board ? {
        board: {
          ...(optionalPositive(board.maxWidthMm, 'requirements.board.maxWidthMm') != null
            ? { maxWidthMm: optionalPositive(board.maxWidthMm, 'requirements.board.maxWidthMm') }
            : {}),
          ...(optionalPositive(board.maxHeightMm, 'requirements.board.maxHeightMm') != null
            ? { maxHeightMm: optionalPositive(board.maxHeightMm, 'requirements.board.maxHeightMm') }
            : {}),
        },
      } : {}),
    },
    rules: {
      preferredFootprints: strings(rules.preferredFootprints, 'rules.preferredFootprints'),
      preferredSuppliers: strings(rules.preferredSuppliers, 'rules.preferredSuppliers'),
      traceWidthsMm: numberRecord(rules.traceWidthsMm, 'rules.traceWidthsMm'),
      ...(rules.pcbScalarMinimums == null
        ? {}
        : { pcbScalarMinimums: pcbScalarMinimums(rules.pcbScalarMinimums) }),
      naming: stringRecord(rules.naming, 'rules.naming'),
      reusableBlocks: strings(rules.reusableBlocks, 'rules.reusableBlocks'),
    },
  };
}

function pcbScalarMinimums(value: unknown): PcbScalarMinimums {
  const input = record(value, 'rules.pcbScalarMinimums');
  const allowed = new Set(['minTraceWidthMm', 'minViaHoleDiameterMm', 'minViaPadDiameterMm', 'minBoardEdgeClearanceMm', 'minPadToPadEdgeClearanceMm', 'minPlatedHoleAnnularRingMm']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`rules.pcbScalarMinimums contains unsupported field(s): ${unknown.sort().join(', ')}.`);
  const minTraceWidthMm = scalarMinimum(input.minTraceWidthMm, 'rules.pcbScalarMinimums.minTraceWidthMm');
  const minViaHoleDiameterMm = scalarMinimum(input.minViaHoleDiameterMm, 'rules.pcbScalarMinimums.minViaHoleDiameterMm');
  const minViaPadDiameterMm = scalarMinimum(input.minViaPadDiameterMm, 'rules.pcbScalarMinimums.minViaPadDiameterMm');
  const minBoardEdgeClearanceMm = scalarMinimum(input.minBoardEdgeClearanceMm, 'rules.pcbScalarMinimums.minBoardEdgeClearanceMm');
  const minPadToPadEdgeClearanceMm = scalarMinimum(input.minPadToPadEdgeClearanceMm, 'rules.pcbScalarMinimums.minPadToPadEdgeClearanceMm');
  const minPlatedHoleAnnularRingMm = scalarMinimum(input.minPlatedHoleAnnularRingMm, 'rules.pcbScalarMinimums.minPlatedHoleAnnularRingMm');
  const result: PcbScalarMinimums = {
    ...(minTraceWidthMm == null
      ? {}
      : { minTraceWidthMm }),
    ...(minViaHoleDiameterMm == null
      ? {}
      : { minViaHoleDiameterMm }),
    ...(minViaPadDiameterMm == null
      ? {}
      : { minViaPadDiameterMm }),
    ...(minBoardEdgeClearanceMm == null
      ? {}
      : { minBoardEdgeClearanceMm }),
    ...(minPadToPadEdgeClearanceMm == null
      ? {}
      : { minPadToPadEdgeClearanceMm }),
    ...(minPlatedHoleAnnularRingMm == null
      ? {}
      : { minPlatedHoleAnnularRingMm }),
  };
  if (!Object.keys(result).length) throw new Error('rules.pcbScalarMinimums must declare at least one supported minimum.');
  return result;
}

function scalarMinimum(value: unknown, path: string): number | undefined {
  const parsed = optionalPositive(value, path);
  if (parsed != null && parsed > 25) throw new Error(`${path} must be no greater than 25 mm.`);
  return parsed;
}

export function summarizeProjectGuidance(guidance: ProjectGuidance): ProjectGuidanceSummary {
  return {
    powerSources: guidance.requirements.powerSources.length,
    interfaces: guidance.requirements.interfaces.length,
    connectors: guidance.requirements.connectors.length,
    environmentConstraints: guidance.requirements.environment.length,
    preferredFootprints: guidance.rules.preferredFootprints.length,
    preferredSuppliers: guidance.rules.preferredSuppliers.length,
    traceClasses: Object.keys(guidance.rules.traceWidthsMm).length,
    reusableBlocks: guidance.rules.reusableBlocks.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function rulesOrUndefined(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  return record(value, path);
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${path} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function optionalPositive(value: unknown, path: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number.`);
  }
  return value;
}

function numberRecord(value: unknown, path: string): Record<string, number> {
  const input = record(value, path);
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!key.trim() || typeof item !== 'number' || !Number.isFinite(item) || item <= 0) {
      throw new Error(`${path}.${key || '(empty)'} must be a positive number.`);
    }
    output[key.trim()] = item;
  }
  return output;
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const input = record(value, path);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!key.trim() || typeof item !== 'string' || !item.trim()) {
      throw new Error(`${path}.${key || '(empty)'} must be a non-empty string.`);
    }
    output[key.trim()] = item.trim();
  }
  return output;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
