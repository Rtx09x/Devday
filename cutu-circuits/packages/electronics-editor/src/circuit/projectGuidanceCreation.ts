import { sha256Text, type TextFileSystem } from './artifactFreshness.ts';
import { validateCanonicalWorkspaceRelativePath } from './designReviewPacket.ts';
import {
  parseProjectGuidance,
  summarizeProjectGuidance,
  type ProjectGuidance,
  type ProjectGuidanceSummary,
} from './projectGuidance.ts';

export const PROJECT_GUIDANCE_FILE_NAME = 'electronics.project.json';
export const MAX_PROJECT_GUIDANCE_LIST_ITEMS = 24;
export const MAX_PROJECT_GUIDANCE_RECORD_ITEMS = 24;
export const MAX_PROJECT_GUIDANCE_FIELD_BYTES = 160;

export interface ProjectGuidanceCreationInput {
  outputPath: unknown;
  requirements: unknown;
  rules: unknown;
}

export interface ValidatedProjectGuidanceCreation {
  outputPath: string;
  guidance: ProjectGuidance;
}

export interface ProjectGuidanceCreationResult {
  status: 'created' | 'refused' | 'incomplete';
  output_path: string;
  guidance_sha256?: string;
  summary?: ProjectGuidanceSummary;
  autoLoaded: false;
  contentMatchedAfterWrite: boolean;
  stableAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${path} contains unsupported field(s): ${unknown.sort().join(', ')}.`);
}

function exactText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  if (value !== value.trim()) throw new Error(`${path} must not contain leading or trailing whitespace.`);
  if (/\p{Cc}|\p{Cf}|\r|\n|\u2028|\u2029/u.test(value)) {
    throw new Error(`${path} must not contain control, format, or line-separator characters.`);
  }
  if (textEncoder.encode(value).length > MAX_PROJECT_GUIDANCE_FIELD_BYTES) {
    throw new Error(`${path} must be at most ${MAX_PROJECT_GUIDANCE_FIELD_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function exactList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an explicitly supplied array.`);
  if (value.length > MAX_PROJECT_GUIDANCE_LIST_ITEMS) {
    throw new Error(`${path} may contain at most ${MAX_PROJECT_GUIDANCE_LIST_ITEMS} items.`);
  }
  const result = value.map((item, index) => exactText(item, `${path}[${index}]`));
  const duplicates = result.filter((item, index) => result.indexOf(item) !== index);
  if (duplicates.length) throw new Error(`${path} contains duplicate value ${JSON.stringify(duplicates[0])}.`);
  return result;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value == null ? undefined : exactText(value, path);
}

function optionalPositiveNumber(value: unknown, path: string, maximum: number): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${path} must be a finite positive number no greater than ${maximum}.`);
  }
  return value;
}

function optionalQuantity(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100_000) {
    throw new Error('requirements.quantity must be an integer from 1 through 100000.');
  }
  return value as number;
}

function exactNumberEntries(value: unknown, path: string): Record<string, number> {
  if (!Array.isArray(value)) throw new Error(`${path} must be an explicitly supplied array of name/value entries.`);
  if (value.length > MAX_PROJECT_GUIDANCE_RECORD_ITEMS) {
    throw new Error(`${path} may contain at most ${MAX_PROJECT_GUIDANCE_RECORD_ITEMS} entries.`);
  }
  const output: Record<string, number> = {};
  for (let index = 0; index < value.length; index += 1) {
    const entry = requireRecord(value[index], `${path}[${index}]`);
    rejectUnknownKeys(entry, ['name', 'widthMm'], `${path}[${index}]`);
    const name = exactText(entry.name, `${path}[${index}].name`);
    if (Object.prototype.hasOwnProperty.call(output, name)) throw new Error(`${path} contains duplicate name ${JSON.stringify(name)}.`);
    const width = optionalPositiveNumber(entry.widthMm, `${path}[${index}].widthMm`, 25);
    if (width == null) throw new Error(`${path}[${index}].widthMm is required.`);
    output[name] = width;
  }
  return output;
}

function exactStringEntries(value: unknown, path: string): Record<string, string> {
  if (!Array.isArray(value)) throw new Error(`${path} must be an explicitly supplied array of category/prefix entries.`);
  if (value.length > MAX_PROJECT_GUIDANCE_RECORD_ITEMS) {
    throw new Error(`${path} may contain at most ${MAX_PROJECT_GUIDANCE_RECORD_ITEMS} entries.`);
  }
  const output: Record<string, string> = {};
  for (let index = 0; index < value.length; index += 1) {
    const entry = requireRecord(value[index], `${path}[${index}]`);
    rejectUnknownKeys(entry, ['category', 'prefix'], `${path}[${index}]`);
    const category = exactText(entry.category, `${path}[${index}].category`);
    if (Object.prototype.hasOwnProperty.call(output, category)) throw new Error(`${path} contains duplicate category ${JSON.stringify(category)}.`);
    output[category] = exactText(entry.prefix, `${path}[${index}].prefix`);
  }
  return output;
}

