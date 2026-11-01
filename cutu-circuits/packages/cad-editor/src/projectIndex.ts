import yaml from 'js-yaml';
import type { ExtensionFileSystemService } from '@cutucircuits/editor-host';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from './pathUtils';
import { PROJECT_CONFIG_PATH } from './utils';
import type {
  ParamKind,
  ReplicadConventions,
  ReplicadModuleEntry,
  ReplicadParamSummary,
  ReplicadProjectGraph,
} from './types';

const DEFAULT_CONVENTIONS: ReplicadConventions = { roots: [], libraries: [], notes: [] };
const SKIP_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);
const MODEL_GLOB = '**/*.replicad.ts';
const STEP_GLOBS = ['**/*.step', '**/*.stp', '**/*.STEP', '**/*.STP'];
// Project font overrides ship as base64 sidecars (the SDK filesystem reader is
// text-only and cannot return raw binary fonts). See scripts/encode-font.mjs.
const FONT_GLOBS = ['**/*.ttf.b64', '**/*.otf.b64', '**/*.TTF.b64', '**/*.OTF.b64'];

function isProjectFile(filePath: string): boolean {
  return !filePath.split('/').some((segment) => SKIP_SEGMENTS.has(segment));
}

function extractFileDocumentation(content: string): string | undefined {
  const docs: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (docs.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('//')) {
      docs.push(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      docs.push(trimmed.replace(/^\/\*+\s?/, '').replace(/^\*+\s?/, '').replace(/\*+\/$/, ''));
      continue;
    }
    break;
  }
  const text = docs.join(' ').trim();
  return text.length > 0 ? text : undefined;
}

function detectIsModel(content: string): boolean {
  return (
    /export\s+default\b/.test(content) ||
    /export\s+(async\s+)?function\s+main\b/.test(content) ||
    /export\s+const\s+main\b/.test(content)
  );
}

// Coarse parameter surface for the project graph. The authoritative param list
// (with kinds, bounds, groups) comes from the worker on compile; this is only a
// quick hint for navigation, so a best-effort scan of the defaultParams literal
// is enough.
function parseParamSummaries(content: string): ReplicadParamSummary[] {
  const match = content.match(/(?:export\s+const\s+)?defaultParams\s*(?::[^=]+)?=\s*\{/);
  if (!match) return [];
  const start = content.indexOf('{', match.index ?? 0);
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < content.length; i += 1) {
    const char = content[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const body = content.slice(start + 1, end);
  const summaries: ReplicadParamSummary[] = [];
  const entryRegex = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*([^,{}]+)/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRegex.exec(body)) !== null) {
    const name = entry[1];
    const rawValue = entry[2].trim();
    summaries.push({ name, kind: inferKindFromLiteral(rawValue), default: literalToValue(rawValue) });
  }
  return summaries;
}

