import type { ElectronicsEditorAPI } from '../editorApi.ts';
import { buildBomBundle } from './bom.ts';
import {
  writeTrackedExport,
  type TextFileSystem,
} from './artifactFreshness.ts';
import { validateCanonicalWorkspaceRelativePath } from './designReviewPacket.ts';

export const STRICT_ASSEMBLY_EXPORT_TEMPLATE = 'jlcpcb-bom-cpl' as const;

export interface StrictAssemblyExportResult {
  status: 'created' | 'refused' | 'incomplete';
  bom_path: string;
  cpl_path: string;
  manifest_path: string;
  sourceStableBeforeBom: boolean;
  sourceStableBeforeCpl: boolean;
  sourceStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  summary?: {
    total: number;
    ready: number;
    blocked: number;
    lineItems: number;
  };
  source_sha256?: string;
  circuit_json_sha256?: string;
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
}

function baseResult(bomPath: string, cplPath: string, manifestPath: string): Omit<StrictAssemblyExportResult, 'status'> {
  return {
    bom_path: bomPath,
    cpl_path: cplPath,
    manifest_path: manifestPath,
    sourceStableBeforeBom: false,
    sourceStableBeforeCpl: false,
    sourceStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed',
    nonAtomicNoClobber: true,
    symlinkConfinement: 'unproven',
  };
}

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function displayPath(path: string, workspacePath: string): string {
  const prefix = `${workspacePath.replace(/\/$/, '')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function issueSummary(parts: Array<{ ref: string; issues: Array<{ code: string }> }>): string {
  return parts
    .map((part) => `${part.ref} (${part.issues.map((issue) => issue.code).join(', ')})`)
    .join('; ');
}

export async function createStrictAssemblyExport(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot' | 'authorizeAssemblyHandoffExport'>;
  fs: TextFileSystem;
  workspacePath: string;
  bomPath: unknown;
  cplPath: unknown;
  manifestPath: unknown;
}): Promise<StrictAssemblyExportResult> {
  let bomRelative = typeof input.bomPath === 'string' ? input.bomPath : '';
  let cplRelative = typeof input.cplPath === 'string' ? input.cplPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  const refuse = (code: string, message: string, extra: Partial<StrictAssemblyExportResult> = {}): StrictAssemblyExportResult => ({
    ...baseResult(bomRelative, cplRelative, manifestRelative),
    ...extra,
    status: 'refused',
    refusal: { code, message },
  });

  if (typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) {
    return refuse('workspace-unavailable', 'A workspace must be open before creating a workspace-local assembly handoff.');
  }

  try {
    bomRelative = validateCanonicalWorkspaceRelativePath(input.bomPath, 'bom_path', '.bom.csv');
    cplRelative = validateCanonicalWorkspaceRelativePath(input.cplPath, 'cpl_path', '.cpl.csv');
    manifestRelative = validateCanonicalWorkspaceRelativePath(input.manifestPath, 'manifest_path', '.freshness.json');
    const relativeKeys = [bomRelative, cplRelative, manifestRelative].map((path) => path.toLocaleLowerCase('en-US'));
    if (new Set(relativeKeys).size !== relativeKeys.length) {
      return refuse('path-collision', 'BOM, CPL, and completed-manifest paths must be distinct and non-colliding.');
    }

    input.api.authorizeAssemblyHandoffExport();
    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return refuse('snapshot-failed', `The copied editor source failed evaluation: ${snapshot.evalError}`);
    if (input.api.getCode() !== snapshot.source) return refuse('source-changed-before-write', 'The editor-buffer source changed before any intentional write.');

    const bundle = await buildBomBundle(snapshot.circuitJson, 'strict-assembly-handoff', 'jlcpcb');
    const report = bundle.assemblyHandoff;
    if (!report || report.summary.total === 0) {
      return refuse('no-placed-parts', 'The installed assembly template found no placed source parts. No files were written.');
    }
    const summary = {
      total: report.summary.total,
      ready: report.summary.ready,
      blocked: report.summary.blocked,
      lineItems: bundle.lineItems,
    };
    if (report.summary.blocked > 0) {
      const blocked = report.parts.filter((part) => !part.readyForTemplate);
      return refuse(
        'assembly-blockers',
        `The installed assembly template has ${report.summary.blocked} blocked part(s): ${issueSummary(blocked)}. No partial BOM/CPL files were written.`,
        { summary },
      );
    }
    const bomText = bundle.files['strict-assembly-handoff-bom-jlcpcb.csv'];
    const cplText = bundle.files['strict-assembly-handoff-cpl-jlcpcb.csv'];
    if (!bomText || !cplText || bundle.lineItems === 0) {
      return refuse('empty-output', 'The complete installed-template projection did not produce both non-empty BOM/CPL text artifacts. No files were written.', { summary });
    }

    const bomAbsolute = joinWorkspace(input.workspacePath, bomRelative);
    const cplAbsolute = joinWorkspace(input.workspacePath, cplRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const destinations = [bomAbsolute, cplAbsolute, manifestAbsolute];
    for (const parent of [...new Set(destinations.map(parentPath))]) {
      if (!(await input.fs.fileExists(parent))) {
        return refuse('parent-missing-or-unevidenced', `Every destination parent must already exist as far as fileExists can evidence: ${displayPath(parent, input.workspacePath)}`, { summary });
      }
    }
    for (const destination of destinations) {
      if (await input.fs.fileExists(destination)) {
        return refuse('path-exists', `Destination already exists and overwrite-anyway is unsupported: ${displayPath(destination, input.workspacePath)}`, { summary });
      }
    }
    if (input.api.getCode() !== snapshot.source) return refuse('source-changed-before-write', 'The editor-buffer source changed while the strict assembly handoff was assembled; no intentional write was attempted.', { summary });

    let stage: 'none' | 'bom' | 'cpl' | 'manifest' = 'none';
    let sourceStableBeforeBom = false;
    let sourceStableBeforeCpl = false;
    let sourceStableBeforeManifest = false;
    const guardedFs = {
      writeFile: async (path: string, text: string) => {
        const remaining = path === bomAbsolute
          ? [bomAbsolute, cplAbsolute, manifestAbsolute]
          : path === cplAbsolute
            ? [cplAbsolute, manifestAbsolute]
            : [manifestAbsolute];
        for (const destination of remaining) {
          if (await input.fs.fileExists(destination)) throw new Error(`Destination appeared after the non-atomic preflight and was not knowingly overwritten: ${displayPath(destination, input.workspacePath)}`);
        }
        const stable = input.api.getCode() === snapshot.source;
        if (path === bomAbsolute) sourceStableBeforeBom = stable;
        else if (path === cplAbsolute) sourceStableBeforeCpl = stable;
        else sourceStableBeforeManifest = stable;
        if (!stable) throw new Error(`The editor-buffer source changed immediately before ${path === bomAbsolute ? 'BOM' : path === cplAbsolute ? 'CPL' : 'completed-manifest'} write.`);
        stage = path === bomAbsolute ? 'bom' : path === cplAbsolute ? 'cpl' : 'manifest';
        await input.fs.writeFile(path, text);
      },
    };
    try {
      const tracked = await writeTrackedExport({
        fs: guardedFs,
        manifestPath: manifestAbsolute,
        source: snapshot.source,
        circuitJson: snapshot.circuitJson,
        kind: 'bom',
        options: {
          format: 'jlcpcb',
          template: STRICT_ASSEMBLY_EXPORT_TEMPLATE,
          requireComplete: true,
          sourceOrigin: snapshot.sourceOrigin,
          persistenceState: snapshot.persistenceState,
        },
        artifacts: [
          { path: bomAbsolute, text: bomText },
          { path: cplAbsolute, text: cplText },
        ],
        assertSourceCurrent: () => {
          if (input.api.getCode() !== snapshot.source) throw new Error('The editor-buffer source changed during strict assembly handoff emission.');
        },
      });
      return {
        ...baseResult(bomRelative, cplRelative, manifestRelative),
        status: 'created',
        summary,
        source_sha256: tracked.manifest.source.sha256,
        circuit_json_sha256: tracked.manifest.circuitJson.sha256,
        sourceStableBeforeBom,
        sourceStableBeforeCpl,
        sourceStableBeforeManifest,
      };
    } catch (error) {
      if (stage === 'none') return refuse('write-refused', error instanceof Error ? error.message : String(error), {
        summary, sourceStableBeforeBom, sourceStableBeforeCpl, sourceStableBeforeManifest,
      });
      const pathsThatMayExist = stage === 'bom'
        ? [bomRelative]
        : stage === 'cpl'
          ? [bomRelative, cplRelative]
          : [bomRelative, cplRelative, manifestRelative];
      return {
        ...baseResult(bomRelative, cplRelative, manifestRelative),
        status: 'incomplete',
        summary,
        sourceStableBeforeBom,
        sourceStableBeforeCpl,
        sourceStableBeforeManifest,
        cleanup: { automatic: false, pathsThatMayExist },
        refusal: { code: 'write-incomplete', message: error instanceof Error ? error.message : String(error) },
      };
    }
  } catch (error) {
    return refuse('path-invalid', error instanceof Error ? error.message : String(error));
  }
}
