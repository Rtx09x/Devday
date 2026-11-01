/**
 * Opinionated design-readiness report.
 *
 * This is intentionally a fast, explainable preflight over Circuit JSON, not a
 * replacement for a fab's DFM pass or a full KiCad ERC/DRC. The same structured
 * report powers the editor advisor and the agent tool, so both surfaces explain
 * the same risks and recommended next actions.
 */

import type { AnyCircuitElement, LintFinding } from './circuitJson.ts';
import { lintCircuit, listComponents, listNets, reviewableSourcePorts } from './circuitJson.ts';
import { getBoardOutline } from '../fab/board.ts';
import {
  summarizeProjectGuidance,
  type ProjectGuidance,
  type ProjectGuidanceSummary,
} from './projectGuidance.ts';
import type { PartEvidenceReport } from './partEvidence.ts';
import { inspectEvaluatorDiagnostics } from './evaluatorDiagnostics.ts';

export type ReadinessStatus = 'pass' | 'warning' | 'blocked' | 'info';
export type ReadinessCategory = 'requirements' | 'design' | 'electrical' | 'layout' | 'sourcing';

export interface AutomaticDiagnosticAction {
  id: string;
  label: string;
  tool: 'electronics.apply_readiness_action';
  requiresApproval: true;
  parameters: { widthMm: number; heightMm: number };
}

export interface ReadinessCheck {
  id: string;
  category: ReadinessCategory;
  title: string;
  detail: string;
  status: ReadinessStatus;
  /** Score contribution. Informational checks have weight 0. */
  weight: number;
  action?: string;
  /** Present only when the exact current report supports a deterministic edit. */
  automaticAction?: AutomaticDiagnosticAction;
}

export interface ReadinessReport {
  score: number;
  label: 'Needs work' | 'Promising' | 'Ready for review';
  checks: ReadinessCheck[];
  summary: {
    components: number;
    nets: number;
    connectedPins: number;
    totalPins: number;
    boardMm: { width: number; height: number };
    supplierCoverage: number;
  };
  nextActions: string[];
  /** Loaded from an explicit local project guidance file, when the agent syncs it. */
  guidance?: ProjectGuidanceSummary;
  disclaimer: string;
}

function count(elements: AnyCircuitElement[], type: string): number {
  return elements.filter((element) => element.type === type).length;
}

function supplierIdentified(element: AnyCircuitElement): boolean {
  if (typeof element.manufacturer_part_number === 'string' || typeof element.manufacturerPartNumber === 'string') {
    return true;
  }
  const suppliers = element.supplier_part_numbers;
  if (!suppliers || typeof suppliers !== 'object') return false;
  return Object.values(suppliers as Record<string, unknown>).some(
    (value) => Array.isArray(value) && value.some((part) => typeof part === 'string' && part.length > 0),
  );
}

function problemFindings(findings: LintFinding[]): LintFinding[] {
  return findings.filter((finding) => finding.severity === 'error' || finding.severity === 'warning');
}

