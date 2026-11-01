/**
 * Electronics Studio AI tools
 *
 * What makes this a CutuCircuits extension and not just another EDA tool: the agent
 * operates the whole loop. These tools build and inspect the circuit from a
 * prompt -- place parts, wire nets, lint, and export a fab bundle -- by driving
 * the live editor through the API it registers (`context.editorAPI`), and
 * reading back the evaluated Circuit JSON so the agent can reason about it.
 */

import type {
  AIToolContext,
  ExtensionAITool,
  ExtensionToolResult,
} from '@cutucircuits/editor-host';
import { PART_CATALOG, describeCatalogPart, catalogSummary } from './circuit/tscircuitCode';
import { FUNCTIONAL_BLOCKS } from './circuit/functionalBlocks';
import { describePlacedPart } from './circuit/circuitJson';
import { buildFabBundle } from './circuit/fab';
import { buildKicadProject } from './circuit/kicad';
import { buildDiagnosticKicadImport } from './circuit/kicadImport';
import { buildBomBundle, type BomFormat } from './circuit/bom';
import { buildAssemblyHandoffReport } from './circuit/assemblyHandoff';
import { createStrictAssemblyExport } from './circuit/assemblyExport';
import { buildImageBundle, type CircuitView } from './circuit/imageExport';
import { buildSpiceNetlist } from './circuit/spiceExport';
import { estimateQuote } from './fab/quote';
import { generateEnclosureScad } from './fab/enclosure';
import {
  checkArtifactFreshness,
  manifestPathFor,
  writeTrackedExport,
  type ExportKind,
} from './circuit/artifactFreshness';
import { runtimeContractSummary } from './runtime/localRuntime';
import { parseProjectGuidance, summarizeProjectGuidance } from './circuit/projectGuidance';
import { createProjectGuidanceFile } from './circuit/projectGuidanceCreation';
import {
  DEFAULT_PART_EVIDENCE_PATH,
  preparePartEvidenceReport,
} from './circuit/partEvidence';
import { resolvePartEvidenceToolBinding } from './circuit/partEvidenceAgent';
import {
  createPartEvidenceContributionDraft,
  reviewPartEvidenceContributionDraft,
  validatePartEvidenceCandidate,
} from './circuit/partEvidenceContribution';
import type { ElectronicsEditorAPI } from './editorApi';
import {
  PROJECT_TEMPLATE_TOOL_INPUT_SCHEMA,
  validateProjectTemplateRequirements,
} from './circuit/projectTemplates';
import { createDesignReviewPacket } from './circuit/designReviewPacket';
import {
  createSimulationTestArtifact,
  runSimulationTestArtifact,
} from './sim/simulationTestArtifact';
import { createSimulationMatrixArtifact } from './sim/simulationMatrixArtifact';
import { runSimulationMatrixCi } from './sim/simulationMatrixCi';
import { evalTscircuitCode } from './circuit/evalCode';
import { withSimulationMatrixRunLease } from './sim/simulationMatrixRunLease';
import { inspectEvaluatorDiagnostics } from './circuit/evaluatorDiagnostics';
import { createDiagnosticDisposition } from './circuit/diagnosticDisposition';
import {
  parseReviewedFabProfileAssumptions,
  REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID,
} from './circuit/fabProfiles';
import {
  TSCIRCUIT_FOOTPRINTER_VERSION,
  formatFootprintExpansion,
  validateFootprintToken,
  type FootprintValidationResult,
} from './circuit/footprinterApi';
import { AutorouteRunError } from './tscircuit/AutorouteRunner';

/** Resolve the live editor API the open circuit editor registered. */
function getApi(context: AIToolContext & { editorAPI?: unknown }): ElectronicsEditorAPI {
  const api = context.editorAPI as ElectronicsEditorAPI | undefined;
  if (!api) {
    throw new Error('No circuit editor is open. Open a .circuit.tsx or .circuit.json file first.');
  }
  return api;
}

function requireValidFootprintToken(
  token: string,
  label = 'footprint',
): Extract<FootprintValidationResult, { valid: true }> {
  const validation = validateFootprintToken(token);
  if (!validation.valid) {
    throw new Error(`${label} is not valid against @tscircuit/footprinter ${TSCIRCUIT_FOOTPRINTER_VERSION}: ${validation.reason}`);
  }
  return validation;
}

function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? 'circuit';
  return file.replace(/\.circuit\.(tsx|json)$/, '');
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(0, idx) : '.';
}

async function getExportSnapshot(api: ElectronicsEditorAPI): Promise<{
  source: string;
  circuitJson: Awaited<ReturnType<ElectronicsEditorAPI['getCircuitJson']>>['circuitJson'];
  evalError?: string;
}> {
  const source = api.getCode();
  const result = await api.getCircuitJson();
  if (api.getCode() !== source) throw new Error('Live editor source changed during evaluation. Retry the export.');
  return { source, ...result };
}

async function writeExportArtifacts(input: {
  context: AIToolContext;
  api: ElectronicsEditorAPI;
  source: string;
  circuitJson: Awaited<ReturnType<ElectronicsEditorAPI['getCircuitJson']>>['circuitJson'];
  kind: ExportKind;
  options: unknown;
  manifestPath: string;
  files: Array<{ path: string; text: string }>;
}) {
  return writeTrackedExport({
    fs: input.context.extensionContext.services.filesystem,
    manifestPath: input.manifestPath,
    source: input.source,
    circuitJson: input.circuitJson,
    kind: input.kind,
    options: input.options,
    artifacts: input.files,
    assertSourceCurrent: () => {
      if (input.api.getCode() !== input.source) throw new Error('Live editor source changed during export. Artifacts were not certified; retry the export.');
    },
  });
}

/** Resolve a possibly-relative firmware path against the active circuit's dir. */
function resolveAgainstActive(path: string, activeFilePath?: string): string {
  if (/^(\/|[A-Za-z]:[\\/]|:)/.test(path)) return path; // absolute or inline marker
  const base = activeFilePath ? dirOf(activeFilePath) : '.';
  return `${base}/${path}`;
}

function resolveAgainstWorkspace(path: string, workspacePath?: string): string {
  if (/^(\/|[A-Za-z]:[\\/])/.test(path)) return path;
  return `${workspacePath || '.'}/${path}`;
}

function normalizeSimulationTestToolAssertions(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const suppliedValues = ['value', 'text_value', 'number_value', 'boolean_value'].filter((key) => record[key] !== undefined);
    if (suppliedValues.length > 1) throw new Error('Each assertion may provide at most one of text_value, number_value, or boolean_value.');
    return {
      type: record.type,
      ...(record.target !== undefined ? { target: record.target } : {}),
      ...(suppliedValues.length ? { value: record[suppliedValues[0]] } : {}),
      ...(record.tolerance !== undefined ? { tolerance: record.tolerance } : {}),
    };
  });
}

