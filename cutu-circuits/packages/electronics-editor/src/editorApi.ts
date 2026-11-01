/**
 * The imperative API the editor exposes to AI tools.
 *
 * The editor registers an instance via `host.registerEditorAPI(api)`; AI tool
 * handlers receive it as `context.editorAPI`. Mutating methods edit the live
 * editor (so the canvas updates immediately) and mark the document dirty;
 * read methods return a freshly-derived view of the circuit.
 */

import type { AnyCircuitElement, NetSummary, LintFinding, ComponentSummary } from './circuit/circuitJson';
import type { ReadinessReport } from './circuit/readiness';
import type { SimRequest, SimResult } from './sim/types';
import type { Assertion, TestReport } from './sim/testHarness';
import type { EditHistorySnapshot, EditTransactionSummary } from './circuit/editHistory';
import type { PendingEditPreview } from './circuit/editApproval';
import type { ProjectGuidance } from './circuit/projectGuidance';
import type { PartEvidenceReport } from './circuit/partEvidence';
import type { PartEvidenceReportBinding } from './circuit/partEvidenceAgent';
import type { PartEvidenceCandidateRequest } from './circuit/partEvidenceContribution';
import type { OUTLINE_READINESS_ACTION_ID } from './circuit/readinessActions';
import type { GeometryChangeRequest } from './circuit/pcbGeometry';
import type { PcbMeasurementRequest, PcbMeasurementResult } from './circuit/pcbMeasurement';
import type { PcbGridRequest, PcbGridResult } from './circuit/pcbGrid';
import type { PcbRouteProposalResult } from './circuit/pcbRouteProposal';
import type { AutorouteRequestOptions } from './tscircuit/AutorouteRunner';
import type { PcbRuleLensRequest, PcbRuleLensResult } from './circuit/pcbRuleLens';
import type { PcbLayerViewRequest, PcbLayerViewResult } from './circuit/pcbLayerView';
import type { PartTrustSpotlightRequest, PartTrustSpotlightResult } from './circuit/partTrustSpotlight';
import type { AssemblyHandoffSpotlightRequest, AssemblyHandoffSpotlightResult } from './circuit/assemblyHandoffSpotlight';
import type { ConnectivityEvidenceRequest, ConnectivityEvidenceResult } from './circuit/connectivityEvidence';
import type { MountingHoleRequest } from './circuit/pcbMountingHoles';
import type { KeepoutRequest } from './circuit/pcbKeepouts';
import type { ProjectTemplateRequirements } from './circuit/projectTemplates';
import type { ConnectionPreviewRequest, ResolvedConnectionEndpoint } from './circuit/connectionPreview';
import type { AssemblyMetadataBatchPreviewMetadata, AssemblyMetadataBatchRequest, AssemblyMetadataPreviewRequest, AssemblyMetadataPreviewMetadata } from './circuit/assemblyMetadataPreview';

export interface DesignReviewSnapshot {
  source: string;
  sourceOrigin: 'editor-buffer';
  persistenceState: 'unknown';
  circuitJson: AnyCircuitElement[];
  evalError?: string;
  loadedProjectGuidance?: ProjectGuidance;
  loadedPartEvidence?: PartEvidenceReport;
}

export interface TransactionResult {
  transaction?: EditTransactionSummary;
}

export interface PreviewRequiredResult {
  applied: false;
  requiresApproval: true;
  preview: PendingEditPreview;
}