export function validateProjectGuidanceCreation(input: ProjectGuidanceCreationInput): ValidatedProjectGuidanceCreation {
  const outputPath = validateCanonicalWorkspaceRelativePath(input.outputPath, 'output_path', PROJECT_GUIDANCE_FILE_NAME);
  if (outputPath !== PROJECT_GUIDANCE_FILE_NAME && !outputPath.endsWith(`/${PROJECT_GUIDANCE_FILE_NAME}`)) {
    throw new Error(`output_path basename must be exactly ${PROJECT_GUIDANCE_FILE_NAME}.`);
  }
  const requirements = requireRecord(input.requirements, 'requirements');
  const rules = requireRecord(input.rules, 'rules');
  rejectUnknownKeys(requirements, [
    'powerSources', 'interfaces', 'connectors', 'environment', 'quantity',
    'assemblyPreference', 'targetFab', 'board',
  ], 'requirements');
  rejectUnknownKeys(rules, [
    'preferredFootprints', 'preferredSuppliers', 'traceWidths', 'pcbScalarMinimums', 'naming', 'reusableBlocks',
  ], 'rules');

  const boardInput = requirements.board == null ? undefined : requireRecord(requirements.board, 'requirements.board');
  if (boardInput) rejectUnknownKeys(boardInput, ['maxWidthMm', 'maxHeightMm'], 'requirements.board');
  const quantity = optionalQuantity(requirements.quantity);
  const assemblyPreference = optionalText(requirements.assemblyPreference, 'requirements.assemblyPreference');
  const targetFab = optionalText(requirements.targetFab, 'requirements.targetFab');
  const maxWidthMm = boardInput ? optionalPositiveNumber(boardInput.maxWidthMm, 'requirements.board.maxWidthMm', 10_000) : undefined;
  const maxHeightMm = boardInput ? optionalPositiveNumber(boardInput.maxHeightMm, 'requirements.board.maxHeightMm', 10_000) : undefined;
  const scalarInput = rules.pcbScalarMinimums == null ? undefined : requireRecord(rules.pcbScalarMinimums, 'rules.pcbScalarMinimums');
  if (scalarInput) rejectUnknownKeys(scalarInput, ['minTraceWidthMm', 'minViaHoleDiameterMm', 'minViaPadDiameterMm', 'minBoardEdgeClearanceMm', 'minPadToPadEdgeClearanceMm', 'minPlatedHoleAnnularRingMm'], 'rules.pcbScalarMinimums');
  const minTraceWidthMm = scalarInput ? optionalPositiveNumber(scalarInput.minTraceWidthMm, 'rules.pcbScalarMinimums.minTraceWidthMm', 25) : undefined;
  const minViaHoleDiameterMm = scalarInput ? optionalPositiveNumber(scalarInput.minViaHoleDiameterMm, 'rules.pcbScalarMinimums.minViaHoleDiameterMm', 25) : undefined;
  const minViaPadDiameterMm = scalarInput ? optionalPositiveNumber(scalarInput.minViaPadDiameterMm, 'rules.pcbScalarMinimums.minViaPadDiameterMm', 25) : undefined;
  const minBoardEdgeClearanceMm = scalarInput ? optionalPositiveNumber(scalarInput.minBoardEdgeClearanceMm, 'rules.pcbScalarMinimums.minBoardEdgeClearanceMm', 25) : undefined;
  const minPadToPadEdgeClearanceMm = scalarInput ? optionalPositiveNumber(scalarInput.minPadToPadEdgeClearanceMm, 'rules.pcbScalarMinimums.minPadToPadEdgeClearanceMm', 25) : undefined;
  const minPlatedHoleAnnularRingMm = scalarInput ? optionalPositiveNumber(scalarInput.minPlatedHoleAnnularRingMm, 'rules.pcbScalarMinimums.minPlatedHoleAnnularRingMm', 25) : undefined;
  if (scalarInput && minTraceWidthMm == null && minViaHoleDiameterMm == null && minViaPadDiameterMm == null && minBoardEdgeClearanceMm == null && minPadToPadEdgeClearanceMm == null && minPlatedHoleAnnularRingMm == null) {
    throw new Error('rules.pcbScalarMinimums must explicitly declare at least one supported minimum.');
  }

  const guidance: ProjectGuidance = {
    schemaVersion: 1,
    requirements: {
      powerSources: exactList(requirements.powerSources, 'requirements.powerSources'),
      interfaces: exactList(requirements.interfaces, 'requirements.interfaces'),
      connectors: exactList(requirements.connectors, 'requirements.connectors'),
      environment: exactList(requirements.environment, 'requirements.environment'),
      ...(quantity == null ? {} : { quantity }),
      ...(assemblyPreference == null ? {} : { assemblyPreference }),
      ...(targetFab == null ? {} : { targetFab }),
      ...(boardInput == null ? {} : {
        board: {
          ...(maxWidthMm == null ? {} : { maxWidthMm }),
          ...(maxHeightMm == null ? {} : { maxHeightMm }),
        },
      }),
    },
    rules: {
      preferredFootprints: exactList(rules.preferredFootprints, 'rules.preferredFootprints'),
      preferredSuppliers: exactList(rules.preferredSuppliers, 'rules.preferredSuppliers'),
      traceWidthsMm: exactNumberEntries(rules.traceWidths, 'rules.traceWidths'),
      ...(scalarInput == null ? {} : {
        pcbScalarMinimums: {
          ...(minTraceWidthMm == null ? {} : { minTraceWidthMm }),
          ...(minViaHoleDiameterMm == null ? {} : { minViaHoleDiameterMm }),
          ...(minViaPadDiameterMm == null ? {} : { minViaPadDiameterMm }),
          ...(minBoardEdgeClearanceMm == null ? {} : { minBoardEdgeClearanceMm }),
          ...(minPadToPadEdgeClearanceMm == null ? {} : { minPadToPadEdgeClearanceMm }),
          ...(minPlatedHoleAnnularRingMm == null ? {} : { minPlatedHoleAnnularRingMm }),
        },
      }),
      naming: exactStringEntries(rules.naming, 'rules.naming'),
      reusableBlocks: exactList(rules.reusableBlocks, 'rules.reusableBlocks'),
    },
  };
  parseProjectGuidance(JSON.stringify(guidance));
  return { outputPath, guidance };
}

