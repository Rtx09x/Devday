import type { AIToolContext, ExtensionContext } from '@cutucircuits/editor-host';
import { analyzePrintability } from './printability';
import { mergeMeshes } from './geometry';
import { buildProjectGraph, resolvePreferredRoot } from './projectIndex';
import type { ProjectGraphResult } from './projectIndex';
import { compileReplicad, inspectStep } from './runtime/client';
import type { KernelEnvironment } from './runtime/client';
import { renderMeshMontage } from './renderViews';
import type { ModelSectionPlane } from './sectionPlane';
import { basename, dirname, join, normalize } from './pathUtils';
import { getErrorMessage } from './utils';
import type {
  CompileRequest,
  CompileResult,
  ExportFormat,
  ParamValues,
  ReplicadConventions,
  ReplicadEditorAPI,
  ReplicadMesh,
  StepAsset,
  FontAsset,
} from './types';

const EXPORT_FORMATS: ExportFormat[] = ['stl', 'step', '3mf', 'obj'];

function getWorkspacePath(context: AIToolContext): string {
  if (!context.workspacePath) {
    throw new Error('Replicad tools require an open workspace');
  }
  return context.workspacePath;
}

function toolFailure(action: string, error: unknown) {
  return { success: false, error: `Failed to ${action}: ${getErrorMessage(error)}` };
}

function summarizeMesh(mesh: ReplicadMesh) {
  return { vertexCount: mesh.vertices.length / 3, triangleCount: mesh.triangles.length / 3 };
}

function summarizeCompileResult(result: CompileResult) {
  return {
    success: result.success,
    filePath: result.filePath,
    renderTimeMs: Math.round(result.renderTimeMs),
    shapes: result.shapes.map((shape) => ({ name: shape.name, ...summarizeMesh(shape.mesh) })),
    params: result.params,
    stats: result.stats ?? null,
    diagnostics: result.diagnostics,
    warnings: result.warnings,
    errors: result.errors,
    exports: result.exports?.map((artifact) => ({
      format: artifact.format,
      extension: artifact.extension,
      byteLength: artifact.byteLength,
    })),
    animation: summarizeAnimation(result),
  };
}

function summarizeAnimation(result: CompileResult) {
  if (!result.animation) return null;
  const { fps, frames, durationMs, loop, tracks } = result.animation;
  return { fps, frames, durationMs, loop, animatedShapes: Object.keys(tracks) };
}