function inferKindFromLiteral(raw: string): ParamKind {
  if (/^(true|false)$/.test(raw)) return 'boolean';
  if (/^-?\d/.test(raw)) return 'number';
  if (/^\[/.test(raw)) return 'vector';
  return 'string';
}

function literalToValue(raw: string): ReplicadParamSummary['default'] {
  if (/^(true|false)$/.test(raw)) return raw === 'true';
  if (/^-?\d/.test(raw)) return Number.parseFloat(raw);
  return raw.replace(/^['"`]|['"`]$/g, '');
}

function parseImports(filePath: string, content: string, modelPaths: Set<string>): { resolved: string[]; unresolved: string[] } {
  const fileDir = dirname(filePath);
  const importRegex = /\bimport\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const resolved: string[] = [];
  const unresolved: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const target = match[1];
    if (target === 'replicad' || !target.startsWith('.')) continue; // external module
    const base = normalize(resolve(fileDir, target));
    const candidates = [
      base,
      `${base}.replicad.ts`,
      `${base}.ts`,
      normalize(resolve(base, 'index.ts')),
    ];
    const hit = candidates.find((candidate) => modelPaths.has(candidate));
    if (hit) resolved.push(hit);
    else unresolved.push(target);
  }
  return { resolved, unresolved };
}

export async function readConventions(
  filesystem: ExtensionFileSystemService,
  workspacePath: string
): Promise<ReplicadConventions> {
  const configFilePath = normalize(resolve(workspacePath, PROJECT_CONFIG_PATH));
  if (!(await filesystem.fileExists(configFilePath))) return DEFAULT_CONVENTIONS;
  try {
    const raw = await filesystem.readFile(configFilePath);
    const parsed = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
    const bed = parsed.printerBed;
    return {
      roots: asStringArray(parsed.roots),
      units: typeof parsed.units === 'string' ? parsed.units : undefined,
      defaultTolerance: typeof parsed.defaultTolerance === 'number' ? parsed.defaultTolerance : undefined,
      libraries: asStringArray(parsed.libraries),
      material: typeof parsed.material === 'string' ? parsed.material : undefined,
      printerNozzle: typeof parsed.printerNozzle === 'number' ? parsed.printerNozzle : undefined,
      printerBed:
        Array.isArray(bed) && bed.length === 2 && bed.every((v) => typeof v === 'number')
          ? [bed[0] as number, bed[1] as number]
          : undefined,
      notes: asStringArray(parsed.notes),
      raw: parsed,
    };
  } catch {
    return DEFAULT_CONVENTIONS;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface BuildProjectGraphOptions {
  activeFileOverride?: { filePath: string; content: string };
}

export interface ProjectGraphResult {
  graph: ReplicadProjectGraph;
  conventions: ReplicadConventions;
  fileContents: Map<string, string>;
}

function prioritizeRoots(files: string[]): string[] {
  return [...files].sort((left, right) => {
    const score = (path: string) =>
      (/(assembly|main|model|part|enclosure|bracket)/i.test(basename(path)) ? 1 : 0) +
      (path.includes('/models/') ? 1 : 0);
    return score(right) - score(left) || left.localeCompare(right);
  });
}

export async function buildProjectGraph(
  filesystem: ExtensionFileSystemService,
  workspacePath: string,
  options: BuildProjectGraphOptions = {}
): Promise<ProjectGraphResult> {
  const conventions = await readConventions(filesystem, workspacePath);

  const modelPaths = (await filesystem.findFiles(MODEL_GLOB))
    .map(normalize)
    .filter(isProjectFile)
    .filter((filePath) => filePath.startsWith(workspacePath));
  const modelPathSet = new Set(modelPaths);

  const fileContents = new Map<string, string>();
  for (const filePath of modelPaths) {
    if (options.activeFileOverride?.filePath === filePath) {
      fileContents.set(filePath, options.activeFileOverride.content);
      continue;
    }
    fileContents.set(filePath, await filesystem.readFile(filePath));
  }

  const files: ReplicadModuleEntry[] = [];
  const unresolvedImports: ReplicadProjectGraph['unresolvedImports'] = [];
  const incoming = new Map<string, number>();

  for (const filePath of modelPaths) {
    const content = fileContents.get(filePath) ?? '';
    const { resolved, unresolved } = parseImports(filePath, content, modelPathSet);
    for (const target of resolved) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    for (const rawTarget of unresolved) unresolvedImports.push({ source: filePath, rawTarget });
    files.push({
      path: filePath,
      relativePath: relative(workspacePath, filePath),
      imports: resolved,
      isModel: detectIsModel(content),
      params: parseParamSummaries(content),
      documentation: extractFileDocumentation(content),
    });
  }

  const stepAssets: string[] = [];
  for (const glob of STEP_GLOBS) {
    const found = (await filesystem.findFiles(glob))
      .map(normalize)
      .filter(isProjectFile)
      .filter((filePath) => filePath.startsWith(workspacePath));
    stepAssets.push(...found);
  }

  const fontAssets: string[] = [];
  for (const glob of FONT_GLOBS) {
    const found = (await filesystem.findFiles(glob))
      .map(normalize)
      .filter(isProjectFile)
      .filter((filePath) => filePath.startsWith(workspacePath));
    fontAssets.push(...found);
  }

  const configuredRoots = conventions.roots
    .map((root) => (isAbsolute(root) ? normalize(root) : normalize(resolve(workspacePath, root))))
    .filter((root) => modelPathSet.has(root));

  const runnableModels = files.filter((file) => file.isModel).map((file) => file.path);
  const topLevelModels = runnableModels.filter((filePath) => (incoming.get(filePath) ?? 0) === 0);
  const discovered = prioritizeRoots(topLevelModels.length > 0 ? topLevelModels : runnableModels);
  const roots = [...new Set([...configuredRoots, ...discovered])];

  return {
    conventions,
    fileContents,
    graph: {
      workspacePath,
      files,
      roots,
      stepAssets: [...new Set(stepAssets)],
      fontAssets: [...new Set(fontAssets)],
      unresolvedImports,
    },
  };
}

export function resolvePreferredRoot(
  graph: ReplicadProjectGraph,
  activeFilePath?: string | null,
  preferredRoot?: string | null
): string | null {
  const roots = graph.roots;
  if (roots.length === 0) return null;
  if (preferredRoot && roots.includes(preferredRoot)) return preferredRoot;
  if (activeFilePath && roots.includes(activeFilePath)) return activeFilePath;
  // If the active file is a non-root module, prefer a root that imports it.
  if (activeFilePath) {
    const importer = graph.files.find((file) => roots.includes(file.path) && file.imports.includes(activeFilePath));
    if (importer) return importer.path;
  }
  return roots[0];
}