export function serializeProjectGuidance(guidance: ProjectGuidance): string {
  return `${JSON.stringify(guidance, null, 2)}\n`;
}

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentRelativePath(relativePath: string): string | undefined {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? undefined : relativePath.slice(0, slash);
}

function baseResult(outputPath: string): Omit<ProjectGuidanceCreationResult, 'status'> {
  return {
    output_path: outputPath,
    autoLoaded: false,
    contentMatchedAfterWrite: false,
    stableAtReturn: 'not-guaranteed',
    nonAtomicNoClobber: true,
    symlinkConfinement: 'unproven',
  };
}

export async function createProjectGuidanceFile(options: {
  workspacePath: string | undefined;
  filesystem: TextFileSystem;
  input: ProjectGuidanceCreationInput;
}): Promise<ProjectGuidanceCreationResult> {
  let validated: ValidatedProjectGuidanceCreation;
  try {
    if (!options.workspacePath?.trim()) throw new Error('A mounted workspace path is required; no file was created.');
    validated = validateProjectGuidanceCreation(options.input);
  } catch (error) {
    const output = typeof options.input.outputPath === 'string' ? options.input.outputPath : '';
    return {
      status: 'refused',
      ...baseResult(output),
      refusal: { code: 'invalid-input', message: error instanceof Error ? error.message : String(error) },
    };
  }
  const { outputPath, guidance } = validated;
  const resultBase = baseResult(outputPath);
  const absoluteOutput = joinWorkspace(options.workspacePath!, outputPath);
  const relativeParent = parentRelativePath(outputPath);
  const absoluteParent = relativeParent ? joinWorkspace(options.workspacePath!, relativeParent) : options.workspacePath!;
  try {
    if (!(await options.filesystem.fileExists(absoluteParent))) {
      return {
        status: 'refused',
        ...resultBase,
        refusal: { code: 'parent-missing', message: `Parent path does not exist: ${relativeParent ?? '.'}. Create it explicitly, then retry.` },
      };
    }
    if (await options.filesystem.fileExists(absoluteOutput)) {
      return {
        status: 'refused',
        ...resultBase,
        refusal: { code: 'output-exists', message: `${outputPath} already exists. This tool never overwrites project guidance.` },
      };
    }
    const text = serializeProjectGuidance(guidance);
    if (await options.filesystem.fileExists(absoluteOutput)) {
      return {
        status: 'refused',
        ...resultBase,
        refusal: { code: 'output-exists', message: `${outputPath} appeared before the write. No intentional overwrite was performed.` },
      };
    }
    try {
      await options.filesystem.writeFile(absoluteOutput, text);
    } catch (error) {
      return {
        status: 'incomplete',
        ...resultBase,
        cleanup: { automatic: false, pathsThatMayExist: [outputPath] },
        refusal: { code: 'write-failed', message: `The write failed and this filesystem API cannot roll it back: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
    let observed: string;
    try {
      observed = await options.filesystem.readFile(absoluteOutput);
    } catch (error) {
      return {
        status: 'incomplete',
        ...resultBase,
        cleanup: { automatic: false, pathsThatMayExist: [outputPath] },
        refusal: { code: 'readback-failed', message: `The file may exist, but exact readback failed: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
    if (observed !== text) {
      return {
        status: 'incomplete',
        ...resultBase,
        cleanup: { automatic: false, pathsThatMayExist: [outputPath] },
        refusal: { code: 'readback-mismatch', message: 'The file may exist, but its readback did not match the exact generated bytes.' },
      };
    }
    return {
      status: 'created',
      ...resultBase,
      guidance_sha256: await sha256Text(text),
      summary: summarizeProjectGuidance(guidance),
      contentMatchedAfterWrite: true,
    };
  } catch (error) {
    return {
      status: 'refused',
      ...resultBase,
      refusal: { code: 'filesystem-error', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