/** Build a cheap, deterministic preflight report for the current design. */
export function buildReadinessReport(
  elements: AnyCircuitElement[],
  guidance?: ProjectGuidance,
  sourceCode?: string,
  partEvidence?: PartEvidenceReport,
): ReadinessReport {
  const components = listComponents(elements);
  const nets = listNets(elements);
  const findings = lintCircuit(elements);
  const problems = problemFindings(findings);
  const sourceComponents = elements.filter((element) => element.type === 'source_component');
  const sourcePorts = reviewableSourcePorts(elements);
  const reviewablePortIds = new Set(
    sourcePorts
      .map((port) => port.source_port_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const connectedPortIds = new Set<string>();
  for (const trace of elements.filter((element) => element.type === 'source_trace')) {
    const ids = Array.isArray(trace.connected_source_port_ids)
      ? (trace.connected_source_port_ids as unknown[])
      : [];
    for (const id of ids) {
      if (typeof id === 'string' && reviewablePortIds.has(id)) connectedPortIds.add(id);
    }
  }

  // tscircuit emits an auto-sized pcb_board for an unsized JSX <board>. When
  // live TSX source is available, only treat the evaluated board as explicit
  // if both dimensions were actually authored in that source.
  const outline = getBoardOutline(elements, {
    ignoreEvaluatedBoard: sourceCode != null && !sourceHasExplicitBoardSize(sourceCode),
  });
  const pcbComponents = count(elements, 'pcb_component');
  const sourceTraces = count(elements, 'source_trace');
  const pcbTraces = count(elements, 'pcb_trace');
  const identified = partEvidence
    ? partEvidence.summary.evidenced
    : sourceComponents.filter(supplierIdentified).length;
  const supplierCoverage = sourceComponents.length
    ? Math.round((identified / sourceComponents.length) * 100)
    : 0;
  const missingSupportingSources = partEvidence
    ? new Set(partEvidence.parts
        .filter((part) => part.status === 'declared' && part.record)
        .flatMap((part) => (part.sources ?? []).filter((source) => source.state === 'missing').map((source) => source.source))).size
    : 0;
  const checks: ReadinessCheck[] = [];
  const evaluatorDiagnostics = inspectEvaluatorDiagnostics(elements);

  const guidanceSummary = guidance ? summarizeProjectGuidance(guidance) : undefined;
  checks.push(
    guidanceSummary
      ? {
          id: 'project-guidance', category: 'requirements', title: 'Project guidance is loaded',
          detail: `${guidanceSummary.powerSources} power source${guidanceSummary.powerSources === 1 ? '' : 's'}, ${guidanceSummary.interfaces} interface${guidanceSummary.interfaces === 1 ? '' : 's'}, and ${guidanceSummary.traceClasses} trace class${guidanceSummary.traceClasses === 1 ? '' : 'es'} are shared with the agent.`,
          status: 'pass', weight: 0,
        }
      : {
          id: 'project-guidance', category: 'requirements', title: 'Project guidance is not loaded',
          detail: 'Requirements and preferred design rules have not been synced into this editor session.',
          status: 'info', weight: 0,
          action: 'Load a local electronics.project.json file before planning material design changes.',
        },
  );

  checks.push(
    components.length > 0
      ? {
          id: 'design-content', category: 'design', title: 'Circuit has design content',
          detail: `${components.length} component${components.length === 1 ? '' : 's'} evaluated successfully.`,
          status: 'pass', weight: 18,
        }
      : {
          id: 'design-content', category: 'design', title: 'Start the circuit',
          detail: 'No evaluated components are present yet.', status: 'blocked', weight: 18,
          action: 'Add a functional block or choose a part from the library.',
        },
  );

  const diagnosticTypes = evaluatorDiagnostics.summary.byType.slice(0, 6);
  const diagnosticTypeText = diagnosticTypes.map((entry) => `${entry.type} (${entry.count})`).join(', ');
  const omittedDiagnosticTypes = evaluatorDiagnostics.summary.byType.length - diagnosticTypes.length;
  checks.push(
    evaluatorDiagnostics.summary.total === 0
      ? {
          id: 'evaluator-diagnostics', category: 'design', title: 'No native evaluator error elements',
          detail: 'The current Circuit JSON contains no element whose type ends in _error. This is not comprehensive ERC, DRC, DFM, fabrication, or physical validation.',
          status: 'pass', weight: 0,
        }
      : {
          id: 'evaluator-diagnostics', category: 'design',
          title: `${evaluatorDiagnostics.summary.total} native evaluator diagnostic${evaluatorDiagnostics.summary.total === 1 ? '' : 's'} need review`,
          detail: `${diagnosticTypeText}${omittedDiagnosticTypes > 0 ? `; ${omittedDiagnosticTypes} additional presented type${omittedDiagnosticTypes === 1 ? '' : 's'} omitted from this summary` : ''}${evaluatorDiagnostics.summary.otherTypeDiagnostics > 0 ? `; ${evaluatorDiagnostics.summary.otherTypeDiagnostics} diagnostic${evaluatorDiagnostics.summary.otherTypeDiagnostics === 1 ? '' : 's'} across additional types omitted by the report cap` : ''}. These are exact current Circuit JSON error elements, not a comprehensive ERC/DRC/DFM result.`,
          status: 'blocked', weight: 0,
          action: 'Inspect the exact native evaluator diagnostics before relying on this projection or export.',
        },
  );

  const unconnected = Math.max(0, sourcePorts.length - connectedPortIds.size);
  checks.push(
    sourcePorts.length === 0
      ? {
          id: 'connectivity', category: 'electrical', title: 'Connectivity pending',
          detail: 'Add parts to begin checking pins and nets.', status: 'info', weight: 0,
        }
      : unconnected === 0
        ? {
            id: 'connectivity', category: 'electrical', title: 'All pins participate in nets',
            detail: `${connectedPortIds.size} of ${sourcePorts.length} pins are connected.`, status: 'pass', weight: 18,
          }
        : {
            id: 'connectivity', category: 'electrical', title: `${unconnected} pin${unconnected === 1 ? '' : 's'} need review`,
            detail: `${connectedPortIds.size} of ${sourcePorts.length} pins participate in a trace. Intentional NC pins may be ignored.`,
            status: unconnected === sourcePorts.length ? 'blocked' : 'warning', weight: 18,
            action: 'Inspect the Nets tab and connect required power, ground, and signal pins.',
          },
  );

  checks.push(
    problems.length === 0
      ? {
          id: 'erc', category: 'electrical', title: 'Heuristic ERC is clear',
          detail: 'No missing protection or support-component patterns were detected.', status: 'pass', weight: 18,
        }
      : {
          id: 'erc', category: 'electrical', title: `${problems.length} electrical recommendation${problems.length === 1 ? '' : 's'}`,
          detail: problems.map((finding) => finding.message).join(' '), status: 'warning', weight: 18,
          action: 'Review the Issues tab and add the recommended support components.',
        },
  );

  checks.push(
    outline.source === 'explicit'
      ? {
          id: 'outline', category: 'layout', title: 'Board outline is explicit',
          detail: `${round(outline.width)} × ${round(outline.height)} mm board.`, status: 'pass', weight: 14,
        }
      : {
        id: 'outline', category: 'layout', title: 'Board outline is inferred',
        detail: `Using an estimated ${round(outline.width)} × ${round(outline.height)} mm envelope.`, status: 'warning', weight: 14,
        action: 'Set explicit board width and height before manufacturing.',
        ...(outline.source === 'geometry' ? {
          automaticAction: {
            id: 'outline.make-explicit-from-geometry',
            label: 'Make the geometry-derived board outline explicit',
            tool: 'electronics.apply_readiness_action' as const,
            requiresApproval: true as const,
            parameters: { widthMm: round(outline.width), heightMm: round(outline.height) },
          },
        } : {}),
      },
  );

  checks.push(
    components.length > 0 && pcbComponents >= components.length
      ? {
          id: 'footprints', category: 'layout', title: 'Every component has PCB geometry',
          detail: `${pcbComponents} PCB component${pcbComponents === 1 ? '' : 's'} generated.`, status: 'pass', weight: 16,
        }
      : {
          id: 'footprints', category: 'layout', title: 'PCB geometry is incomplete',
          detail: `${pcbComponents} PCB components generated for ${components.length} source components.`,
          status: components.length === 0 ? 'info' : 'blocked', weight: components.length === 0 ? 0 : 16,
          action: 'Assign a footprint to every physical component.',
        },
  );

  checks.push(
    sourceTraces === 0
      ? {
          id: 'routing', category: 'layout', title: 'Routing begins after wiring',
          detail: 'No source traces exist yet.', status: 'info', weight: 0,
        }
      : pcbTraces > 0
        ? {
            id: 'routing', category: 'layout', title: 'PCB traces were generated',
            detail: `${pcbTraces} routed PCB trace${pcbTraces === 1 ? '' : 's'} for ${sourceTraces} logical connection${sourceTraces === 1 ? '' : 's'}.`,
            status: 'pass', weight: 8,
          }
        : {
            id: 'routing', category: 'layout', title: 'Logical nets are not routed',
            detail: `${sourceTraces} logical connection${sourceTraces === 1 ? '' : 's'} exist, but no PCB traces were generated.`,
            status: 'warning', weight: 8, action: 'Review the PCB view and route the remaining nets.',
          },
  );

  checks.push(
    sourceComponents.length === 0
      ? {
          id: 'sourcing', category: 'sourcing', title: 'BOM intelligence pending',
          detail: 'Supplier coverage appears after parts are added.', status: 'info', weight: 0,
        }
      : partEvidence && partEvidence.summary.conflict > 0
        ? {
            id: 'sourcing', category: 'sourcing', title: `${partEvidence.summary.conflict} local part record conflict${partEvidence.summary.conflict === 1 ? '' : 's'}`,
            detail: `${partEvidence.summary.evidenced} of ${sourceComponents.length} placed parts are backed by exact local records with agreeing footprints. Resolve every local-record conflict before relying on this evidence.`,
            status: 'blocked', weight: 8,
            action: 'Review the placed MPN/footprint against electronics.parts.json; do not guess which value is correct.',
          }
        : partEvidence && missingSupportingSources > 0
          ? {
              id: 'sourcing', category: 'sourcing', title: `${missingSupportingSources} referenced local source path${missingSupportingSources === 1 ? ' is' : 's are'} missing`,
              detail: `${partEvidence.summary.evidenced} of ${sourceComponents.length} placed parts have exact matching records whose referenced paths are all present. Missing paths leave the matching identifiers declared only; no source contents were read or verified.`,
              status: 'blocked', weight: 8,
              action: 'Restore or correct each missing project-relative evidence source, then run the part evidence report again.',
            }
        : partEvidence && partEvidence.summary.evidenced === sourceComponents.length
          ? {
              id: 'sourcing', category: 'sourcing', title: 'All placed parts have local evidence',
              detail: `All ${sourceComponents.length} placed parts match exact local MPN records and agreeing footprints, and every referenced path is present. Source contents were not read, validated, hashed, authenticated, or verified.`,
              status: 'pass', weight: 8,
            }
          : partEvidence
            ? {
                id: 'sourcing', category: 'sourcing', title: `${supplierCoverage}% locally evidenced`,
                detail: `${partEvidence.summary.evidenced} of ${sourceComponents.length} placed parts are backed by exact local records; ${partEvidence.summary.declared} are declared only and ${partEvidence.summary.incomplete} are incomplete.`,
                status: 'warning', weight: 8,
                action: partEvidence.evidenceFile.state === 'missing'
                  ? 'Review and add a project-local electronics.parts.json file, then run the part evidence report again.'
                  : 'Add or correct reviewed local records without inferring supplier or footprint data.',
              }
      : supplierCoverage === 100
        ? {
            id: 'sourcing', category: 'sourcing', title: 'BOM parts are identifiable',
            detail: `All ${sourceComponents.length} components include a manufacturer or supplier part number.`,
            status: 'pass', weight: 8,
          }
        : {
            id: 'sourcing', category: 'sourcing', title: `${supplierCoverage}% supplier coverage`,
            detail: `${identified} of ${sourceComponents.length} components include a manufacturer or supplier part number.`,
            status: 'warning', weight: 8,
            action: 'Choose orderable parts or record preferred supplier alternatives before assembly.',
          },
  );

  const weighted = checks.filter((check) => check.weight > 0);
  const earned = weighted.reduce((sum, check) => {
    const factor = check.status === 'pass' ? 1 : check.status === 'warning' ? 0.45 : 0;
    return sum + check.weight * factor;
  }, 0);
  const possible = weighted.reduce((sum, check) => sum + check.weight, 0);
  // An empty design cannot be "promising" merely because no heuristic rules
  // fired and a default outline exists. Keep the detailed checks visible, but
  // gate the aggregate score on actual evaluated design content.
  const score = components.length > 0 && possible ? Math.round((earned / possible) * 100) : 0;
  const nextActions = checks
    .filter((check) => check.status === 'blocked' || check.status === 'warning')
    .map((check) => check.action)
    .filter((action): action is string => Boolean(action))
    .slice(0, 4);

  return {
    score,
    label: score >= 82 ? 'Ready for review' : score >= 55 ? 'Promising' : 'Needs work',
    checks,
    summary: {
      components: components.length,
      nets: nets.length,
      connectedPins: connectedPortIds.size,
      totalPins: sourcePorts.length,
      boardMm: { width: round(outline.width), height: round(outline.height) },
      supplierCoverage,
    },
    nextActions,
    ...(guidanceSummary ? { guidance: guidanceSummary } : {}),
    disclaimer: 'Preflight guidance only. Run a full ERC/DRC and your manufacturer\'s DFM checks before fabrication.',
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function sourceHasExplicitBoardSize(code: string): boolean {
  const board = /<board\b[^>]*?>/.exec(code)?.[0];
  return Boolean(board && /\bwidth\s*=/.test(board) && /\bheight\s*=/.test(board));
}