export function createAiTools(extensionContext: ExtensionContext) {
  const services = extensionContext.services;
  const environment: KernelEnvironment = {
    filesystem: services.filesystem,
    extensionPath: extensionContext.extensionPath,
  };

  // AI tools compile from disk, never from a hidden editor's in-memory buffer.
  // The agent edits *.replicad.ts directly on disk, so disk is the source of
  // truth; reading a retained hidden-editor buffer can serve stale content and
  // its save-on-dirty can flush that stale buffer back over the agent's write.
  // (Mirrors the OpenSCAD extension's disk-only stance; see NIM-905.)
  const prepareProject = async (context: AIToolContext): Promise<ProjectGraphResult> => {
    const workspacePath = getWorkspacePath(context);
    return buildProjectGraph(services.filesystem, workspacePath);
  };

  const collectStepAssets = async (project: ProjectGraphResult): Promise<StepAsset[]> => {
    const assets: StepAsset[] = [];
    for (const assetPath of project.graph.stepAssets) {
      try {
        const content = await services.filesystem.readFile(assetPath);
        assets.push({ name: basename(assetPath), content });
      } catch {
        // Skip unreadable assets; import_step surfaces specific failures.
      }
    }
    return assets;
  };

  const collectFontAssets = async (project: ProjectGraphResult): Promise<FontAsset[]> => {
    const fonts: FontAsset[] = [];
    for (const fontPath of project.graph.fontAssets) {
      try {
        const base64 = (await services.filesystem.readFile(fontPath)).trim();
        fonts.push({ name: basename(fontPath), base64 });
      } catch {
        // Skip unreadable font sidecars; the bundled default still applies.
      }
    }
    return fonts;
  };

  const conventionsToTolerances = (conventions: ReplicadConventions): { tolerance?: number } => ({
    tolerance: conventions.defaultTolerance,
  });

  const compileFromDisk = async (
    context: AIToolContext,
    options?: { rootFilePath?: string; params?: ParamValues; exports?: ExportFormat[] }
  ): Promise<{ rootFilePath: string; result: CompileResult; project: ProjectGraphResult }> => {
    const project = await prepareProject(context);
    const rootFilePath =
      options?.rootFilePath ?? resolvePreferredRoot(project.graph, context.activeFilePath);
    if (!rootFilePath) {
      throw new Error('No runnable .replicad.ts model found in this workspace.');
    }
    const source = await services.filesystem.readFile(rootFilePath);
    const stepAssets = await collectStepAssets(project);
    const fontAssets = await collectFontAssets(project);
    const request: CompileRequest = {
      source,
      filePath: rootFilePath,
      params: options?.params,
      stepAssets,
      fontAssets,
      exports: options?.exports,
      ...conventionsToTolerances(project.conventions),
    };
    const result = await compileReplicad(environment, request);
    return { rootFilePath, result, project };
  };

  return [
    {
      name: 'get_selection',
      access: { kind: 'editor-read' } as const,
      scope: 'editor' as const,
      editorFilePatterns: ['*.replicad.ts'],
      description:
        'Return the shape or B-rep face currently selected in the active Replicad 3D preview, including model-space click point, face measurements, and shape bounds.',
      parameters: { type: 'object' as const, properties: {} },
      handler: async (_params: Record<string, never>, context: AIToolContext) => {
        const editorAPI = context.editorAPI as ReplicadEditorAPI | undefined;
        if (!editorAPI || typeof editorAPI.getSelection !== 'function') {
          return {
            success: false,
            message: 'The Replicad editor is not mounted for this file. Open the *.replicad.ts model in the Replicad editor and try again.',
            error: 'Replicad editor API is unavailable.',
          };
        }
        const selection = editorAPI.getSelection();
        if (!selection) {
          return {
            success: true,
            message: 'No geometry is selected. Click a shape or face in the Replicad 3D preview, then call get_selection again.',
            data: null,
          };
        }
        return {
          success: true,
          message: selection.face
            ? `Selected ${selection.shapeName}, B-rep face ${selection.face.id}.`
            : `Selected shape ${selection.shapeName}.`,
          data: selection,
        };
      },
    },
    {
      name: 'get_project',
      access: { kind: 'filesystem' } as const,
      description:
        'Return the Replicad project model: *.replicad.ts modules, runnable roots, exposed parameters, discovered STEP assets, and workspace conventions.',
      parameters: { type: 'object' as const, properties: {} },
      handler: async (_params: Record<string, never>, context: AIToolContext) => {
        try {
          const project = await prepareProject(context);
          return {
            success: true,
            data: {
              roots: project.graph.roots,
              files: project.graph.files,
              stepAssets: project.graph.stepAssets,
              unresolvedImports: project.graph.unresolvedImports,
              conventions: project.conventions,
            },
          };
        } catch (error) {
          return toolFailure('build the Replicad project model', error);
        }
      },
    },
    {
      name: 'compile_preview',
      access: { kind: 'filesystem' } as const,
      description:
        'Compile a *.replicad.ts model (optionally with parameter overrides) and return diagnostics, resolved parameters, and geometry metrics. Mesh data is not returned in the tool output.',
      parameters: {
        type: 'object' as const,
        properties: {
          rootFilePath: { type: 'string' as const, description: 'Absolute path of the model to compile; omit to use the active/preferred root.' },
          params: { type: 'object' as const, additionalProperties: true, description: 'Parameter overrides merged over the script defaults.' },
        },
      },
      handler: async (
        params: { rootFilePath?: string; params?: ParamValues },
        context: AIToolContext
      ) => {
        try {
          const { result } = await compileFromDisk(context, {
            rootFilePath: params.rootFilePath,
            params: params.params,
          });
          return { success: result.success, data: summarizeCompileResult(result) };
        } catch (error) {
          return toolFailure('compile the Replicad model', error);
        }
      },
    },
    {
      name: 'inspect_model',
      access: { kind: 'filesystem' } as const,
      description:
        'The see-correct tool. Compiles the model, renders a multi-view montage (iso/top/front/right) the agent can look at, and returns geometry metrics plus a printability report (overhangs, bed fit, flat base, watertightness). Pass section { axis: "x" | "y" | "z", offsetMm?, flip? } for an open-cut model-space section; offset defaults to the model center on that axis and flip reverses the visible side. Use this to verify geometry matches intent.',
      parameters: {
        type: 'object' as const,
        properties: {
          rootFilePath: { type: 'string' as const },
          params: { type: 'object' as const, additionalProperties: true },
          includeImage: { type: 'boolean' as const, description: 'Render the multi-view montage (default true).' },
          section: {
            type: 'object' as const,
            description: 'Optional open-cut clipping plane in model-space millimeters. Without flip, coordinates at or above the offset remain visible.',
            properties: {
              axis: { type: 'string' as const, enum: ['x', 'y', 'z'], description: 'Model-space Z-up axis normal to the section plane.' },
              offsetMm: { type: 'number' as const, description: 'Plane offset in millimeters; defaults to the model center on the selected axis.' },
              flip: { type: 'boolean' as const, description: 'Reverse the clipping direction so coordinates at or below the offset remain visible.' },
            },
            required: ['axis'],
            additionalProperties: false,
          },
        },
      },
      handler: async (
        params: {
          rootFilePath?: string;
          params?: ParamValues;
          includeImage?: boolean;
          section?: ModelSectionPlane;
        },
        context: AIToolContext
      ) => {
        try {
          const { rootFilePath, result, project } = await compileFromDisk(context, {
            rootFilePath: params.rootFilePath,
            params: params.params,
          });
          if (!result.success) {
            return { success: false, data: summarizeCompileResult(result), error: result.errors[0] ?? 'Compile failed' };
          }

          const meshes: ReplicadMesh[] = result.shapes.map((shape) => shape.mesh);
          const merged = mergeMeshes(meshes);
          const printability = result.stats
            ? analyzePrintability(merged, result.stats, {
                bedMm: project.conventions.printerBed ?? null,
                nozzleMm: project.conventions.printerNozzle ?? null,
              })
            : null;

          let previewImage: string | null = null;
          if (params.includeImage !== false && typeof document !== 'undefined') {
            try {
              previewImage = await renderMeshMontage(meshes, { section: params.section });
            } catch (error) {
              previewImage = null;
              result.diagnostics.push({ level: 'warn', text: `Could not render preview: ${getErrorMessage(error)}` });
            }
          }

          return {
            success: true,
            data: {
              rootFilePath,
              stats: result.stats ?? null,
              printability,
              animation: summarizeAnimation(result),
              shapes: result.shapes.map((shape) => ({ name: shape.name, ...summarizeMesh(shape.mesh) })),
              diagnostics: result.diagnostics,
              previewImage,
            },
          };
        } catch (error) {
          return toolFailure('inspect the Replicad model', error);
        }
      },
    },
    {
      name: 'import_step',
      access: { kind: 'filesystem' } as const,
      description:
        'Import and inspect a STEP file (a vendor / McMaster part) so you can reason about mating and cutting against it. Returns bounding box and dimensions. The asset becomes available to scripts via the injected imported(name) helper.',
      parameters: {
        type: 'object' as const,
        properties: {
          filePath: { type: 'string' as const, description: 'Absolute path of a .step/.stp file. Omit to list discovered STEP assets.' },
        },
      },
      handler: async (params: { filePath?: string }, context: AIToolContext) => {
        try {
          const project = await prepareProject(context);
          if (!params.filePath) {
            return {
              success: true,
              data: {
                stepAssets: project.graph.stepAssets.map((path) => ({ path, name: basename(path) })),
                hint: 'Pass filePath to inspect one. In a model, call imported("<filename>") to get the shape.',
              },
            };
          }
          const content = await services.filesystem.readFile(params.filePath);
          const result = await inspectStep(environment, basename(params.filePath), content);
          if (!result.success) {
            return { success: false, error: result.errors[0] ?? 'Failed to import STEP', data: { name: result.name } };
          }
          return {
            success: true,
            data: {
              name: result.name,
              importName: basename(params.filePath),
              stats: result.stats ?? null,
              shapes: result.shapes.map((shape) => ({ name: shape.name, ...summarizeMesh(shape.mesh) })),
            },
          };
        } catch (error) {
          return toolFailure('import the STEP file', error);
        }
      },
    },
    {
      name: 'export_model',
      access: { kind: 'filesystem' } as const,
      description:
        'Compile a model and write manufacturable exports to disk. STEP for B-rep round-trip into Fusion/SolidWorks, STL/3MF for slicing, OBJ for interchange. Returns the written file paths.',
      parameters: {
        type: 'object' as const,
        properties: {
          rootFilePath: { type: 'string' as const },
          params: { type: 'object' as const, additionalProperties: true },
          formats: {
            type: 'array' as const,
            items: { type: 'string' as const, enum: EXPORT_FORMATS },
            description: 'Formats to export; defaults to ["step", "stl"].',
          },
          outputDir: { type: 'string' as const, description: 'Directory to write into; defaults to the model directory.' },
        },
      },
      handler: async (
        params: { rootFilePath?: string; params?: ParamValues; formats?: ExportFormat[]; outputDir?: string },
        context: AIToolContext
      ) => {
        try {
          const formats = (params.formats?.length ? params.formats : (['step', 'stl'] as ExportFormat[])).filter(
            (format): format is ExportFormat => EXPORT_FORMATS.includes(format)
          );
          const { rootFilePath, result } = await compileFromDisk(context, {
            rootFilePath: params.rootFilePath,
            params: params.params,
            exports: formats,
          });
          if (!result.success) {
            return { success: false, data: summarizeCompileResult(result), error: result.errors[0] ?? 'Compile failed' };
          }
          const baseName = basename(rootFilePath).replace(/\.replicad\.ts$/i, '').replace(/\.ts$/i, '') || 'model';
          const outputDir = params.outputDir ? normalize(params.outputDir) : dirname(rootFilePath);
          const written: Array<{ format: ExportFormat; path: string }> = [];
          const skipped: Array<{ format: ExportFormat; reason: string }> = [];

          for (const artifact of result.exports ?? []) {
            const outPath = join(outputDir, `${baseName}.${artifact.extension}`);
            if (artifact.encoding === 'utf8') {
              await services.filesystem.writeFile(outPath, artifact.content);
              written.push({ format: artifact.format, path: outPath });
            } else {
              // writeFile is text-only; binary formats can't round-trip through it.
              skipped.push({
                format: artifact.format,
                reason: 'Binary export could not be written through the text filesystem API. Use a text format (STL/STEP/OBJ) or retrieve the base64 from compile output.',
              });
            }
          }

          return {
            success: written.length > 0,
            data: {
              rootFilePath,
              written,
              skipped,
              stats: result.stats ?? null,
            },
          };
        } catch (error) {
          return toolFailure('export the Replicad model', error);
        }
      },
    },
  ];
}