export interface ElectronicsEditorAPI {
  /** 'tsx' (tscircuit code, editable) or 'json' (raw Circuit JSON, render-only). */
  getKind(): 'tsx' | 'json';
  /** Current document source text. */
  getCode(): string;
  /** Freshly derive Circuit JSON: evaluate `.tsx` (worker) or parse `.json`. */
  getCircuitJson(): Promise<{ circuitJson: AnyCircuitElement[]; evalError?: string }>;
  /** Copy and evaluate one exact editor-buffer source once, plus copied loaded session state. */
  captureDesignReviewSnapshot(): Promise<DesignReviewSnapshot>;
  /** Components + nets, freshly derived. */
  inspect(): Promise<{ components: ComponentSummary[]; nets: NetSummary[]; evalError?: string }>;
  /** Electrical-rule findings, freshly derived. */
  lint(): Promise<{ findings: LintFinding[]; evalError?: string }>;
  /** Explainable design/manufacturing preflight, freshly derived. */
  readiness(): Promise<{ report: ReadinessReport; evalError?: string }>;
  /** Share an explicitly loaded local requirements/rules file with the advisor. */
  setProjectGuidance(guidance: ProjectGuidance | undefined): void;
  /** Stage a deterministic complete project template only over a proven blank editable TSX document. */
  proposeProjectTemplate(requirements: ProjectTemplateRequirements): Promise<{
    templateId: ProjectTemplateRequirements['templateId'];
    requirements: ProjectTemplateRequirements;
    expectedRefs: string[];
    limitations: string[];
  } & PreviewRequiredResult>;
  /** Share one explicitly loaded, session-only local part evidence report with the advisor. */
  setPartEvidenceReport(report: PartEvidenceReport | undefined, binding: PartEvidenceReportBinding): void;
  /** Consume the selected-part Validate record grant; direct calls outside a selected-part session remain exact-tool validated. */
  authorizePartEvidenceCandidate(request: Pick<PartEvidenceCandidateRequest, 'sourceComponentId' | 'ref'>): void;
  /** Consume the selected-part Create contribution grant; direct calls outside a selected-part session remain exact-tool validated. */
  authorizePartEvidenceDraft(request: Pick<PartEvidenceCandidateRequest, 'sourceComponentId' | 'ref'>): void;
  /** Consume the exact fixture-bound Scenario matrix grant; direct tool calls remain artifact-validated. */
  authorizeSimulationMatrixCreation(fixture: string): void;
  /** Consume the exact sourcing-row strict assembly-export grant; direct tool calls remain export-validated. */
  authorizeAssemblyHandoffExport(): void;
  /** Add a catalog part (tsx only). Returns the assigned ref designator. */
  addPart(partKey: string, name?: string): Promise<{ name: string; part: string } & TransactionResult>;
  /** Add a reusable, internally-wired functional block (tsx only). */
  addBlock(blockKey: string): Promise<{
    block: string;
    parts: Array<{ key: string; name: string }>;
    connections: Array<{ from: string; to: string }>;
  } & PreviewRequiredResult>;
  /** Wire two tscircuit selectors with a <trace> (tsx only). */
  connect(from: string, to: string): Promise<TransactionResult>;
  /** Stage one exact source-level connection without changing source until approval. */
  previewConnection(request: ConnectionPreviewRequest): Promise<{
    from: ResolvedConnectionEndpoint;
    to: ResolvedConnectionEndpoint;
  } & PreviewRequiredResult>;
  /** Stage missing footprint and/or LCSC metadata for one exact placed part. */
  previewAssemblyMetadata(request: AssemblyMetadataPreviewRequest): Promise<{
    metadata: AssemblyMetadataPreviewMetadata;
  } & PreviewRequiredResult>;
  /** Stage an atomic bounded queue of missing assembly metadata updates. */
  previewAssemblyMetadataBatch(request: AssemblyMetadataBatchRequest): Promise<{
    metadata: AssemblyMetadataBatchPreviewMetadata;
  } & PreviewRequiredResult>;
  /** Remove a named part and every trace referencing it (tsx only). */
  removePart(name: string): Promise<{ name: string; removedTraces: number } & PreviewRequiredResult>;
  /** Remove a <trace> matching the endpoints, order-insensitive (tsx only). */
  removeConnection(from: string, to: string): Promise<TransactionResult>;
  /** Change value/footprint/manufacturerPartNumber of a named part (tsx only). */
  updatePart(
    name: string,
    changes: { value?: string; footprint?: string; manufacturerPartNumber?: string },
  ): Promise<{ name: string; changed: string[] } & TransactionResult>;
  /** Nudge or rotate a part on the schematic or PCB surface (tsx only). */
  transformPart(
    name: string,
    options: { surface: 'schematic' | 'pcb'; dx?: number; dy?: number; rotationDelta?: number },
  ): Promise<{ name: string; changed: string[] } & TransactionResult>;
  /** Duplicate a part with a fresh ref and offset placement; does not copy traces. */
  duplicatePart(name: string, requestedName?: string): Promise<{ sourceName: string; name: string } & TransactionResult>;
  /** Set the board outline size (tsx only). */
  setBoard(opts: { width?: string; height?: string }): Promise<{ changed: true } & PreviewRequiredResult>;
  /** Stage absolute PCB placements and optional rectangular board dimensions as one evaluated proposal. */
  previewGeometryChange(request: GeometryChangeRequest): Promise<{
    targets: string[];
  } & PreviewRequiredResult>;
  /** Stage a bounded batch of unplated circular mechanical holes as one evaluated proposal. */
  previewMountingHoles(request: MountingHoleRequest): Promise<{
    holes: MountingHoleRequest['holes'];
  } & PreviewRequiredResult>;
  /** Stage bounded circular/axis-aligned rectangular keep-out geometry as one evaluated proposal. */
  previewKeepouts(request: KeepoutRequest): Promise<{
    keepouts: KeepoutRequest['keepouts'];
  } & PreviewRequiredResult>;
  /** Measure exact evaluated PCB rectangles and show one session-only read-only overlay. */
  measurePcb(request: PcbMeasurementRequest): Promise<PcbMeasurementResult>;
  /** Clear the active session-only PCB measurement, if any. */
  clearPcbMeasurement(): { cleared: boolean };
  /** Show a bounded session-only lattice in exact evaluated PCB coordinates. */
  showPcbGrid(request: PcbGridRequest): Promise<PcbGridResult>;
  /** Clear the active session-only PCB coordinate lattice, if any. */
  clearPcbGrid(): { cleared: boolean };
  /** Compute candidate copper in a worker and show a session-only read-only overlay for the exact projection. */
  proposePcbRoutes(options?: AutorouteRequestOptions): Promise<PcbRouteProposalResult>;
  /** Cancel any in-flight proposal and clear the active session-only candidate-copper overlay. */
  clearPcbRouteProposal(): { cleared: boolean };
  /** Compare evaluated trace/via scalar geometry with board declarations or explicit loaded guidance minima. */
  showPcbRuleLens(request?: PcbRuleLensRequest): Promise<PcbRuleLensResult>;
  /** Clear the active session-only PCB Rule Lens, if any. */
  clearPcbRuleLens(): { cleared: boolean };
  /** Apply one session-only PCB renderer-layer visibility preference. */
  setPcbLayerView(request: PcbLayerViewRequest): Promise<PcbLayerViewResult>;
  /** Reset every PCB renderer layer group to visible and clear the agent-view card. */
  clearPcbLayerView(): { cleared: boolean };
  /** Highlight exact placed parts by status from the attached session-only evidence report. */
  showPartTrustSpotlight(request: PartTrustSpotlightRequest): Promise<PartTrustSpotlightResult>;
  /** Clear the active session-only part trust highlight. */
  clearPartTrustSpotlight(): { cleared: boolean };
  /** Highlight exact current assembly-template completeness on schematic and PCB. */
  showAssemblyHandoffSpotlight(request: AssemblyHandoffSpotlightRequest): Promise<AssemblyHandoffSpotlightResult>;
  /** Clear the active session-only Assembly Scout highlight. */
  clearAssemblyHandoffSpotlight(): { cleared: boolean };
  /** Show exact, bounded, session-only source-connectivity evidence without mutating the circuit. */
  showConnectivityEvidence(request: ConnectivityEvidenceRequest): Promise<ConnectivityEvidenceResult>;
  /** Clear the active session-only connectivity evidence, if any. */
  clearConnectivityEvidence(): { cleared: boolean };
  /** Stage a deterministic action advertised by the exact current readiness report. */
  applyReadinessAction(actionId: string): Promise<{
    diagnostic: 'readiness';
    diagnosticId: 'outline';
    actionId: typeof OUTLINE_READINESS_ACTION_ID;
    dimensions: { widthMm: number; heightMm: number };
  } & PreviewRequiredResult>;
  /** Apply or cancel an exact session-only preview produced by a high-impact agent edit. */
  resolveEditPreview(
    approvalId: string,
    action: 'apply' | 'cancel',
  ): Promise<{ action: 'applied' | 'cancelled'; preview: PendingEditPreview; transaction?: EditTransactionSummary }>;
  /** Host receipt summaries for this editor session; durable history remains in CutuCircuits. */
  getEditHistory(): EditHistorySnapshot;
  /** Undo the most recently applied human or agent transaction. */
  undo(): Promise<EditTransactionSummary | undefined>;
  /** Reapply the most recently undone transaction. */
  redo(): Promise<EditTransactionSummary | undefined>;
  /**
   * Run a simulation (logical / analog ngspice / MCU firmware) against the live
   * circuit and return the uniform result. `readFile` lets the caller resolve a
   * firmware path through the host filesystem (the AI tool injects it).
   */
  simulate(req: SimRequest, readFile?: (path: string) => Promise<string>): Promise<SimResult>;
  /**
   * Run firmware against the live circuit and evaluate behavioural assertions
   * (serial output, GPIO traces, part state). Returns a pass/fail report.
   */
  runTest(
    req: SimRequest,
    assertions: Assertion[],
    readFile?: (path: string) => Promise<string>,
  ): Promise<TestReport>;
}