export const aiTools: ExtensionAITool[] = [
  {
    name: 'electronics.runtime_status',
    description:
      'Report the local/offline runtime contract: which core engines are bundled, which optional local toolchains are detected by policy, and which features may use the configured agent provider or optional network data. This does not perform a network request.',
    scope: 'editor',
    access: { kind: 'filesystem' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (): Promise<ExtensionToolResult> => {
      const contract = runtimeContractSummary();
      return {
        success: true,
        message: contract.offlineCore
          ? 'Core design evaluation and simulation assets are bundled for offline use.'
          : 'Some core runtime assets are not bundled.',
        data: contract,
      };
    },
  },
  {
    name: 'electronics.create_project_guidance',
    description:
      'Create one new deterministic versioned electronics.project.json from only explicitly confirmed structured requirements and rules. Filesystem-only: never edits the circuit, never infers or defaults domain values, never overwrites knowingly, and never loads or syncs the new guidance automatically. Requires a canonical workspace-relative path whose basename is electronics.project.json and an existing parent path. The host filesystem has no exclusive-create, realpath, symlink-proof, or rollback API, so no-clobber is best-effort and symlink confinement is unproven.',
    scope: 'editor',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description: 'New canonical workspace-relative path with basename electronics.project.json. Existing files are refused.',
        },
        requirements: {
          type: 'object',
          properties: {
            powerSources: { type: 'array', items: { type: 'string' } },
            interfaces: { type: 'array', items: { type: 'string' } },
            connectors: { type: 'array', items: { type: 'string' } },
            environment: { type: 'array', items: { type: 'string' } },
            quantity: { type: 'number' },
            assemblyPreference: { type: 'string' },
            targetFab: { type: 'string' },
            board: {
              type: 'object',
              properties: {
                maxWidthMm: { type: 'number' },
                maxHeightMm: { type: 'number' },
              },
            },
          },
          required: ['powerSources', 'interfaces', 'connectors', 'environment'],
        },
        rules: {
          type: 'object',
          properties: {
            preferredFootprints: { type: 'array', items: { type: 'string' } },
            preferredSuppliers: { type: 'array', items: { type: 'string' } },
            traceWidths: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  widthMm: { type: 'number' },
                },
                required: ['name', 'widthMm'],
              },
            },
            pcbScalarMinimums: {
              type: 'object',
              description: 'Optional explicitly confirmed global scalar PCB minima for the read-only Rule Lens. These are project requirements, not vendor/fab guarantees or DRC.',
              properties: {
                minTraceWidthMm: { type: 'number' },
                minViaHoleDiameterMm: { type: 'number' },
                minViaPadDiameterMm: { type: 'number' },
                minBoardEdgeClearanceMm: { type: 'number' },
                minPadToPadEdgeClearanceMm: { type: 'number' },
                minPlatedHoleAnnularRingMm: { type: 'number' },
              },
            },
            naming: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  category: { type: 'string' },
                  prefix: { type: 'string' },
                },
                required: ['category', 'prefix'],
              },
            },
            reusableBlocks: { type: 'array', items: { type: 'string' } },
          },
          required: ['preferredFootprints', 'preferredSuppliers', 'traceWidths', 'naming', 'reusableBlocks'],
        },
      },
      required: ['output_path', 'requirements', 'rules'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      const result = await createProjectGuidanceFile({
        workspacePath: context.workspacePath,
        filesystem: context.extensionContext.services.filesystem,
        input: {
          outputPath: params.output_path,
          requirements: params.requirements,
          rules: params.rules,
        },
      });
      if (result.status !== 'created') {
        return {
          success: false,
          error: result.refusal?.message ?? 'Project guidance creation did not complete.',
          data: result,
        };
      }
      return {
        success: true,
        message: `Created ${result.output_path} and verified its exact readback. It was not loaded into the editor; call electronics.load_project_guidance separately after review.`,
        data: result,
      };
    },
  },
  {
    name: 'electronics.load_project_guidance',
    description:
      'Load and validate a versioned local electronics.project.json requirements/rules file, return its full contents to the agent, and sync the same guidance into the open editor advisor. Read-only: this tool never creates or edits the file. Reload after changing the file.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative or absolute guidance path. Defaults to electronics.project.json at the workspace root.',
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const requested = typeof params.path === 'string' && params.path.trim()
          ? params.path.trim()
          : 'electronics.project.json';
        const path = resolveAgainstWorkspace(requested, context.workspacePath);
        const fs = context.extensionContext.services.filesystem;
        if (!(await fs.fileExists(path))) {
          return {
            success: false,
            error: `No project guidance file exists at ${path}. Copy the documented schema or examples/electronics.project.json, review it, then load it explicitly.`,
          };
        }
        const guidance = parseProjectGuidance(await fs.readFile(path));
        getApi(context).setProjectGuidance(guidance);
        const summary = summarizeProjectGuidance(guidance);
        return {
          success: true,
          message: `Loaded local project guidance from ${path}: ${summary.powerSources} power source(s), ${summary.interfaces} interface(s), ${summary.traceClasses} trace class(es).`,
          data: { path, guidance, summary, syncedToAdvisor: true, readOnly: true },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.propose_project_template',
    description:
      'Stage one selected deterministic controller template over a truly blank, successfully evaluated editable TSX document. Supports the socketed XIAO ESP32-C3 I2C carrier and socketed Raspberry Pi Pico mixed-sensor/status carrier. Call only after the user explicitly supplies or confirms every exact structured requirement for the selected template; never infer or cross values from another template, selection, defaults, guidance, source, or common practice. Never mutates immediately, overwrites non-empty or ambiguous designs, or offers replace-anyway. Review the echoed requirements, refs, limitations, and source/evaluated impact, then stop at approval.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: PROJECT_TEMPLATE_TOOL_INPUT_SCHEMA,
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).proposeProjectTemplate(validateProjectTemplateRequirements(params));
        return {
          success: true,
          message: `Staged ${result.templateId} with refs ${result.expectedRefs.join(', ')}. Requirements are echoed in data and source. No source was changed; approval ${result.preview.approvalId} is required. Limitations: ${result.limitations.join(' ')}`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.part_evidence_report',
    description:
      'Read an explicit versioned project-local parts record (default electronics.parts.json), presence-check every confined local source path without reading its contents, classify every freshly evaluated placed source part as incomplete, declared, evidenced, or conflict, and sync the same session-only status into the Advisor and placed-part rows. Read-only: never creates, watches, rewrites, fetches, saves, or mutates source. Evidenced requires an exact MPN record, agreeing footprint, and present referenced paths; it never means source contents were read, validated, hashed, authenticated, or verified.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `Workspace-relative or workspace-confined absolute local evidence-record path. Defaults to ${DEFAULT_PART_EVIDENCE_PATH} at the workspace root.`,
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      const api = getApi(context);
      try {
        const binding = resolvePartEvidenceToolBinding(params.path, context.workspacePath);
        const path = binding.resolvedPath;
        const baseline = api.getCode();
        api.setPartEvidenceReport(undefined, binding);
        const fs = context.extensionContext.services.filesystem;
        const { circuitJson, evalError } = await api.getCircuitJson();
        if (evalError) throw new Error(`The current circuit cannot be evaluated for part evidence: ${evalError}`);
        const report = await preparePartEvidenceReport(circuitJson, {
          path,
          workspacePath: context.workspacePath!,
          fileExists: (candidate) => fs.fileExists(candidate),
          readFile: (candidate) => fs.readFile(candidate),
          assertCurrent: () => {
            if (baseline !== api.getCode()) {
              throw new Error('The circuit changed while the part evidence report was being prepared. Run the report again.');
            }
          },
        });
        api.setPartEvidenceReport(report, binding);
        const state = report.evidenceFile.state === 'loaded'
          ? `Loaded ${report.evidenceFile.recordCount} reviewed local record(s)`
          : `No evidence file exists at ${path}; no local records were assumed`;
        return {
          success: true,
          message: `${state}. Source paths: ${report.sourceSummary.present} present, ${report.sourceSummary.missing} missing. Classified ${report.summary.total} placed part(s): ${report.summary.evidenced} evidenced, ${report.summary.declared} declared, ${report.summary.incomplete} incomplete, ${report.summary.conflict} conflict. Presence does not verify source contents.`,
          data: {
            report,
            syncedToAdvisor: true,
            readOnly: true,
            sourceMutated: false,
            evidenceFileCreatedOrWatched: false,
          },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.show_part_trust_spotlight',
    description:
      'Show a session-only read-only schematic/PCB Spotlight for exact placed parts in 1-4 selected statuses from the explicitly attached electronics.part_evidence_report. Revalidates every current source-component id/ref and report summary; refuses missing/stale reports. Evidenced means present-backed local-record agreement only, never verified, electrical, authentic, available, orderable, supplier-live, manufacturing, or physical proof. Does not read evidence contents or mutate/save the circuit.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string', enum: ['incomplete', 'declared', 'conflict', 'evidenced'] } },
      },
      required: ['statuses'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).showPartTrustSpotlight({ statuses: params.statuses as string[] });
        return {
          success: true,
          message: `Part Trust Spotlight shows ${result.counts.total} exact part(s): ${result.counts.schematicMappedParts} schematic-mapped and ${result.counts.pcbMappedParts} PCB-mapped. Status is local record/path-presence evidence only, never verification.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_part_trust_spotlight',
    description: 'Idempotently clear the session-only Part Trust Spotlight. It does not clear the loaded evidence report, mutate source, mark dirty, save, or enter history/undo.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearPartTrustSpotlight();
        return { success: true, message: result.cleared ? 'Cleared Part Trust Spotlight.' : 'Part Trust Spotlight was already clear.', data: { ...result, sourceChanged: false, sessionOnly: true } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.validate_part_evidence_candidate',
    description:
      'Read-only local contribution check for one exact placed part. Derives the candidate MPN and footprint from the uniquely resolved live source component, validates one bounded v1 record candidate through the authoritative TypeScript parser, checks referenced project-relative path presence without reading those contents, and reads only the exact workspace-root electronics.parts.json to classify new/exact-duplicate/conflict. Returns a canonical copyable record fragment; never creates, overwrites, merges, publishes, fetches, saves, or mutates source/report/history. Parser-compatible, metadata-matching, and path-present are not verification, acceptance, authenticity, licensing, electrical, supplier, manufacturing, security, or community validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        sourceComponentId: { type: 'string', description: 'Exact selected source_component_id.' },
        ref: { type: 'string', description: 'Exact selected case-sensitive ref.' },
        manufacturer: { type: 'string', description: 'Optional explicit reviewer-supplied manufacturer text.' },
        notes: { type: 'string', description: 'Optional explicit reviewer note.' },
        evidence: {
          type: 'array',
          description: 'One to eight explicit project-relative local evidence paths. Referenced contents are never read.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Reviewer-chosen project-relative local path.' },
              notes: { type: 'string', description: 'Optional explicit reviewer note about this path.' },
            },
            required: ['source'],
          },
        },
      },
      required: ['sourceComponentId', 'ref', 'evidence'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) throw new Error('A workspace must be open for a workspace-confined part-record check.');
        const api = getApi(context);
        const baseline = api.getCode();
        const { circuitJson, evalError } = await api.getCircuitJson();
        if (evalError) throw new Error(`The current circuit cannot be evaluated for part-record validation: ${evalError}`);
        const request = {
          sourceComponentId: params.sourceComponentId,
          ref: params.ref,
          ...(params.manufacturer != null ? { manufacturer: params.manufacturer } : {}),
          ...(params.notes != null ? { notes: params.notes } : {}),
          evidence: params.evidence,
        } as never;
        api.authorizePartEvidenceCandidate(request);
        const fs = context.extensionContext.services.filesystem;
        const result = await validatePartEvidenceCandidate({
          elements: circuitJson,
          request,
          workspacePath: context.workspacePath,
          fileExists: (path) => fs.fileExists(path),
          readFile: (path) => fs.readFile(path),
          assertCurrent: () => {
            if (baseline !== api.getCode()) throw new Error('The circuit changed during part-record validation. Select the part and run the check again.');
          },
        });
        return {
          success: true,
          message: `Candidate is v1 parser-compatible and matches ${result.selected.ref} metadata. Local paths: ${result.pathPresence.present} present, ${result.pathPresence.missing} missing. Target collision: ${result.collision}. This is not a verified or accepted contribution.`,
          data: { result, readOnly: true, filesWritten: false, sourceMutated: false, reportMutated: false },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.create_part_evidence_contribution_draft',
    description:
      'Create one standalone, versioned local part-evidence contribution draft plus a completion manifest for one exact freshly evaluated selected part. MPN and placed footprint come only from the uniquely resolved live component; 1–8 explicit project-relative evidence paths must all be present, but their contents are never read or verified. The workspace-root electronics.parts.json collision is recorded as new, exact-duplicate, or conflict. Requires two new canonical workspace-relative paths, writes the *.electronics.part-contribution-draft.json envelope then manifest, and never overwrites, merges, publishes, fetches, saves, or mutates the circuit/root record. A draft is not verified, accepted, licensed, electrically correct, orderable, manufacturable, secure, or community-approved.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        sourceComponentId: { type: 'string', description: 'Exact selected source_component_id.' },
        ref: { type: 'string', description: 'Exact selected case-sensitive ref.' },
        manufacturer: { type: 'string', description: 'Optional explicit reviewer-supplied manufacturer text.' },
        notes: { type: 'string', description: 'Optional explicit reviewer note.' },
        evidence: {
          type: 'array',
          description: 'One to eight explicit project-relative local evidence paths. Every path must be present; referenced contents are never read.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Reviewer-chosen project-relative local path.' },
              notes: { type: 'string', description: 'Optional explicit reviewer note about this path.' },
            },
            required: ['source'],
          },
        },
        output_path: { type: 'string', description: 'New canonical workspace-relative *.electronics.part-contribution-draft.json destination; parent must already exist.' },
        manifest_path: { type: 'string', description: 'New distinct canonical workspace-relative *.freshness.json completion-manifest destination; parent must already exist.' },
      },
      required: ['sourceComponentId', 'ref', 'evidence', 'output_path', 'manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) throw new Error('A workspace must be open for a workspace-confined part-record draft.');
        const api = getApi(context);
        const request = {
          sourceComponentId: params.sourceComponentId,
          ref: params.ref,
          ...(params.manufacturer != null ? { manufacturer: params.manufacturer } : {}),
          ...(params.notes != null ? { notes: params.notes } : {}),
          evidence: params.evidence,
        } as never;
        api.authorizePartEvidenceDraft(request);
        const result = await createPartEvidenceContributionDraft({
          api,
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          outputPath: params.output_path,
          manifestPath: params.manifest_path,
          request,
        });
        return {
          success: result.status === 'created',
          message: result.status === 'created'
            ? `Created standalone local part-record draft ${result.output_path} and completed manifest ${result.manifest_path}. It was not merged, published, or verified; freshness at return is not guaranteed.`
            : result.status === 'incomplete'
              ? `Part-record draft output is incomplete. Automatic cleanup is unavailable; paths that may exist: ${result.cleanup?.pathsThatMayExist.join(', ') || 'unknown'}.`
              : `Part-record draft refused: ${result.refusal?.message ?? 'request was not safe to complete'}`,
          data: result,
          ...(result.status === 'created' ? {} : { error: result.refusal?.message ?? 'Part-record draft was not created.' }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.review_part_evidence_contribution',
    description:
      'Read one explicit part-contribution-draft freshness manifest and review its single recorded draft against current workspace-root electronics.parts.json collision and referenced-path presence. This global filesystem-only review never opens an editor, scans, mutates, merges, publishes, or reads referenced evidence contents. Consistent current observations are not verification, acceptance, licensing, electrical correctness, availability, manufacturability, security, or community approval.',
    scope: 'global',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        manifest_path: {
          type: 'string',
          description: 'Explicit canonical workspace-relative *.freshness.json manifest returned by electronics.create_part_evidence_contribution_draft.',
        },
      },
      required: ['manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) throw new Error('A workspace must be open before reviewing a local part contribution draft.');
        const result = await reviewPartEvidenceContributionDraft({
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          manifestPath: params.manifest_path,
        });
        return {
          success: true,
          message: result.state === 'consistent_current_observations'
            ? `Contribution draft ${result.draft_path} is intact and its current root-collision/path-presence observations are consistent. This is not verification or acceptance.`
            : `Contribution review state: ${result.state}. ${result.details.join(' ')}`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.import_kicad',
    description:
      'Explicitly import KiCad .kicad_sch/.kicad_pcb files as a diagnostic, render-only Electronics Studio migration. Copies the originals, writes Circuit JSON plus deterministic provenance/limitations reports, never modifies the KiCad sources, and refuses to overwrite prior migration output. This is not editable conversion or continuous synchronization.',
    scope: 'global',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'KiCad project/schematic/PCB paths. Include companion .kicad_sch and .kicad_pcb files when available.',
          items: { type: 'string' },
        },
        output_dir: {
          type: 'string',
          description: 'New migration output directory. Defaults to "<project>-electronics-import" beside the first source file.',
        },
      },
      required: ['files'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const requested = Array.isArray(params.files)
          ? params.files.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        if (!requested.length) throw new Error('Provide at least one KiCad source path.');
        const fs = context.extensionContext.services.filesystem;
        const paths = requested.map((path) => resolveAgainstWorkspace(path.trim(), context.workspacePath));
        const sourceFiles = await Promise.all(paths.map(async (path) => ({ path, content: await fs.readFile(path) })));
        const first = paths[0];
        const projectName = baseName(first).replace(/\.kicad_(?:pro|sch|pcb|sym)$/i, '') || 'kicad-import';
        const outDir = typeof params.output_dir === 'string' && params.output_dir.trim()
          ? resolveAgainstWorkspace(params.output_dir.trim(), context.workspacePath)
          : `${dirOf(first)}/${projectName}-electronics-import`;
        const bundle = await buildDiagnosticKicadImport(sourceFiles, projectName);
        const targets = Object.keys(bundle.files).map((relative) => `${outDir}/${relative}`);
        const collisions = (await Promise.all(targets.map(async (path) => ({ path, exists: await fs.fileExists(path) }))))
          .filter((entry) => entry.exists)
          .map((entry) => entry.path);
        if (collisions.length) {
          return {
            success: false,
            error: `Migration output already exists; choose a new output_dir. Refusing to overwrite: ${collisions.join(', ')}`,
          };
        }
        for (const [relative, content] of Object.entries(bundle.files)) {
          await fs.writeFile(`${outDir}/${relative}`, content);
        }
        return {
          success: true,
          message: `Imported ${bundle.report.sourceFiles.length} KiCad file(s) to a render-only diagnostic migration at ${outDir}. Original files remain canonical.`,
          data: {
            outputDir: outDir,
            circuitJson: `${outDir}/${projectName}.imported.circuit.json`,
            report: `${outDir}/${projectName}-IMPORT_REPORT.md`,
            provenance: `${outDir}/${projectName}-IMPORT_PROVENANCE.json`,
            editable: false,
            canonicalSource: 'kicad',
            stats: bundle.report.stats,
            warnings: bundle.report.warnings,
            knownLimitations: bundle.report.knownLimitations,
          },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.list_nets',
    description:
      'List the components and nets (connections) in the open circuit. Returns each component with its ref designator/type/value and each net with its endpoints, so you can reason about how the circuit is wired.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const { components, nets, evalError } = await getApi(context).inspect();
        return {
          success: true,
          message: `${components.length} component(s), ${nets.length} net(s)`,
          data: { components, nets, evalError },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.inspect_assembly_handoff',
    description:
      'Inspect exact local completeness for the installed JLC-style BOM/CPL text template without writing or exporting anything. Re-evaluates the current editor, resolves source and evaluated CAD footprints, exact LCSC/JLCPCB identifiers, and exact PCB placements, then reports blocker refs and any Circuit JSON layer/rotation defaults. This is not current vendor-portal acceptance, stock, price, package-orientation, centroid, pin-1, ERC/DRC/DFM, fabrication, assembly, or physical validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: ['jlcpcb-bom-cpl'],
          description: 'Exact installed text-template contract to inspect.',
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (params.template != null && params.template !== 'jlcpcb-bom-cpl') {
          return { success: false, error: 'Only the exact jlcpcb-bom-cpl template is supported.' };
        }
        const { circuitJson, evalError } = await getExportSnapshot(getApi(context));
        if (evalError) return { success: false, error: `Cannot inspect assembly handoff: circuit failed to evaluate (${evalError}).` };
        const report = buildAssemblyHandoffReport(circuitJson);
        return {
          success: true,
          message: `${report.summary.ready}/${report.summary.total} placed part(s) are complete for the installed JLC-style BOM/CPL text template; ${report.summary.blocked} blocked.`,
          data: report,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_assembly_handoff',
    description:
      'Write one strict complete installed-template JLC-style BOM/CPL text pair plus a provenance/freshness manifest written last. Requires three explicit, distinct, canonical workspace-relative new paths with existing parent directories; never scans, chooses defaults, emits partial rows, overwrites knowingly, retries, or saves/edits the circuit. Refuses any exact assembly completeness blocker or source drift. No exclusive-create/atomic no-clobber, rollback/delete, realpath, or symlink-confinement guarantee exists. This does not prove vendor-portal acceptance, orientation/centroid/pin-1 correctness, stock, pricing, ERC, DRC, DFM, fabrication, assembly, manufacturing, hardware, or offline validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        bom_path: {
          type: 'string',
          description: 'New canonical workspace-relative path ending .bom.csv; parent must already exist.',
        },
        cpl_path: {
          type: 'string',
          description: 'New canonical workspace-relative path ending .cpl.csv; parent must already exist.',
        },
        manifest_path: {
          type: 'string',
          description: 'New canonical workspace-relative path ending .freshness.json; parent must already exist.',
        },
      },
      required: ['bom_path', 'cpl_path', 'manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) {
          return { success: false, error: 'A workspace must be open before creating a workspace-local assembly handoff.' };
        }
        const result = await createStrictAssemblyExport({
          api: getApi(context),
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          bomPath: params.bom_path,
          cplPath: params.cpl_path,
          manifestPath: params.manifest_path,
        });
        return result.status === 'created'
          ? {
              success: true,
              message: `Wrote strict complete assembly handoff to ${result.bom_path}, ${result.cpl_path}, and completed manifest ${result.manifest_path}. Freshness after return is not guaranteed.`,
              data: result,
            }
          : {
              success: false,
              error: result.refusal?.message ?? `Strict assembly handoff ${result.status}.`,
              data: result,
            };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.show_assembly_handoff_spotlight',
    description:
      'Show a bounded session-only read-only Assembly Scout on exact schematic and PCB components from the current installed JLC-style BOM/CPL completeness report. Mode is exactly blocked, ready, or all. Re-evaluates the current editor and refuses stale, failed, ambiguous, or over-cap evidence. It does not export, save, mutate source, mark dirty, create history/undo, or prove current vendor-portal acceptance, stock, package orientation, centroid, pin 1, ERC, DRC, DFM, assembly, manufacturing, or physical validity.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['blocked', 'ready', 'all'],
          description: 'Exact report subset to visualize.',
        },
      },
      required: ['mode'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).showAssemblyHandoffSpotlight({ mode: params.mode as string });
        return {
          success: true,
          message: `Assembly Scout shows ${result.counts.total} exact part(s): ${result.counts.blocked} blocked, ${result.counts.ready} ready, ${result.counts.schematicMappedParts} schematic-mapped, and ${result.counts.pcbMappedParts} PCB-mapped. This is installed text-template completeness only.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.preview_assembly_metadata',
    description:
      'Stage missing footprint and/or exact LCSC metadata for one exact case-sensitive placed ref. Supplied footprint tokens must parse against the pinned evaluator-compatible footprinter grammar. V1 accepts only a unique self-closing JSX part with the corresponding missing-field blocker; it refuses existing/conflicting footprints, existing/ambiguous supplier maps, unsafe literals, no-ops, stale/failed evaluation, and any unexpected before/after identity, trace, placement, or blocker change. No source is changed by this call: inspect the exact metadata preview and use electronics.resolve_edit_preview to apply or cancel. Grammar validation does not verify footprint-to-part/LCSC matching, authenticity, stock, price, orderability, current portal acceptance, ERC, DRC, DFM, fabrication, assembly, or hardware.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Exact case-sensitive placed ref, for example R1.' },
        footprint: { type: 'string', description: 'Optional exact bounded literal footprinter token to fill a missing-footprint blocker, for example 0603.' },
        lcscPartNumber: { type: 'string', description: 'Optional exact C-prefixed numeric LCSC identifier to fill a missing-LCSC blocker, for example C25804.' },
      },
      required: ['ref'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (typeof params.ref !== 'string') throw new Error('preview_assembly_metadata requires an exact string ref.');
        if (params.footprint != null && typeof params.footprint !== 'string') throw new Error('footprint must be a string when supplied.');
        if (params.lcscPartNumber != null && typeof params.lcscPartNumber !== 'string') throw new Error('lcscPartNumber must be a string when supplied.');
        const footprintValidation = typeof params.footprint === 'string'
          ? requireValidFootprintToken(params.footprint)
          : undefined;
        const result = await getApi(context).previewAssemblyMetadata({
          ref: params.ref,
          ...(typeof params.footprint === 'string' ? { footprint: params.footprint } : {}),
          ...(typeof params.lcscPartNumber === 'string' ? { lcscPartNumber: params.lcscPartNumber } : {}),
        });
        return {
          success: true,
          message: `Previewed exact assembly metadata for ${result.metadata.ref}; resolved ${result.metadata.resolvedIssues.join(', ') || 'no'} blocker(s).${footprintValidation ? ` Footprint token parses as ${formatFootprintExpansion(footprintValidation)} against the pinned grammar only.` : ''} No source was changed; approval ${result.preview.approvalId} is required and only electronics.resolve_edit_preview may apply or cancel it.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.preview_assembly_metadata_batch',
    description:
      'Stage one atomic Assembly Fix Queue containing 1-8 exact case-sensitive placed refs, each with a user-supplied missing footprint and/or exact LCSC identifier. Supplied footprint tokens must parse against the pinned evaluator-compatible footprinter grammar. Every update must target a unique self-closing JSX part with the corresponding current missing-field blocker. The whole batch is refused on stale/failed evaluation, duplicate or unsupported input, existing/conflicting metadata, or any unexpected identity, trace, placement, other-part, or blocker change. No source is changed by this call: inspect the exact per-part preview and use electronics.resolve_edit_preview to apply or cancel it. Grammar validation does not verify footprint/LCSC matching, authenticity, stock, price, orderability, current portal acceptance, ERC, DRC, DFM, fabrication, assembly, manufacturing, hardware, or offline validity.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'One atomic runtime-capped list of 1-8 unique exact refs and their explicit missing metadata values.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Exact case-sensitive placed ref.' },
              footprint: { type: 'string', description: 'Optional exact bounded literal footprinter token.' },
              lcscPartNumber: { type: 'string', description: 'Optional exact C-prefixed numeric LCSC identifier.' },
            },
            required: ['ref'],
          },
        },
      },
      required: ['updates'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!Array.isArray(params.updates)) throw new Error('preview_assembly_metadata_batch requires an updates array.');
        const footprintValidations: Array<{
          ref: string;
          validation: Extract<FootprintValidationResult, { valid: true }>;
        }> = [];
        const updates = params.updates.map((value, index) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`updates[${index}] must be an object.`);
          const update = value as Record<string, unknown>;
          if (typeof update.ref !== 'string') throw new Error(`updates[${index}].ref must be an exact string.`);
          if (update.footprint != null && typeof update.footprint !== 'string') throw new Error(`updates[${index}].footprint must be a string when supplied.`);
          if (update.lcscPartNumber != null && typeof update.lcscPartNumber !== 'string') throw new Error(`updates[${index}].lcscPartNumber must be a string when supplied.`);
          if (typeof update.footprint === 'string') {
            footprintValidations.push({
              ref: update.ref,
              validation: requireValidFootprintToken(update.footprint, `updates[${index}].footprint`),
            });
          }
          return {
            ref: update.ref,
            ...(typeof update.footprint === 'string' ? { footprint: update.footprint } : {}),
            ...(typeof update.lcscPartNumber === 'string' ? { lcscPartNumber: update.lcscPartNumber } : {}),
          };
        });
        const result = await getApi(context).previewAssemblyMetadataBatch({ updates });
        return {
          success: true,
          message: `Previewed one atomic Assembly Fix Queue for ${result.metadata.counts.updates} exact part(s), resolving ${result.metadata.counts.resolvedIssues} blocker(s).${footprintValidations.length ? ` Footprint tokens parse against the pinned grammar only: ${footprintValidations.map(({ ref, validation }) => `${ref} ${formatFootprintExpansion(validation)}`).join('; ')}.` : ''} No source was changed; approval ${result.preview.approvalId} is required and only electronics.resolve_edit_preview may apply or cancel it.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_assembly_handoff_spotlight',
    description: 'Idempotently clear the session-only Assembly Scout. It does not mutate source, mark dirty, save, create history/undo, or change the exact assembly handoff report.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearAssemblyHandoffSpotlight();
        return { success: true, message: result.cleared ? 'Cleared Assembly Scout.' : 'Assembly Scout was already clear.', data: { ...result, sourceChanged: false, sessionOnly: true } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.add_part',
    description:
      'Add a part to the open .circuit.tsx circuit. Choose a catalog part (e.g. esp32, a4988, stepper_nema17, led, resistor, limit_switch). Auto-assigns a ref designator (R1, U2, ...) and a schematic position. Returns the assigned name so you can wire it.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        part: {
          type: 'string',
          description: 'Catalog part key.',
          enum: PART_CATALOG.map((p) => p.key),
        },
        name: { type: 'string', description: 'Optional explicit ref designator (e.g. "R5"). Auto-assigned if omitted.' },
      },
      required: ['part'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).addPart(String(params.part), params.name ? String(params.name) : undefined);
        return { success: true, message: `Added ${result.part} as ${result.name}.`, data: result };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.add_block',
    description:
      'Preview adding a reusable functional circuit block, including its parts and safe internal wiring. Because this is a broad edit, it is not applied immediately: inspect the returned source/visual impact and use electronics.resolve_edit_preview with the approval_id to apply or cancel it.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        block: {
          type: 'string',
          description: 'Functional block key.',
          enum: FUNCTIONAL_BLOCKS.map((block) => block.key),
        },
      },
      required: ['block'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).addBlock(String(params.block));
        return {
          success: true,
          message: `Previewed ${result.block}: ${result.parts.map((part) => part.name).join(', ')} with ${result.connections.length} internal connection(s). No source was changed; approval ${result.preview.approvalId} is required.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.connect',
    description:
      'Legacy immediate-write compatibility tool that adds a <trace> to the open .circuit.tsx circuit. Prefer electronics.preview_connection for agent-first exact component-port wiring with review and approval. This advanced path still accepts broader tscircuit selectors such as ".R1 > .pin2" or "net.GND" and mutates immediately.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source selector, e.g. ".R1 > .pin2" or "net.GND".' },
        to: { type: 'string', description: 'Target selector, e.g. ".LED1 > .anode" or ".U1 > .GPIO4".' },
      },
      required: ['from', 'to'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const from = String(params.from || '');
        const to = String(params.to || '');
        const result = await getApi(context).connect(from, to);
        return { success: true, message: `Connected ${from} -> ${to}.`, data: { from, to, ...result } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.preview_connection',
    description:
      'Preferred agent-first wiring path. Stage exactly one source-level connection between two proven, case-sensitive canonical ".REF > .PORT" selectors from the latest successful Circuit JSON. Both endpoint source ports must be unique and absent from every source_trace; v1 never merges or extends a logical net. Exact before/after evaluation must prove one added two-endpoint source_trace and no other identity or trace-membership change. No source is changed by this call: inspect the returned affected-net preview and use electronics.resolve_edit_preview with the approval_id to apply or cancel. This is not ERC, DRC, PCB copper/routing, fabrication/manufacturing, physical hardware, or offline validation.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Exact canonical component-port selector (runtime-capped at 160 characters), e.g. ".U1 > .GPIO4".' },
        to: { type: 'string', description: 'A different exact canonical component-port selector (runtime-capped at 160 characters), e.g. ".R1 > .pin1".' },
      },
      required: ['from', 'to'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (typeof params.from !== 'string' || typeof params.to !== 'string') {
          throw new Error('preview_connection requires exact string from and to selectors.');
        }
        const from = params.from;
        const to = params.to;
        const result = await getApi(context).previewConnection({ from, to });
        return {
          success: true,
          message: `Previewed exact connection ${result.from.selector} ↔ ${result.to.selector}. No source was changed; approval ${result.preview.approvalId} is required and only electronics.resolve_edit_preview may apply or cancel it.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.describe_part',
    description:
      'Look up wiring information. With no arguments, list every catalog part and functional block you can add. With "part" (a catalog key), return that part\'s tag, footprint, and pin labels. With "ref" (a placed ref like "U1"), introspect the live circuit: exact pins and trace participation. Use electronics.describe_part plus electronics.list_nets before the preferred electronics.preview_connection path; never guess selectors from prose.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'string', description: 'Catalog part key to describe (e.g. "esp32", "a4988").', enum: PART_CATALOG.map((p) => p.key) },
        ref: { type: 'string', description: 'Ref designator of a placed part to introspect from the live circuit (e.g. "U1").' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
        if (ref) {
          const { circuitJson, evalError } = await getApi(context).getCircuitJson();
          if (evalError) return { success: false, error: `Cannot introspect: circuit failed to evaluate (${evalError}).` };
          const placed = describePlacedPart(circuitJson, ref);
          if (!placed) return { success: false, error: `No placed part named "${ref}". Use list_nets to see what exists.` };
          return {
            success: true,
            message: `${placed.name}: ${placed.pins.length} pin(s) — wire as ".${placed.name} > .<pin>".`,
            data: placed,
          };
        }
        const partKey = typeof params.part === 'string' ? params.part.trim() : '';
        if (partKey) {
          const info = describeCatalogPart(partKey);
          if (!info) return { success: false, error: `Unknown catalog part "${partKey}".` };
          return {
            success: true,
            message: `${info.label}: pins ${info.pins.length ? info.pins.join(', ') : '(discrete)'} — wire as ".<ref> > .<pin>".`,
            data: info,
          };
        }
        return {
          success: true,
          message: `${PART_CATALOG.length} catalog part(s), ${FUNCTIONAL_BLOCKS.length} functional block(s).`,
          data: {
            parts: catalogSummary(),
            blocks: FUNCTIONAL_BLOCKS.map((b) => ({ key: b.key, label: b.label, description: b.description })),
          },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.remove_part',
    description:
      'Preview removing a part and every trace that references it. This destructive edit is not applied immediately: inspect the returned source/visual impact and use electronics.resolve_edit_preview with the approval_id to apply or cancel it.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Ref designator to remove (e.g. "R1", "U2").' } },
      required: ['name'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).removePart(String(params.name || ''));
        return {
          success: true,
          message: `Previewed removal of ${result.name}${result.removedTraces ? ` and ${result.removedTraces} trace(s)` : ''}. No source was changed; approval ${result.preview.approvalId} is required.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.remove_connection',
    description:
      'Remove a wire (trace) from the open .circuit.tsx circuit by its endpoints. Endpoints are the same tscircuit selectors used to create it (e.g. ".R1 > .pin2" and ".LED1 > .anode"); order does not matter. Use this to rewire a net.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'One endpoint selector, e.g. ".R1 > .pin2".' },
        to: { type: 'string', description: 'The other endpoint selector, e.g. ".LED1 > .anode".' },
      },
      required: ['from', 'to'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const from = String(params.from || '');
        const to = String(params.to || '');
        const result = await getApi(context).removeConnection(from, to);
        return { success: true, message: `Removed connection ${from} — ${to}.`, data: { from, to, ...result } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.update_part',
    description:
      'Change an existing part in the open .circuit.tsx circuit: its value (resistance/capacitance/etc., mapped to the right attribute for the part), its footprint, or its manufacturerPartNumber. Supplied footprint tokens must parse against the pinned evaluator-compatible footprinter grammar; this does not verify part matching or manufacturability. Setting manufacturerPartNumber is how you make a part orderable/BOM-ready. Returns which attributes changed.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Ref designator to update (e.g. "R1").' },
        value: { type: 'string', description: 'New primary value, e.g. "4.7k" for a resistor or "10uF" for a capacitor.' },
        footprint: { type: 'string', description: 'New footprint, e.g. "0603".' },
        manufacturerPartNumber: { type: 'string', description: 'Manufacturer part number, for sourcing and the BOM.' },
      },
      required: ['name'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (params.footprint != null && typeof params.footprint !== 'string') {
          throw new Error('footprint must be a string when supplied.');
        }
        const footprintValidation = typeof params.footprint === 'string'
          ? requireValidFootprintToken(params.footprint)
          : undefined;
        const result = await getApi(context).updatePart(String(params.name || ''), {
          value: typeof params.value === 'string' ? params.value : undefined,
          footprint: typeof params.footprint === 'string' ? params.footprint : undefined,
          manufacturerPartNumber:
            typeof params.manufacturerPartNumber === 'string' ? params.manufacturerPartNumber : undefined,
        });
        return {
          success: true,
          message: `Updated ${result.name}: ${result.changed.join(', ')}.${footprintValidation ? ` Footprint token parses as ${formatFootprintExpansion(footprintValidation)} against the pinned grammar only; part matching and manufacturability are not verified.` : ''}`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.set_board',
    description:
      'Preview changing the board outline size. Because enclosure and fabrication geometry are affected, this is not applied immediately: inspect the returned source/visual impact and use electronics.resolve_edit_preview with the approval_id to apply or cancel it.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'string', description: 'Board width, e.g. "40mm".' },
        height: { type: 'string', description: 'Board height, e.g. "30mm".' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).setBoard({
          width: typeof params.width === 'string' ? params.width : undefined,
          height: typeof params.height === 'string' ? params.height : undefined,
        });
        return {
          success: true,
          message: `Previewed the board outline update. No source was changed; approval ${result.preview.approvalId} is required.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.preview_geometry_change',
    description:
      'Preview one atomic, absolute PCB geometry proposal for up to 12 exact part refs and optional explicit rectangular board dimensions. Every part requires pcbX/pcbY in millimetres; pcbRotation is optional. The tool evaluates the exact before/after Circuit JSON and stages the result without changing source. Review exact numeric geometry deltas, then use electronics.resolve_edit_preview.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Exact literal part ref, e.g. R1.' },
              pcbX: { type: 'number', description: 'Absolute evaluated PCB X coordinate in mm.' },
              pcbY: { type: 'number', description: 'Absolute evaluated PCB Y coordinate in mm.' },
              pcbRotation: { type: 'number', description: 'Optional absolute clockwise rotation in degrees.' },
            },
            required: ['ref', 'pcbX', 'pcbY'],
          },
        },
        board: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'Optional explicit rectangular board width in mm.' },
            height: { type: 'number', description: 'Optional explicit rectangular board height in mm.' },
          },
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const rawParts = Array.isArray(params.parts) ? params.parts : [];
        const parts = rawParts.map((value) => {
          const part = value as Record<string, unknown>;
          return {
            ref: typeof part.ref === 'string' ? part.ref : '',
            pcbX: part.pcbX as number,
            pcbY: part.pcbY as number,
            ...(typeof part.pcbRotation === 'number' ? { pcbRotation: part.pcbRotation } : {}),
          };
        });
        const rawBoard = params.board && typeof params.board === 'object' ? params.board as Record<string, unknown> : undefined;
        const board = rawBoard ? {
          ...(typeof rawBoard.width === 'number' ? { width: rawBoard.width } : {}),
          ...(typeof rawBoard.height === 'number' ? { height: rawBoard.height } : {}),
        } : undefined;
        const result = await getApi(context).previewGeometryChange({ parts, ...(board ? { board } : {}) });
        return {
          success: true,
          message: `Previewed exact PCB geometry for ${result.targets.length} part(s). No source was changed; approval ${result.preview.approvalId} is required.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.apply_readiness_action',
    description:
      'Preview one deterministic action advertised by the exact current electronics.readiness report. Initially supports only making a geometry-derived outline explicit at the reported dimensions. It never applies immediately: inspect the preview and use electronics.resolve_edit_preview with the approval_id. Stale, missing, or non-actionable action IDs are rejected.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        action_id: {
          type: 'string',
          description: 'Exact automaticAction.id returned by the current electronics.readiness report.',
        },
      },
      required: ['action_id'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).applyReadinessAction(String(params.action_id || ''));
        return {
          success: true,
          message: `Previewed readiness action ${result.actionId} at ${result.dimensions.widthMm} × ${result.dimensions.heightMm} mm. No source was changed; approval ${result.preview.approvalId} is required.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.preview_mounting_holes',
    description:
      'Preview one atomic batch of 1-8 unplated circular mechanical holes using unique source/audit names plus exact diameter and PCB center coordinates in millimetres. Requires one editable direct board and exact before/after evaluation. The evaluator does not preserve hole names, so verification uses the exact pcb_hole center/diameter multiset and count. Requested circles must fit within the proven rectangular board. No source changes until electronics.resolve_edit_preview applies the approval_id. This does not create plated holes, vias, annular rings, keep-outs, edge-clearance, DRC, or fabrication validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        holes: {
          type: 'array',
          description: 'One to eight unplated circular mechanical holes.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Unique source/audit name, e.g. MH1. Evaluated pcb_hole does not preserve this identity.' },
              diameter: { type: 'number', description: 'Circular hole diameter in millimetres.' },
              pcbX: { type: 'number', description: 'Exact PCB center X coordinate in millimetres.' },
              pcbY: { type: 'number', description: 'Exact PCB center Y coordinate in millimetres.' },
            },
            required: ['name', 'diameter', 'pcbX', 'pcbY'],
          },
        },
      },
      required: ['holes'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const rawHoles = Array.isArray(params.holes) ? params.holes : [];
        const holes = rawHoles.map((value) => {
          const hole = value as Record<string, unknown>;
          return {
            name: typeof hole.name === 'string' ? hole.name : '',
            diameter: hole.diameter as number,
            pcbX: hole.pcbX as number,
            pcbY: hole.pcbY as number,
          };
        });
        const result = await getApi(context).previewMountingHoles({ holes });
        return {
          success: true,
          message: `Previewed ${result.holes.length} unplated circular mounting hole(s). No source was changed; approval ${result.preview.approvalId} is required. Source names are audit labels only because evaluated pcb_hole identity is not stable by name.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.preview_keepouts',
    description:
      'Preview one atomic batch of 1-8 native PCB keep-out geometry additions using unique source/audit names. Supports circles (radius) and axis-aligned rectangles (width/height) at exact finite millimetre centers, with explicit nonempty top/bottom layer sets. Requires one editable direct board, proven rectangular containment, and exact before/after pcb_keepout geometry/layer multiset verification because evaluated names, descriptions, and generated IDs are not stable source identity. No source changes until electronics.resolve_edit_preview applies the approval_id. This does not prove routing enforcement, copper clearance, keep-out DRC, edge clearance, or fabrication validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        keepouts: {
          type: 'array',
          description: 'One to eight circular or axis-aligned rectangular PCB keep-out geometry additions.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Unique source/audit label, e.g. ANTENNA_ZONE. Evaluated pcb_keepout does not preserve this identity.' },
              shape: { type: 'string', enum: ['circle', 'rect'], description: 'Exact supported shape; rectangles are axis-aligned.' },
              pcbX: { type: 'number', description: 'Exact PCB center X coordinate in millimetres.' },
              pcbY: { type: 'number', description: 'Exact PCB center Y coordinate in millimetres.' },
              radius: { type: 'number', description: 'Circle radius in millimetres; required only for circle.' },
              width: { type: 'number', description: 'Rectangle width in millimetres; required only for rect.' },
              height: { type: 'number', description: 'Rectangle height in millimetres; required only for rect.' },
              layers: {
                type: 'array',
                description: 'Explicit nonempty unique layer set. Initial contract supports only top and bottom.',
                items: { type: 'string', enum: ['top', 'bottom'] },
              },
            },
            required: ['name', 'shape', 'pcbX', 'pcbY', 'layers'],
          },
        },
      },
      required: ['keepouts'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const rawKeepouts = Array.isArray(params.keepouts) ? params.keepouts : [];
        const keepouts = rawKeepouts.map((value) => {
          const keepout = value as Record<string, unknown>;
          if (keepout.rotation != null || keepout.pcbRotation != null) {
            throw new Error('Keep-out rotation is unsupported; rectangular keep-outs must be axis-aligned.');
          }
          const common = {
            name: typeof keepout.name === 'string' ? keepout.name : '',
            pcbX: keepout.pcbX as number,
            pcbY: keepout.pcbY as number,
            layers: Array.isArray(keepout.layers) ? keepout.layers as Array<'top' | 'bottom'> : [],
          };
          return keepout.shape === 'circle'
            ? { ...common, shape: 'circle' as const, radius: keepout.radius as number }
            : keepout.shape === 'rect'
              ? { ...common, shape: 'rect' as const, width: keepout.width as number, height: keepout.height as number }
              : { ...common, shape: String(keepout.shape || '') as 'circle', radius: keepout.radius as number };
        });
        const result = await getApi(context).previewKeepouts({ keepouts });
        return {
          success: true,
          message: `Previewed ${result.keepouts.length} exact PCB keep-out shape(s). No source was changed; approval ${result.preview.approvalId} is required. Audit names are source comments only because evaluated pcb_keepout identity is unstable.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.show_pcb_grid',
    description:
      'Show a bounded session-only read-only coordinate lattice clipped to the exact evaluated rectangular PCB board. The global origin is fixed at PCB (0,0); minor, major, and axis lines plus signed major labels are visual evidence only. A new call replaces the active grid. This does not enable snapping, free drag, clearance, routing, DRC, or fabrication validation and never edits or dirties source.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        spacing_mm: { type: 'number', description: 'Minor-line spacing in millimetres from 0.100 to 100.000, with at most three decimal places. Defaults to 2.5.' },
        major_every: { type: 'number', description: 'Integer from 2 to 10: make every Nth line major. Defaults to 4.' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).showPcbGrid({
          ...(params.spacing_mm == null ? {} : { spacingMm: params.spacing_mm as number }),
          ...(params.major_every == null ? {} : { majorEvery: params.major_every as number }),
        });
        return {
          success: true,
          message: `Showing a ${result.spacingMm.toFixed(3)} mm PCB coordinate lattice with major lines every ${result.majorEvery} (${result.majorSpacingMm.toFixed(3)} mm), fixed origin (0,0), ${result.counts.lines} lines, and ${result.counts.labels} labels. Visual evidence only; snapping and dragging remain disabled.`,
          data: {
            ...result,
            sessionOnly: true,
            sourceChanged: false,
            snapEnabled: false,
            dragEnabled: false,
          },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_pcb_grid',
    description:
      'Clear the active session-only read-only PCB coordinate lattice. Idempotent; never edits source, marks the document dirty, or creates save, history, undo, or approval entries.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearPcbGrid();
        return {
          success: true,
          message: result.cleared ? 'Cleared the active PCB coordinate lattice.' : 'No PCB coordinate lattice was active.',
          data: { ...result, sourceChanged: false },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.propose_pcb_routes',
    description:
      'Run exact-pinned @tscircuit/capacity-autorouter 0.0.583 locally in a cancellable inline worker against the freshly evaluated Circuit JSON projection, then show bounded dashed candidate-copper geometry as a session-only overlay. The result is tied to an exact SHA-256 input hash and stale results are refused. It never edits source, persists routes, marks dirty, or creates approvals/history/undo. Candidate geometry is not applied routing, per-net routing truth, clearance/DRC/DFM, fabrication acceptance, manufacturing, or physical validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', description: 'Integer worker timeout from 5000 to 180000 ms. Defaults to 60000.' },
        effort: { type: 'number', description: 'Finite solver effort from 0.1 to 10. Defaults to 1.' },
        min_trace_width: { type: 'number', description: 'Optional finite minimum trace width from 0.05 to 5 mm passed to the Circuit JSON to SimpleRouteJson converter.' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).proposePcbRoutes({
          ...(params.timeout_ms == null ? {} : { timeoutMs: params.timeout_ms as number }),
          ...(params.effort == null ? {} : { effort: params.effort as number }),
          ...(params.min_trace_width == null ? {} : { minTraceWidth: params.min_trace_width as number }),
        });
        const failure = result.diagnostics.join(' ') || 'The pinned local solver reported failure without a diagnostic.';
        return {
          success: result.status === 'solved',
          message: result.status === 'solved'
            ? `${result.traceCount} candidate trace${result.traceCount === 1 ? '' : 's'} proposed for exact projection ${result.inputHash.slice(0, 12)}. The read-only overlay is session-only; nothing was applied or persisted, and no clearance/DRC/DFM claim is made.`
            : `PCB route proposal failed for exact projection ${result.inputHash.slice(0, 12)}: ${failure} No overlay was shown and nothing was applied or persisted.`,
          data: {
            inputHash: result.inputHash,
            traceCount: result.traceCount,
            layerCounts: result.layerCounts,
            solverProgress: result.solverProgress,
            diagnostics: result.diagnostics,
            durationMs: result.durationMs,
            timedOut: false,
            cancelled: false,
            failed: result.status === 'failed' ? failure : false,
            sessionOnly: true,
            sourceChanged: false,
          },
          ...(result.status === 'failed' ? { error: failure } : {}),
        };
      } catch (err) {
        if (err instanceof AutorouteRunError) {
          const timedOut = err.reason === 'timed-out' || err.reason === 'stalled' ? err.message : false;
          const cancelled = err.reason === 'cancelled' ? err.message : false;
          const failed = err.reason === 'worker-failed' ? err.message : false;
          return {
            success: false,
            message: `PCB route proposal did not complete for exact projection ${err.inputHash.slice(0, 12)}: ${err.message} No overlay was shown and nothing was applied or persisted.`,
            error: err.message,
            data: {
              inputHash: err.inputHash,
              traceCount: 0,
              layerCounts: {},
              solverProgress: err.solverProgress,
              diagnostics: [err.message],
              timedOut,
              cancelled,
              failed,
              sessionOnly: true,
              sourceChanged: false,
            },
          };
        }
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_pcb_route_proposal',
    description:
      'Cancel any in-flight local PCB route proposal and clear the active session-only candidate-copper overlay. Idempotent and read-only; never edits source, persists routes, marks dirty, or creates approval, history, or undo entries.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearPcbRouteProposal();
        return {
          success: true,
          message: result.cleared ? 'Cleared the session-only PCB route proposal overlay.' : 'No PCB route proposal overlay was active.',
          data: { ...result, sessionOnly: true, sourceChanged: false },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.show_pcb_rule_lens',
    description:
      `Show one session-only read-only PCB Rule Lens over the exact current evaluation. It compares finite pcb_trace wire-entry widths, pcb_via drill/pad diameters, bounded route-point/via-pad envelopes against a rectangular board edge, same-layer unrounded axis-aligned rectangular/circular SMT-pad spacing, and—only when explicitly authored in loaded project guidance—nominal evaluated circular plated-hole radial annular width. References are this pcb_board's own declarations, the explicitly loaded project guidance rules.pcbScalarMinimums block, or exact dated reviewed profile ${REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID}. The reviewed profile requires explicit FR4/2-layer/1oz/routed assumptions, never fetches at runtime, and deliberately omits trace spacing, different-net SMD-pad spacing, and plated-hole annular ring because this lens cannot prove those profile values. It reports missing/malformed evidence as indeterminate and places bounded coordinate crosses only on proven scalar violations. Edge evidence does not prove intervening joins/segments; pad spacing refuses rounded, rotated, pill, polygon, plated-hole, or other unsupported geometry; annular evidence refuses non-circular plated holes and does not account for drill/plating tolerance. It never scans files, edits source, saves, creates approvals/history/undo, or claims whole-board clearance, impedance, ERC, DRC, DFM, live capability, fab acceptance, manufacturing, or hardware validation.`,
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          enum: ['board-declarations', 'loaded-project-guidance', REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID],
          description: 'Comparison reference. Defaults to board-declarations. loaded-project-guidance requires an explicitly loaded rules.pcbScalarMinimums block. The dated reviewed profile requires exact profile_assumptions and is not fetched or refreshed at runtime.',
        },
        profile_assumptions: {
          type: 'object',
          description: 'Required only for the dated reviewed profile. Explicit caller confirmation, not Circuit JSON proof.',
          properties: {
            material: { type: 'string', enum: ['FR4'] },
            layer_count: { type: 'number', enum: [2] },
            outer_copper_oz: { type: 'number', enum: [1] },
            outline_process: { type: 'string', enum: ['routed'] },
          },
          required: ['material', 'layer_count', 'outer_copper_oz', 'outline_process'],
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (params.reference != null && params.reference !== 'board-declarations' && params.reference !== 'loaded-project-guidance' && params.reference !== REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID) {
          throw new Error(`reference must be board-declarations, loaded-project-guidance, or ${REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID}.`);
        }
        const reference = params.reference === 'loaded-project-guidance'
          ? 'loaded-project-guidance'
          : params.reference === REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID
            ? REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID
            : 'board-declarations';
        const profileAssumptions = reference === REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID
          ? parseReviewedFabProfileAssumptions(params.profile_assumptions)
          : undefined;
        if (reference !== REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID && params.profile_assumptions != null) {
          throw new Error('profile_assumptions is accepted only with the exact reviewed fabrication profile reference.');
        }
        const result = await getApi(context).showPcbRuleLens({ reference, ...(profileAssumptions ? { profileAssumptions } : {}) });
        return {
          success: true,
          message: `PCB Rule Lens ${result.status}: ${result.counts.violations} scalar violation(s), ${result.counts.indeterminate} indeterminate item(s), and ${result.counts.markers} exact marker(s). Reference: ${result.reference.label}. This is not live capability, DRC, or fab acceptance.`,
          data: { ...result, sessionOnly: true, sourceChanged: false, readOnly: true },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_pcb_rule_lens',
    description:
      'Idempotently clear the session-only PCB Rule Lens card and markers. Never edits source, saves, marks dirty, or creates approval, history, or undo entries.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearPcbRuleLens();
        return {
          success: true,
          message: result.cleared ? 'Cleared the PCB Rule Lens.' : 'No PCB Rule Lens was active.',
          data: { ...result, sourceChanged: false, readOnly: true },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.set_pcb_layer_view',
    description:
      'Apply one session-only read-only PCB Layer Lens visibility preference over exact groups present in the current direct-viewer projection. Show, hide, or isolate 1-21 explicit layer ids; absent groups are refused and unknown renderer elements remain visible and reported. Opens the PCB tab and updates only canvas presentation—never source, dirty state, save, approval, history, undo, exports, or Circuit JSON. Groups are not stackup, Gerber, routing, clearance, DRC, DFM, manufacturing, or physical validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['show', 'hide', 'isolate'] },
        layers: {
          type: 'array',
          description: 'Required exact ids. Top/bottom groups cover silkscreen, soldermask, solderpaste, courtyard, keep-outs, and copper; inner1-copper through inner6-copper; plus board-outline, drill, and annotations. Requested groups must exist in the exact current render.',
          items: {
            type: 'string',
            enum: ['top-silkscreen', 'top-soldermask', 'top-solderpaste', 'top-courtyard', 'top-keepouts', 'top-copper', 'inner1-copper', 'inner2-copper', 'inner3-copper', 'inner4-copper', 'inner5-copper', 'inner6-copper', 'bottom-copper', 'bottom-keepouts', 'bottom-courtyard', 'bottom-solderpaste', 'bottom-soldermask', 'bottom-silkscreen', 'board-outline', 'drill', 'annotations'],
          },
        },
      },
      required: ['mode', 'layers'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).setPcbLayerView({
          mode: params.mode as never,
          layers: params.layers as string[],
        });
        return {
          success: true,
          message: `PCB Layer Lens ${result.mode}: ${result.visibleLayerIds.length}/${result.availableLayers.length} exact rendered groups visible and ${result.hiddenLayerIds.length} hidden. Unclassified/structural renderer elements remain visible. This changes session presentation only, not the circuit or exports.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_pcb_layer_view',
    description:
      'Idempotently clear the active session-only PCB Layer Lens and restore every currently rendered controllable group to visible. Never edits source, marks dirty, saves, creates approval/history/undo entries, or changes export output.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearPcbLayerView();
        return {
          success: true,
          message: result.cleared ? 'Cleared PCB Layer Lens and restored all controllable renderer groups.' : 'PCB Layer Lens was already clear.',
          data: { ...result, sessionOnly: true, sourceChanged: false },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.show_connectivity_evidence',
    description:
      'Show one bounded session-only read-only connectivity-evidence snapshot from the freshly evaluated Circuit JSON. Modes can mark exact reviewable source ports absent from every source_trace.connected_source_port_ids and, only when the entire evaluation has zero pcb_trace elements, exact schematic connectivity keys plus proven PCB port-coordinate markers for logical nets. Any PCB trace makes partial routed/unrouted attribution indeterminate because rendered copper lacks stable source-connectivity identity. Replaces prior connectivity evidence; never edits, dirties, saves, or creates approval/history/undo entries. Not ERC, DRC, routing-completeness, continuity, fabrication, or next-message-grounding validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'unconnected_ports', 'globally_unrouted_nets'],
          description: 'Evidence to show. Defaults to all; partial PCB routing is never attributed per net.',
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const mode = (typeof params.mode === 'string' ? params.mode : 'all') as 'all' | 'unconnected_ports' | 'globally_unrouted_nets';
        const result = await getApi(context).showConnectivityEvidence({ mode });
        const routingScope = result.unroutedNetAttribution === 'global-zero-pcb-traces'
          ? `${result.unroutedNets.length} logical net(s) shown because the whole evaluation has zero PCB traces`
          : 'per-net unrouted attribution refused because PCB traces exist and copper identity is insufficient';
        return {
          success: true,
          message: `Showing ${result.unconnectedPorts.length} exact source port(s) absent from source traces; ${routingScope}. ${result.pcbMarkerCount} exact PCB port-coordinate marker(s), never copper or inferred routing.`,
          data: { ...result, sessionOnly: true, sourceChanged: false, readOnly: true },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_connectivity_evidence',
    description:
      'Idempotently clear the active session-only read-only connectivity evidence. Never edits source, marks dirty, saves, flushes, or creates approval, history, or undo entries.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearConnectivityEvidence();
        return {
          success: true,
          message: result.cleared ? 'Cleared the active connectivity evidence.' : 'No connectivity evidence was active.',
          data: { ...result, sourceChanged: false, readOnly: true },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.measure_pcb',
    description:
      'Measure exact evaluated PCB bounding rectangles by case-sensitive exact refs and show one read-only session-only PCB overlay. Modes: center returns signed center dx/dy and Euclidean distance; edge returns the minimum rotation-aware rectangle-edge gap; board returns signed left/right/bottom/top rectangle-to-board-edge gaps (negative means outside). This is not courtyard, package, copper, routing, clearance, collision, DRC, or DFM evidence. A new measurement replaces the active one and never edits or dirties source.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['center', 'edge', 'board'], description: 'Center distance, rectangle-edge gap, or part-to-board-edge gaps.' },
        from_ref: { type: 'string', description: 'Case-sensitive exact evaluated part ref, e.g. U1.' },
        to_ref: { type: 'string', description: 'Case-sensitive exact second part ref; required for center/edge and unsupported for board.' },
      },
      required: ['mode', 'from_ref'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const mode = String(params.mode || '') as 'center' | 'edge' | 'board';
        const result = await getApi(context).measurePcb({
          mode,
          fromRef: String(params.from_ref || ''),
          ...(typeof params.to_ref === 'string' ? { toRef: params.to_ref } : {}),
        });
        const evidence = result.mode === 'center'
          ? `center Δx ${result.dxMm.toFixed(3)} mm, Δy ${result.dyMm.toFixed(3)} mm, distance ${result.distanceMm.toFixed(3)} mm`
          : result.mode === 'edge'
            ? `rectangle-edge gap ${result.distanceMm.toFixed(3)} mm (${result.relation})`
            : `minimum board-edge gap ${result.minimum.clearanceMm.toFixed(3)} mm at ${result.minimum.side} (${result.relation})`;
        return {
          success: true,
          message: `Measured ${evidence}. The session-only read-only PCB overlay is active.`,
          data: { ...result, sessionOnly: true, sourceChanged: false },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.clear_pcb_measurement',
    description:
      'Clear the active session-only read-only PCB measurement overlay. Idempotent; never edits source, marks the document dirty, or creates history/undo/approval entries.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const result = getApi(context).clearPcbMeasurement();
        return {
          success: true,
          message: result.cleared ? 'Cleared the active PCB measurement overlay.' : 'No PCB measurement overlay was active.',
          data: { ...result, sourceChanged: false },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.resolve_edit_preview',
    description:
      'Apply or cancel an exact session-only high-impact edit preview returned by add_block, remove_part, set_board, apply_readiness_action, preview_connection, preview_geometry_change, preview_mounting_holes, or preview_keepouts. Applying succeeds only if the circuit source is unchanged since the preview; stale approvals are rejected so later work cannot be overwritten.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: 'Exact approval_id returned by the previewing tool.' },
        action: { type: 'string', enum: ['apply', 'cancel'], description: 'Apply the reviewed edit or discard it.' },
      },
      required: ['approval_id', 'action'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const approvalId = String(params.approval_id || '').trim();
        const action = params.action === 'cancel' ? 'cancel' : 'apply';
        const result = await getApi(context).resolveEditPreview(approvalId, action);
        return {
          success: true,
          message: result.action === 'applied'
            ? `Applied approved edit: ${result.preview.label}.`
            : `Cancelled proposed edit: ${result.preview.label}.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.transform_part',
    description:
      'Nudge or rotate one named part on the schematic or PCB surface. Deltas use that surface\'s native tscircuit coordinate units; rotation is relative degrees. The change is a named undoable transaction.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Ref designator to transform (e.g. "R1").' },
        surface: { type: 'string', enum: ['schematic', 'pcb'], description: 'Coordinate surface to change.' },
        dx: { type: 'number', description: 'Relative horizontal movement.' },
        dy: { type: 'number', description: 'Relative vertical movement.' },
        rotationDelta: { type: 'number', description: 'Relative clockwise rotation in degrees.' },
      },
      required: ['name', 'surface'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).transformPart(String(params.name || ''), {
          surface: params.surface === 'pcb' ? 'pcb' : 'schematic',
          dx: typeof params.dx === 'number' ? params.dx : undefined,
          dy: typeof params.dy === 'number' ? params.dy : undefined,
          rotationDelta: typeof params.rotationDelta === 'number' ? params.rotationDelta : undefined,
        });
        return {
          success: true,
          message: result.changed.length ? `Transformed ${result.name}: ${result.changed.join(', ')}.` : `${result.name} unchanged.`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.duplicate_part',
    description:
      'Duplicate one named part with a fresh ref designator and offset schematic/PCB placement. Connections are deliberately not copied, so wiring remains explicit and reviewable. Returns the new ref and transaction.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Existing ref designator to duplicate.' },
        newName: { type: 'string', description: 'Optional explicit ref for the copy; auto-assigned if omitted.' },
      },
      required: ['name'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const result = await getApi(context).duplicatePart(
          String(params.name || ''),
          typeof params.newName === 'string' ? params.newName : undefined,
        );
        return { success: true, message: `Duplicated ${result.sourceName} as ${result.name}; connections were not copied.`, data: result };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.undo',
    description:
      'Undo the most recent local Electronics Studio edit transaction, whether it came from an agent tool or the source editor. Returns the transaction that was reversed. Use this to safely back out a mistaken mutation instead of attempting an inverse edit.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const transaction = await getApi(context).undo();
        if (!transaction) return { success: false, error: 'There is no edit transaction to undo in this editor session.' };
        return { success: true, message: `Undid: ${transaction.label}.`, data: { transaction } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.redo',
    description:
      'Reapply the most recently undone Electronics Studio edit transaction. Returns the transaction that was restored.',
    scope: 'editor',
    access: { kind: 'editor-write' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const transaction = await getApi(context).redo();
        if (!transaction) return { success: false, error: 'There is no undone edit transaction to redo in this editor session.' };
        return { success: true, message: `Redid: ${transaction.label}.`, data: { transaction } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.inspect_evaluator_diagnostics',
    description:
      'Inspect exact current Circuit JSON elements whose type ends in _error. Returns bounded native type/message/ID evidence plus only explicit source/PCB identity joins; messages are never parsed to infer parts. Read-only and mutation-free. Absence is not comprehensive ERC, DRC, DFM, fabrication/manufacturing, physical-hardware, or offline validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const { circuitJson, evalError } = await getApi(context).getCircuitJson();
        if (evalError) return { success: false, error: `Current circuit evaluation failed: ${evalError}` };
        const report = inspectEvaluatorDiagnostics(circuitJson);
        return {
          success: true,
          message: report.summary.total === 0
            ? 'No native Circuit JSON *_error elements are present. This is not comprehensive ERC/DRC/DFM validation.'
            : `${report.summary.total} native Circuit JSON diagnostic${report.summary.total === 1 ? '' : 's'} found; ${report.summary.presented} returned and ${report.summary.omitted} omitted by the bounded report.`,
          data: report,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.create_diagnostic_disposition',
    description:
      'Explicitly record one reviewer-authored disposition for one exact current native evaluator diagnostic in deterministic workspace-local JSON plus a completion freshness manifest. Requires an exact diagnostic ID, disposition, reason, and two new canonical paths. It evaluates one copied editor-buffer snapshot, never mutates/saves the circuit, never scans or overwrites, and does not fix, suppress, waive, or validate the diagnostic. Lexical confinement, non-atomic no-clobber, no rollback, unsigned-manifest, and freshness-at-return limitations apply.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        diagnostic_id: { type: 'string', description: 'Exact current ID returned by electronics.inspect_evaluator_diagnostics.' },
        disposition: { type: 'string', enum: ['accepted-risk', 'deferred', 'documented-intent', 'suspected-false-positive'] },
        reason: { type: 'string', description: 'Explicit reviewer-authored reason, at most 2000 UTF-8 bytes.' },
        output_path: { type: 'string', description: 'New canonical workspace-relative *.electronics.diagnostic-disposition.json path; parent must already exist.' },
        manifest_path: { type: 'string', description: 'New distinct canonical workspace-relative *.freshness.json path; parent must already exist.' },
      },
      required: ['diagnostic_id', 'disposition', 'reason', 'output_path', 'manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) return { success: false, error: 'A workspace must be open before creating a diagnostic disposition.' };
        const result = await createDiagnosticDisposition({
          api: getApi(context), fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          diagnosticId: params.diagnostic_id, disposition: params.disposition, reason: params.reason,
          outputPath: params.output_path, manifestPath: params.manifest_path,
        });
        return {
          success: result.status === 'created',
          message: result.status === 'created'
            ? `Created diagnostic disposition ${result.output_path} and completion manifest ${result.manifest_path}; the diagnostic is documented, not fixed or waived.`
            : result.status === 'incomplete'
              ? `Diagnostic disposition emission is incomplete. Automatic cleanup is unavailable; paths that may exist: ${result.cleanup?.pathsThatMayExist.join(', ') || 'unknown'}.`
              : `Diagnostic disposition refused: ${result.refusal?.message ?? 'request was not safe to complete'}`,
          data: result,
          ...(result.status === 'created' ? {} : { error: result.refusal?.message ?? 'Diagnostic disposition was not created.' }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.lint',
    description:
      'Run an electrical-rule check on the open circuit (missing current-limit resistor, missing decoupling cap, unconnected pins, ...). Returns findings with severity so you can decide what to fix.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const { findings, evalError } = await getApi(context).lint();
        return {
          success: true,
          message: `${findings.filter((f) => f.severity !== 'info').length} problem(s)`,
          data: { findings, problemCount: findings.filter((f) => f.severity !== 'info').length, evalError },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.readiness',
    description:
      'Run an explainable design-to-manufacturing preflight on the open circuit. Returns a 0-100 readiness score, checks for connectivity, electrical support components, board outline, PCB geometry/routing, and supplier identification, plus prioritized next actions. This is guidance, not a replacement for final KiCad ERC/DRC or a fab DFM check.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_params, context): Promise<ExtensionToolResult> => {
      try {
        const { report, evalError } = await getApi(context).readiness();
        return {
          success: !evalError,
          message: `${report.score}/100 — ${report.label}. ${report.nextActions[0] ?? 'Ready for a detailed review.'}`,
          data: { ...report, evalError },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.simulate',
    description:
      'Simulate the open circuit and return results so you can reason about behaviour. Modes: "logical" (fast interactive state model), "analog" (ngspice SPICE), and "mcu" (avr8js/rp2040js GPIO, serial, and structured peripheral evidence). "auto" picks from placed parts. MCU runs accept explicit bundled fixture IDs including EEPROM round-trip and watchdog-reset intent, byte-safe firmware input, or the built-in AVR blink when both fixture and firmware are omitted. Watchdog Reset reports one exact avr8js controller reset, firmware-observed MCUSR.WDRF, and D5/D6 latches—not calibrated timeout, brownout/reset-pin/bootloader behavior, startup safety, or hardware reset. Fixture and firmware are mutually exclusive. Returns structured emulator evidence and explicit limitations; controller intent is not external-device, sensor/front-end, fan/motor/load/current, encoder/servo motion, physical switch/contact, buzzer/sound, pixel/light response, safety, ACK, bus/wire waveform, calibrated timing, cable, nonvolatile retention, or hardware behavior.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'Engine to use.',
          enum: ['auto', 'logical', 'analog', 'mcu'],
        },
        mcu: {
          type: 'string',
          description: 'For mode "mcu": which controller family to emulate.',
          enum: ['avr', 'rp2040', 'esp32'],
        },
        firmware: {
          type: 'string',
          description: 'For mode "mcu": inline Intel HEX (AVR), byte-safe base64 (RP2040), or a workspace path only when the host can preserve its text encoding. Mutually exclusive with fixture.',
        },
        fixture: {
          type: 'string',
          description: 'Bundled reviewable firmware fixture. Mutually exclusive with firmware.',
          enum: ['rp2040-launch-beacon', 'avr-pwm-heartbeat', 'avr-servo-pulse-intent', 'avr-timer2-tone-intent', 'avr-spi-pixel-palette', 'avr-adc-threshold', 'avr-adc-pwm-controller-intent', 'avr-i2c-display-intent', 'avr-uart-command-response', 'avr-step-dir-intent', 'avr-limit-interlock-intent', 'avr-quadrature-detent-intent', 'avr-button-debounce-intent', 'avr-neopixel-frame-intent', 'avr-eeprom-roundtrip-intent', 'avr-watchdog-reset-intent', 'avr-int0-interrupt-intent', 'avr-timer1-pulse-counter-intent', 'avr-pcint-mask-intent'],
        },
        duration_ms: {
          type: 'number',
          description: 'How long to simulate, in milliseconds of circuit/firmware time. Bundled firmware fixtures use their registered evidence-backed duration when omitted; other defaults are 1000 (MCU), 100 (logical), and 5 (analog).',
        },
        stimulus: {
          type: 'object',
          description: 'For logical mode: input overrides keyed by ref. AVR ADC accepts {"adc0_voltage":0..5}; UART accepts one exact {"uart0_rx_byte":0..255}; LIMIT accepts {"limit_trip_ms":0.05..1.5}; quadrature accepts {"encoder_direction":1|-1}; button debounce accepts {"button_bounce":0|1}; INT0 accepts {"int0_falling_cycle":500..8000}; Timer1 pulse counter accepts {"timer1_pulse_count":1..8}; PCINT mask accepts {"pcint_profile":0|1}. Other MCU fixtures reject stimulus.',
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const fs = context.extensionContext.services.filesystem;
        const readFile = (p: string) => fs.readFile(resolveAgainstActive(p, context.activeFilePath));
        const result = await api.simulate(
          {
            mode: params.mode as never,
            mcu: params.mcu as never,
            firmware: typeof params.firmware === 'string' ? params.firmware : undefined,
            fixture: typeof params.fixture === 'string' ? params.fixture as never : undefined,
            durationMs: typeof params.duration_ms === 'number' ? params.duration_ms : undefined,
            stimulus: (params.stimulus as Record<string, unknown>) ?? undefined,
          },
          readFile,
        );
        // Traces can be large; summarise rather than dumping every sample.
        const traceSummary = result.traces.map((t) => ({
          name: t.name,
          unit: t.unit,
          samples: t.t.length,
          min: t.v.length ? Math.min(...t.v) : null,
          max: t.v.length ? Math.max(...t.v) : null,
          origin: t.origin,
        }));
        return {
          success: result.ok,
          message: result.ok
            ? `Simulated with ${result.engine}: ${result.traces.length} trace(s), ${result.serial.length} serial line(s).`
            : `Simulation problem (${result.engine}): ${result.error ?? 'unknown'}`,
          data: {
            engine: result.engine,
            mode: result.mode,
            ok: result.ok,
            durationMs: result.durationMs,
            simulatedMs: result.simulatedMs,
            traces: traceSummary,
            serial: result.serial,
            peripheralEvents: result.peripheralEvents?.slice(0, 64),
            peripheralEventsOmitted: (result.peripheralEventsOmitted ?? 0) + Math.max(0, (result.peripheralEvents?.length ?? 0) - 64),
            modeledStimulus: result.modeledStimulus,
            parts: result.parts,
            notes: result.notes,
            firmwareFixture: result.firmwareFixture,
            error: result.error,
          },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.test',
    description:
      'Run firmware on avr8js/rp2040js and assert on serial, GPIO traces, exact transition cycles, exact scheduled GPIO input cycles, SPI/ADC/I2C/UART controller evidence, exact fixture-decoded NeoPixel GRB byte intent, or part state. UART, LIMIT, QUADRATURE, and BUTTON inputs are exact-fixture-only scheduled emulator events; NeoPixel intent is not calibrated protocol timing, an electrical waveform, pixel/light response, or hardware evidence. Returns exact fixture/stimulus provenance plus pass/fail evidence.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        mcu: { type: 'string', description: 'Controller family.', enum: ['avr', 'rp2040', 'esp32'] },
        firmware: { type: 'string', description: 'Inline Intel HEX (AVR), byte-safe base64 (RP2040), or compatible host text path. Omit for built-in AVR blink. Mutually exclusive with fixture.' },
        fixture: { type: 'string', description: 'Bundled firmware fixture.', enum: ['rp2040-launch-beacon', 'avr-pwm-heartbeat', 'avr-servo-pulse-intent', 'avr-timer2-tone-intent', 'avr-spi-pixel-palette', 'avr-adc-threshold', 'avr-adc-pwm-controller-intent', 'avr-i2c-display-intent', 'avr-uart-command-response', 'avr-step-dir-intent', 'avr-limit-interlock-intent', 'avr-quadrature-detent-intent', 'avr-button-debounce-intent', 'avr-neopixel-frame-intent', 'avr-eeprom-roundtrip-intent', 'avr-watchdog-reset-intent', 'avr-int0-interrupt-intent', 'avr-timer1-pulse-counter-intent', 'avr-pcint-mask-intent'] },
        stimulus: { type: 'object', description: 'Exact fixture input: ADC voltage 0..5, UART0 RX byte 0..255, LIMIT trip 0.05..1.5 ms, quadrature direction 1|-1, button bounce 0|1, INT0 falling cycle 500..8000, Timer1 pulse count 1..8, or PCINT profile 0|1.' },
        duration_ms: { type: 'number', description: 'How long to run, in ms of firmware time. Bundled fixtures use their registered evidence-backed duration when omitted; caller-supplied firmware defaults to 2000.' },
        assertions: {
          type: 'array',
          description: 'Behavioural checks to evaluate against the run.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['serial_contains', 'serial_matches', 'serial_line_count', 'pin_toggles', 'pin_frequency', 'pin_duty_cycle', 'pin_final', 'pin_transition_cycles_equals', 'gpio_input_event_cycles_equals', 'spi_tx_equals', 'adc_sample_equals', 'i2c_write_intent_equals', 'uart_tx_equals', 'neopixel_frame_intent_equals', 'eeprom_roundtrip_equals', 'watchdog_reset_equals', 'external_interrupt_equals', 'timer_external_count_equals', 'pin_change_interrupt_equals', 'led_on'],
              },
              target: { type: 'string', description: 'Pin label or ref designator (for pin_*/led_on).' },
              value: { type: 'string', description: 'Legacy expected text for serial/SPI assertions. Prefer typed fields below.' },
              text_value: { type: 'string', description: 'Expected serial substring/regex or canonical SPI hex bytes.' },
              number_value: { type: 'number', description: 'Expected count, frequency, duty, pin state, or raw ADC code.' },
              boolean_value: { type: 'boolean', description: 'Expected LED state.' },
              tolerance: { type: 'number', description: 'Fractional tolerance for pin_frequency (default 0.2).' },
            },
            required: ['type'],
          },
        },
      },
      required: ['assertions'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const fs = context.extensionContext.services.filesystem;
        const readFile = (p: string) => fs.readFile(resolveAgainstActive(p, context.activeFilePath));
        const assertions = normalizeSimulationTestToolAssertions(params.assertions) as never[];
        if (!assertions.length) return { success: false, error: 'Provide at least one assertion.' };
        const report = await api.runTest(
          {
            mcu: params.mcu as never,
            firmware: typeof params.firmware === 'string' ? params.firmware : undefined,
            fixture: typeof params.fixture === 'string' ? params.fixture as never : undefined,
            durationMs: typeof params.duration_ms === 'number' ? params.duration_ms : undefined,
            stimulus: (params.stimulus as Record<string, unknown>) ?? undefined,
          },
          assertions,
          readFile,
        );
        return {
          success: report.pass,
          message: `${report.passed}/${report.passed + report.failed} assertion(s) passed on ${report.engine}${report.pass ? '' : ' -- FAILED'}.`,
          data: report,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.create_simulation_test',
    description:
      'Pin explicit user-chosen assertions for one exact registered bundled fixture as deterministic workspace-local simulation-test JSON plus a completed freshness manifest. It never infers expected assertions from an observed run. Requires new canonical workspace-relative paths, refuses overwrite, does not mutate the circuit, and does not prove physical hardware, calibrated timing, ERC/DRC, manufacturing, KiCad-app, or offline behavior.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short explicit regression name.' },
        fixture: { type: 'string', description: 'Exact bundled fixture observed and explicitly chosen for this regression.', enum: ['rp2040-launch-beacon', 'avr-pwm-heartbeat', 'avr-servo-pulse-intent', 'avr-timer2-tone-intent', 'avr-spi-pixel-palette', 'avr-adc-threshold', 'avr-adc-pwm-controller-intent', 'avr-i2c-display-intent', 'avr-uart-command-response', 'avr-step-dir-intent', 'avr-limit-interlock-intent', 'avr-quadrature-detent-intent', 'avr-button-debounce-intent', 'avr-neopixel-frame-intent', 'avr-eeprom-roundtrip-intent', 'avr-watchdog-reset-intent', 'avr-int0-interrupt-intent', 'avr-timer1-pulse-counter-intent', 'avr-pcint-mask-intent'] },
        stimulus: { type: 'object', description: 'Exact modeled fixture input. Input-driven fixtures persist their strict normalized ADC/UART/LIMIT/quadrature/button/INT0/Timer1/PCINT stimulus.' },
        output_path: { type: 'string', description: 'New canonical workspace-relative *.electronics.simulation-test.json destination; parent must already exist.' },
        manifest_path: { type: 'string', description: 'New distinct canonical workspace-relative *.freshness.json completion manifest; parent must already exist.' },
        duration_ms: { type: 'number', description: 'Integer simulated duration from 1 to 10000; defaults to the fixture evidence duration.' },
        assertions: {
          type: 'array',
          description: 'One to 32 explicit expected checks. The agent must ask for or receive expectations; it must not infer them from a prior run.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['serial_contains', 'serial_matches', 'serial_line_count', 'pin_toggles', 'pin_frequency', 'pin_duty_cycle', 'pin_final', 'pin_transition_cycles_equals', 'gpio_input_event_cycles_equals', 'spi_tx_equals', 'adc_sample_equals', 'i2c_write_intent_equals', 'uart_tx_equals', 'neopixel_frame_intent_equals', 'eeprom_roundtrip_equals', 'watchdog_reset_equals', 'external_interrupt_equals', 'timer_external_count_equals', 'pin_change_interrupt_equals', 'led_on'] },
              target: { type: 'string', description: 'Exact trace name or exact source-component ID/name for pin_*/led_on.' },
              text_value: { type: 'string', description: 'Expected substring/regex, canonical bytes, or strictly increasing cycle:level tokens, depending on assertion type.' },
              number_value: { type: 'number', description: 'Expected count, frequency, or exact 0/1 for numeric checks.' },
              boolean_value: { type: 'boolean', description: 'Expected on/off state for led_on; omitted means true.' },
              tolerance: { type: 'number', description: 'Fractional tolerance for pin_frequency or absolute duty-fraction tolerance for pin_duty_cycle, from 0 to 1.' },
            },
            required: ['type'],
          },
        },
      },
      required: ['name', 'fixture', 'output_path', 'manifest_path', 'assertions'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) return { success: false, error: 'A workspace must be open before creating a workspace-local simulation test.' };
        const result = await createSimulationTestArtifact({
          api: getApi(context),
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          outputPath: params.output_path,
          manifestPath: params.manifest_path,
          name: params.name,
          fixture: params.fixture,
          stimulus: params.stimulus,
          durationMs: params.duration_ms,
          assertions: normalizeSimulationTestToolAssertions(params.assertions),
        });
        return {
          success: result.status === 'created',
          message: result.status === 'created'
            ? `Pinned explicit simulation regression ${result.output_path} with completed manifest ${result.manifest_path}; freshness at return is not guaranteed.`
            : result.status === 'incomplete'
              ? `Simulation-test creation is incomplete. Automatic cleanup is unavailable; paths that may exist: ${result.cleanup?.pathsThatMayExist.join(', ') || 'unknown'}.`
              : `Simulation-test creation refused: ${result.refusal?.message ?? 'request was not safe to complete'}`,
          data: result,
          ...(result.status === 'created' ? {} : { error: result.refusal?.message ?? 'Simulation test was not created.' }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.create_simulation_matrix',
    description:
      'Pin 2–8 ordered, explicit user-confirmed cases for one exact bundled fixture into a deterministic workspace-local simulation-matrix artifact plus completed freshness manifest. It normalizes every case stimulus, validates explicit assertions, refuses duplicate cases and overwrite, and never runs the cases or mutates the circuit. Emulator scenarios are not hardware, waveform, ERC/DRC, PCB, manufacturing, or offline evidence.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short explicit matrix name.' },
        fixture: { type: 'string', description: 'One exact supported bundled fixture for every case.', enum: ['rp2040-launch-beacon', 'avr-pwm-heartbeat', 'avr-servo-pulse-intent', 'avr-timer2-tone-intent', 'avr-spi-pixel-palette', 'avr-adc-threshold', 'avr-adc-pwm-controller-intent', 'avr-i2c-display-intent', 'avr-uart-command-response', 'avr-step-dir-intent', 'avr-limit-interlock-intent', 'avr-quadrature-detent-intent', 'avr-button-debounce-intent', 'avr-neopixel-frame-intent', 'avr-eeprom-roundtrip-intent', 'avr-watchdog-reset-intent', 'avr-int0-interrupt-intent', 'avr-timer1-pulse-counter-intent', 'avr-pcint-mask-intent'] },
        output_path: { type: 'string', description: 'New canonical workspace-relative *.electronics.simulation-matrix.json destination; parent must already exist.' },
        manifest_path: { type: 'string', description: 'New distinct canonical workspace-relative *.freshness.json completion manifest; parent must already exist.' },
        duration_ms: { type: 'number', description: 'Shared integer simulated duration from 1 to 10000; defaults to the fixture evidence duration.' },
        cases: {
          type: 'array',
          description: 'Two to eight ordered cases explicitly confirmed by the user; observed output is never inferred as an expectation.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique canonical lowercase slug, at most 48 characters.' },
              name: { type: 'string', description: 'Bounded human-readable case name.' },
              stimulus: { type: 'object', description: 'Exact fixture-specific modeled input. UART, Limit Interlock, quadrature, and button debounce accept only their documented strict fields.' },
              assertions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['serial_contains', 'serial_matches', 'serial_line_count', 'pin_toggles', 'pin_frequency', 'pin_duty_cycle', 'pin_final', 'pin_transition_cycles_equals', 'gpio_input_event_cycles_equals', 'spi_tx_equals', 'adc_sample_equals', 'i2c_write_intent_equals', 'uart_tx_equals', 'neopixel_frame_intent_equals', 'eeprom_roundtrip_equals', 'watchdog_reset_equals', 'external_interrupt_equals', 'timer_external_count_equals', 'pin_change_interrupt_equals', 'led_on'] },
                    target: { type: 'string', description: 'Exact trace/controller or source-component identity required by the assertion type.' },
                    text_value: { type: 'string', description: 'Expected text, regex, canonical lowercase hex bytes, or strictly increasing cycle:level tokens.' },
                    number_value: { type: 'number', description: 'Expected count, timing measurement, ADC code, or exact pin 0/1.' },
                    boolean_value: { type: 'boolean', description: 'Expected LED state; omitted means true.' },
                    tolerance: { type: 'number', description: 'Only for supported frequency/duty assertions, from 0 to 1.' },
                  },
                  required: ['type'],
                },
              },
            },
            required: ['id', 'name', 'stimulus', 'assertions'],
          },
        },
      },
      required: ['name', 'fixture', 'output_path', 'manifest_path', 'cases'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) return { success: false, error: 'A workspace must be open before creating a workspace-local simulation matrix.' };
        const api = getApi(context);
        api.authorizeSimulationMatrixCreation(typeof params.fixture === 'string' ? params.fixture : '');
        const cases = Array.isArray(params.cases) ? params.cases.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          const record = item as Record<string, unknown>;
          return { ...record, assertions: normalizeSimulationTestToolAssertions(record.assertions) };
        }) : params.cases;
        const result = await createSimulationMatrixArtifact({
          api,
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          outputPath: params.output_path,
          manifestPath: params.manifest_path,
          name: params.name,
          fixture: params.fixture,
          durationMs: params.duration_ms,
          cases,
        });
        return {
          success: result.status === 'created',
          message: result.status === 'created'
            ? `Pinned explicit simulation matrix ${result.output_path} with completed manifest ${result.manifest_path}; no case was run and freshness at return is not guaranteed.`
            : result.status === 'incomplete'
              ? `Simulation-matrix creation is incomplete. Automatic cleanup is unavailable; paths that may exist: ${result.cleanup?.pathsThatMayExist.join(', ') || 'unknown'}.`
              : `Simulation-matrix creation refused: ${result.refusal?.message ?? 'request was not safe to complete'}`,
          data: result,
          ...(result.status === 'created' ? {} : { error: result.refusal?.message ?? 'Simulation matrix was not created.' }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.run_simulation_test',
    description:
      'Run one explicit versioned simulation-test artifact only after its explicit completed freshness manifest matches the exact live editor source, freshly evaluated canonical Circuit JSON, current exporter revision, and unmodified test artifact. Read-only with respect to the design and files; refuses stale, tampered, ambiguous, unsupported, or drifting inputs. Emulator evidence is not physical-board evidence.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        test_path: { type: 'string', description: 'Explicit canonical workspace-relative *.electronics.simulation-test.json path.' },
        manifest_path: { type: 'string', description: 'Explicit canonical workspace-relative *.freshness.json completion-manifest path for exactly that test.' },
      },
      required: ['test_path', 'manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) return { success: false, error: 'A workspace must be open before running a workspace-local simulation test.' };
        const result = await runSimulationTestArtifact({
          api: getApi(context),
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          testPath: params.test_path,
          manifestPath: params.manifest_path,
        });
        return {
          success: result.status === 'passed',
          message: result.status === 'passed'
            ? `Simulation regression passed: ${result.report?.passed}/${(result.report?.passed ?? 0) + (result.report?.failed ?? 0)} explicit assertion(s) on ${result.report?.engine}.`
            : result.status === 'failed'
              ? `Simulation regression failed: ${result.report?.failed} explicit assertion(s) failed on ${result.report?.engine}.`
              : `Simulation regression refused: ${result.refusal?.message ?? 'input was not safe to run'}`,
          data: result,
          ...(result.status === 'passed' ? {} : { error: result.refusal?.message ?? 'Simulation regression did not pass.' }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.run_simulation_matrix',
    description:
      'Run one explicit saved Simulation Matrix from five canonical workspace-relative paths using the bundled no-CDN worker evaluator and a fresh emulator per ordered case. It reads the explicitly named saved circuit file, never an unsaved editor buffer. It verifies the matrix completion manifest, pinned source/projection/fixture provenance, and frozen inputs before and during execution; writes a new deterministic aggregate report then completion manifest; refuses scans, overwrite, baseline updates, stale/tampered/drifting inputs, or inferred paths. Assertion failures still produce a complete report. Emulator evidence is not hardware, waveform, PCB, ERC/DRC, manufacturing, KiCad-app, or offline validation.',
    scope: 'global',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        circuit_path: { type: 'string', description: 'Explicit canonical workspace-relative *.circuit.tsx input path.' },
        matrix_path: { type: 'string', description: 'Explicit canonical workspace-relative *.electronics.simulation-matrix.json input path.' },
        matrix_manifest_path: { type: 'string', description: 'Explicit canonical workspace-relative *.freshness.json completion manifest for exactly that matrix.' },
        report_path: { type: 'string', description: 'New canonical workspace-relative *.electronics.simulation-matrix-report.json destination; parent must already exist.' },
        report_manifest_path: { type: 'string', description: 'New distinct canonical workspace-relative *.freshness.json completion-manifest destination; parent must already exist.' },
      },
      required: ['circuit_path', 'matrix_path', 'matrix_manifest_path', 'report_path', 'report_manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) return { success: false, error: 'A workspace must be open before running a workspace-local Simulation Matrix.' };
        const leased = await withSimulationMatrixRunLease(() => runSimulationMatrixCi({
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath!,
          circuitPath: params.circuit_path,
          matrixPath: params.matrix_path,
          matrixManifestPath: params.matrix_manifest_path,
          reportPath: params.report_path,
          reportManifestPath: params.report_manifest_path,
          evaluate: evalTscircuitCode,
        }));
        if (!leased.acquired) {
          return {
            success: false,
            error: 'A Simulation Matrix run is already in progress in this loaded extension instance. No second run was started. Cross-process atomic no-clobber remains unproven.',
            data: { status: 'refused', exitCode: 2, refusal: { code: 'run-in-progress', message: 'One in-process Simulation Matrix run is already active.' } },
          };
        }
        const result = leased.value;
        const summary = result.status === 'created-passed'
          ? `Simulation Matrix passed and wrote ${result.report_path} plus completed manifest ${result.report_manifest_path}.`
          : result.status === 'created-failed'
            ? `Simulation Matrix completed with assertion failures and wrote the full report ${result.report_path} plus completed manifest ${result.report_manifest_path}. Do not retry the same destinations; inspect this report, then choose new explicit output paths only for an intentional new run.`
            : result.status === 'incomplete'
              ? `Simulation Matrix output is incomplete. Automatic cleanup is unavailable; paths that may exist: ${result.cleanup?.pathsThatMayExist.join(', ') || 'unknown'}.`
              : `Simulation Matrix run refused: ${result.refusal?.message ?? 'request was not safe to complete'}`;
        return {
          success: result.status === 'created-passed',
          message: `${summary} Exit code ${result.exitCode}; freshness at return is not guaranteed.`,
          data: result,
          ...(result.status === 'created-passed' ? {} : { error: result.refusal?.message ?? (result.status === 'created-failed' ? 'One or more explicit assertions failed.' : 'Simulation Matrix did not complete successfully.') }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.check_artifact_freshness',
    description:
      'Read an explicit export freshness manifest and compare it with the exact live editor source, its declared canonical or graph-preserving Circuit JSON fingerprint scheme, current exporter revision, and recorded text artifacts. Read-only: never saves, flushes, rewrites, or validates ERC/DRC, manufacturing correctness, fab acceptance, KiCad application behavior, or physical hardware.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        manifest_path: {
          type: 'string',
          description: 'Explicit absolute path to a *.freshness.json manifest returned by an electronics export tool.',
        },
      },
      required: ['manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const manifestPath = typeof params.manifest_path === 'string' ? params.manifest_path.trim() : '';
        if (!manifestPath) return { success: false, error: 'Provide an explicit manifest_path returned by an export tool.' };
        const api = getApi(context);
        const result = await checkArtifactFreshness({
          fs: context.extensionContext.services.filesystem,
          manifestPath,
          getSource: () => api.getCode(),
          evaluate: () => api.getCircuitJson(),
        });
        return {
          success: true,
          message: result.state === 'fresh'
            ? `Artifacts recorded by ${manifestPath} are fresh.`
            : `Artifact freshness state: ${result.state}. ${result.details.join(' ')}`,
          data: result,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.create_design_review_packet',
    description:
      'Explicitly create one deterministic workspace-local Markdown design-review packet and one completed freshness manifest from one immutable editor-buffer/Circuit JSON snapshot. Requires canonical workspace-relative output_path and manifest_path, never scans, saves, mutates, syncs Advisor state, auto-runs, or offers overwrite-anyway. Confinement is lexical (symlink confinement is unproven), destination preflight is not atomic, partial output can require manual cleanup, and the packet is not ERC/DRC/DFM/fab/manufacturing/KiCad-app/physical/offline validation.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description: 'Required canonical workspace-relative .md destination. Its parent directory must already exist; existing paths are refused.',
        },
        manifest_path: {
          type: 'string',
          description: 'Required distinct canonical workspace-relative .freshness.json completion-manifest destination. Its parent directory must already exist.',
        },
        artifact_manifest_paths: {
          type: 'array',
          description: 'Optional explicit canonical workspace-relative .freshness.json inputs. No discovery or directory scan occurs.',
          items: { type: 'string' },
        },
      },
      required: ['output_path', 'manifest_path'],
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        if (!context.workspacePath) {
          return { success: false, error: 'A workspace must be open before creating a workspace-local design-review packet.' };
        }
        const result = await createDesignReviewPacket({
          api: getApi(context),
          fs: context.extensionContext.services.filesystem,
          workspacePath: context.workspacePath,
          outputPath: params.output_path,
          manifestPath: params.manifest_path,
          artifactManifestPaths: params.artifact_manifest_paths,
        });
        return {
          success: result.status === 'created',
          message: result.status === 'created'
            ? `Created deterministic design-review packet ${result.output_path} and completed manifest ${result.manifest_path}; freshness at return is not guaranteed.`
            : result.status === 'incomplete'
              ? `Design-review packet generation is incomplete. Automatic cleanup is unavailable; paths that may exist: ${result.cleanup?.pathsThatMayExist.join(', ') || 'unknown'}.`
              : `Design-review packet refused: ${result.refusal?.message ?? 'request was not safe to complete'}`,
          data: result,
          ...(result.status === 'created' ? {} : { error: result.refusal?.message ?? 'Design-review packet was not created.' }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_fab',
    description:
      'Generate a manufacturing bundle (Gerber X2 + Excellon drill + BOM + pick-and-place) from the open circuit and write it to a sibling folder. Vendor-agnostic: zip the folder and upload to any fab. Returns the files written and any warnings.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        output_dir: {
          type: 'string',
          description: 'Optional absolute output folder. Defaults to "<circuit-name>-fab" next to the circuit file.',
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const { source, circuitJson, evalError } = await getExportSnapshot(api);
        if (evalError) {
          return { success: false, error: `Cannot export: circuit failed to evaluate (${evalError}).` };
        }
        const activePath = context.activeFilePath || 'circuit.circuit.json';
        const base = baseName(activePath);
        const outDir =
          typeof params.output_dir === 'string' && params.output_dir.trim()
            ? params.output_dir.trim()
            : `${dirOf(activePath)}/${base}-fab`;
        const bundle = await buildFabBundle(circuitJson, base);
        const tracked = await writeExportArtifacts({
          context, api, source, circuitJson, kind: 'fab', options: {},
          manifestPath: manifestPathFor(outDir, base, 'fab'),
          files: Object.entries(bundle.files).map(([relPath, text]) => ({ path: `${outDir}/${relPath}`, text })),
        });
        const written = tracked.files;
        return {
          success: true,
          message: `Exported ${written.length} fab file(s) to ${outDir}.`,
          data: { outputDir: outDir, files: written, manifestPath: tracked.manifestPath, warnings: bundle.warnings },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_kicad',
    description:
      'Export the open circuit as an editable KiCad project (.kicad_pro, .kicad_sch, and .kicad_pcb) for detailed manual routing, ERC/DRC, library work, or professional handoff. Writes a sibling folder by default and returns every generated file plus conversion warnings. Treat the result as a bridge: open it in KiCad and run final ERC/DRC before fabrication.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        output_dir: {
          type: 'string',
          description: 'Optional absolute output folder. Defaults to "<circuit-name>-kicad" next to the circuit file.',
        },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const { source, circuitJson, evalError } = await getExportSnapshot(api);
        if (evalError) return { success: false, error: `Cannot export: circuit failed to evaluate (${evalError}).` };
        const activePath = context.activeFilePath || 'circuit.circuit.json';
        const base = baseName(activePath);
        const outDir = typeof params.output_dir === 'string' && params.output_dir.trim()
          ? params.output_dir.trim()
          : `${dirOf(activePath)}/${base}-kicad`;
        const bundle = await buildKicadProject(circuitJson, base);
        const tracked = await writeExportArtifacts({
          context, api, source, circuitJson, kind: 'kicad', options: {},
          manifestPath: manifestPathFor(outDir, base, 'kicad'),
          files: Object.entries(bundle.files).map(([relativePath, text]) => ({ path: `${outDir}/${relativePath}`, text })),
        });
        const written = tracked.files;
        return {
          success: written.length > 1,
          message: `Exported ${written.length} KiCad handoff file(s) to ${outDir}.`,
          data: { outputDir: outDir, files: written, manifestPath: tracked.manifestPath, warnings: bundle.warnings },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_bom',
    description:
      'Export a standalone bill of materials from the open circuit. Formats: "generic" (vendor-neutral CSV), "jlcpcb" (paired BOM + CPL text using an installed JLC-style template), and "markdown". The JLC-style export reports exact footprint, supplier-number, and placement blockers and never fabricates missing placement at 0,0. It does not prove current vendor acceptance, orientation, assembly, or manufacturing validity. Writes tracked text artifacts and returns exact warnings.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'BOM format.', enum: ['generic', 'jlcpcb', 'markdown'] },
        output_dir: { type: 'string', description: 'Optional absolute output folder. Defaults next to the circuit file.' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const { source, circuitJson, evalError } = await getExportSnapshot(api);
        if (evalError) return { success: false, error: `Cannot export BOM: circuit failed to evaluate (${evalError}).` };
        const activePath = context.activeFilePath || 'circuit.circuit.json';
        const base = baseName(activePath);
        const format = (typeof params.format === 'string' ? params.format : 'generic') as BomFormat;
        const outDir =
          typeof params.output_dir === 'string' && params.output_dir.trim() ? params.output_dir.trim() : dirOf(activePath);
        const bundle = await buildBomBundle(circuitJson, base, format);
        const tracked = await writeExportArtifacts({
          context, api, source, circuitJson, kind: 'bom', options: { format },
          manifestPath: manifestPathFor(outDir, base, 'bom'),
          files: Object.entries(bundle.files).map(([relPath, text]) => ({ path: `${outDir}/${relPath}`, text })),
        });
        const written = tracked.files;
        return {
          success: written.length > 0,
          message: `Exported ${format} BOM (${bundle.lineItems} line item(s)) to ${written.join(', ') || outDir}.`,
          data: {
            format,
            outputDir: outDir,
            files: written,
            manifestPath: tracked.manifestPath,
            lineItems: bundle.lineItems,
            warnings: bundle.warnings,
            ...(bundle.assemblyHandoff ? { assemblyHandoff: bundle.assemblyHandoff } : {}),
          },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_image',
    description:
      'Render the open circuit to standalone SVG files for docs, a README, a datasheet, or a design review. Views: "schematic", "pcb", "assembly" (defaults to schematic + pcb). SVG is scalable and embeds directly in Markdown/HTML; open it in a browser to save a PNG if needed. Writes next to the circuit and returns the files written.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        views: {
          type: 'array',
          description: 'Which views to render. Defaults to ["schematic","pcb"].',
          items: { type: 'string', enum: ['schematic', 'pcb', 'assembly'] },
        },
        output_dir: { type: 'string', description: 'Optional absolute output folder. Defaults next to the circuit file.' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const { source, circuitJson, evalError } = await getExportSnapshot(api);
        if (evalError) return { success: false, error: `Cannot export image: circuit failed to evaluate (${evalError}).` };
        const activePath = context.activeFilePath || 'circuit.circuit.json';
        const base = baseName(activePath);
        const views = (Array.isArray(params.views) && params.views.length
          ? (params.views as string[])
          : ['schematic', 'pcb']) as CircuitView[];
        const outDir =
          typeof params.output_dir === 'string' && params.output_dir.trim() ? params.output_dir.trim() : dirOf(activePath);
        const bundle = await buildImageBundle(circuitJson, base, views);
        const tracked = await writeExportArtifacts({
          context, api, source, circuitJson, kind: 'image', options: { views },
          manifestPath: manifestPathFor(outDir, base, 'image'),
          files: Object.entries(bundle.files).map(([relPath, text]) => ({ path: `${outDir}/${relPath}`, text })),
        });
        const written = tracked.files;
        return {
          success: written.length > 0,
          message: written.length ? `Rendered ${written.length} SVG(s) to ${outDir}.` : 'Nothing to render.',
          data: { outputDir: outDir, files: written, manifestPath: tracked.manifestPath, warnings: bundle.warnings },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_netlist',
    description:
      'Export a portable SPICE netlist (.cir) from the open circuit for analysis in ngspice, LTspice, or any SPICE-compatible tool. Covers the parts SPICE can model (R/L/C, sources, diodes, transistors). Writes next to the circuit and returns the file plus any warnings.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Optional .cir output path. Defaults to "<circuit-name>.cir" next to the circuit.' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const { source, circuitJson, evalError } = await getExportSnapshot(api);
        if (evalError) return { success: false, error: `Cannot export netlist: circuit failed to evaluate (${evalError}).` };
        const activePath = context.activeFilePath || 'circuit.circuit.json';
        const base = baseName(activePath);
        const outPath =
          typeof params.output_path === 'string' && params.output_path.trim()
            ? params.output_path.trim()
            : `${dirOf(activePath)}/${base}.cir`;
        const { netlist, warnings } = await buildSpiceNetlist(circuitJson);
        if (!netlist.trim()) return { success: false, error: warnings[0] ?? 'SPICE export produced no output.' };
        const tracked = await writeExportArtifacts({
          context, api, source, circuitJson, kind: 'netlist', options: {},
          manifestPath: manifestPathFor(dirOf(outPath), baseName(outPath), 'netlist'),
          files: [{ path: outPath, text: netlist }],
        });
        return { success: true, message: `Wrote SPICE netlist to ${outPath}.`, data: { path: outPath, manifestPath: tracked.manifestPath, warnings } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.quote',
    description:
      'Estimate the manufacturing cost of the open board (PCB, and optionally SMT assembly) from its area, layer count, and quantity. Returns a structured cost breakdown so you can advise the user before ordering. This is an offline estimate against prototype (JLCPCB/PCBWay-class) pricing, NOT a live vendor quote -- live quoting/ordering needs vendor credentials and is not automated by this tool.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        quantity: { type: 'number', description: 'Number of boards (default 5).' },
        layers: { type: 'number', description: 'Copper layer count (default 2).' },
        assembly: { type: 'boolean', description: 'Include an SMT assembly cost estimate (default false).' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const { circuitJson, evalError } = await getApi(context).getCircuitJson();
        if (evalError) return { success: false, error: `Cannot quote: circuit failed to evaluate (${evalError}).` };
        const estimate = estimateQuote(circuitJson, {
          quantity: typeof params.quantity === 'number' ? params.quantity : undefined,
          layers: typeof params.layers === 'number' ? params.layers : undefined,
          assembly: params.assembly === true,
        });
        return {
          success: true,
          message: `~$${estimate.total} ${estimate.currency} for ${estimate.quantity} board(s) (${estimate.boardMm.width}x${estimate.boardMm.height}mm, ${estimate.layers}L) -- estimate only.`,
          data: estimate,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'electronics.export_enclosure',
    description:
      'Generate a parametric OpenSCAD (.scad) enclosure sized to the open board -- a two-part box with PCB standoffs and side cutouts at each connector -- and write it next to the circuit. Hands the mechanical side off to the OpenSCAD / three-d extensions (open the .scad there; export STL/STEP for 3D). Returns the file written and any warnings.',
    scope: 'editor',
    access: { kind: 'editor-read' },
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Optional .scad output path. Defaults to "<circuit-name>-enclosure.scad" next to the circuit.' },
        wall: { type: 'number', description: 'Wall thickness in mm (default 2).' },
        standoff_height: { type: 'number', description: 'PCB standoff height in mm (default 4).' },
        lid: { type: 'boolean', description: 'Generate a snap lid alongside the base (default true).' },
      },
    },
    handler: async (params, context): Promise<ExtensionToolResult> => {
      try {
        const api = getApi(context);
        const { source, circuitJson, evalError } = await getExportSnapshot(api);
        if (evalError) return { success: false, error: `Cannot export enclosure: circuit failed to evaluate (${evalError}).` };
        const activePath = context.activeFilePath || 'circuit.circuit.json';
        const base = baseName(activePath);
        const outPath =
          typeof params.output_path === 'string' && params.output_path.trim()
            ? params.output_path.trim()
            : `${dirOf(activePath)}/${base}-enclosure.scad`;
        const { scad, warnings } = generateEnclosureScad(circuitJson, base, {
          wall: typeof params.wall === 'number' ? params.wall : undefined,
          standoffHeight: typeof params.standoff_height === 'number' ? params.standoff_height : undefined,
          lid: params.lid !== false,
        });
        const options = {
          wall: typeof params.wall === 'number' ? params.wall : 2,
          standoffHeight: typeof params.standoff_height === 'number' ? params.standoff_height : 4,
          lid: params.lid !== false,
        };
        const tracked = await writeExportArtifacts({
          context, api, source, circuitJson, kind: 'enclosure', options,
          manifestPath: manifestPathFor(dirOf(outPath), baseName(outPath), 'enclosure'),
          files: [{ path: outPath, text: scad }],
        });
        return {
          success: true,
          message: `Wrote enclosure to ${outPath}. Open it with the OpenSCAD extension; export STL/STEP for three-d.`,
          data: { path: outPath, manifestPath: tracked.manifestPath, warnings },
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
];
