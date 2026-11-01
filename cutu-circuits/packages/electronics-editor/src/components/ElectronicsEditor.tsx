/** Electronics Studio: agent-operable circuit design cockpit. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '@cutucircuits/ui/button';
import Menu, { MenuItem } from '@cutucircuits/ui/menu';
import Tooltip from '@cutucircuits/ui/tooltip';
import type { EditorContextItem, EditorHost, ProjectFileChange } from '@cutucircuits/editor-host';
import type { ManualEditEvent } from '@tscircuit/props';
import { PcbLayersPanel, type PcbLayerDefinition } from './CircuitViews';
import { PartAgentRequestCard, PartsPalette, TemplateAgentRequestCard } from './PartsPalette';
import { SimulationPanel } from './SimulationPanel';
import { DesignAdvisor } from './DesignAdvisor';
import { AgentRequestCard } from './AgentRequestCard';
import { BomPanel } from './BomPanel';
import { TscircuitPcbPane } from './TscircuitPcbPane';
import { TscircuitSchematicPane } from './TscircuitSchematicPane';
import { TscircuitAssemblyDirectPane } from './TscircuitAssemblyDirectPane';
import { Tscircuit3dPane } from './Tscircuit3dPane';
import {
  parseCircuitJson,
  parseCircuitJsonProjection,
  lintCircuit,
  listNets,
  listComponents,
  hasPcbElements,
  type AnyCircuitElement,
  type ComponentSummary,
  type LintFinding,
  type NetSummary,
} from '../circuit/circuitJson';
import { buildReadinessReport, type ReadinessCheck } from '../circuit/readiness';
import { buildReadinessActionEdit } from '../circuit/readinessActions';
import { evalTscircuitCode, evalTscircuitProject } from '../circuit/evalCode';
import { createEvaluationCache } from '../circuit/evaluationCache';
import {
  ensureManualEditsBinding,
  manualEditsPathForCircuit,
  parseManualEdits,
} from '../tscircuit/manualEdits';
import {
  commitManualEditEvents,
  ensureManualEditsProject,
  hasHostProjectFiles,
} from '../tscircuit/manualEditTransactions';
import { runUpstreamCircuitChecks } from '../tscircuit/CircuitCheckRunner';
import { simulate } from '../sim/simulate';
import { deriveCanvasFeedback } from '../sim/canvasFeedback';
import type { SimResult } from '../sim/types';
import { buildSimulationAgentSnapshot, type SimulationAgentSnapshot } from '../sim/simulationAgent';
import {
  consumeSimulationMatrixAgentGrant,
  createSimulationMatrixAgentGrant,
  type SimulationMatrixAgentGrant,
} from '../sim/simulationMatrixArtifact';
import { runFirmwareTest } from '../sim/testHarness';
import {
  insertIntoBoard,
  buildTrace,
  findPart,
  nextRefDesignator,
  prefixForPart,
  nextPlacement,
  removePartFromCode,
  removeConnectionFromCode,
  updatePartInCode,
  transformPartInCode,
  duplicatePartInCode,
  setBoardSizeInCode,
  applyAbsoluteGeometryInCode,
} from '../circuit/tscircuitCode';
import { insertFunctionalBlock } from '../circuit/functionalBlocks';
import { EditHistory, summarizeSourceChange, type EditDescriptor, type EditTransactionSummary } from '../circuit/editHistory';
import {
  buildVisualEditDiff,
  EditApprovalQueue,
  type PendingEditPreview,
} from '../circuit/editApproval';
import {
  canUndoRevealedTransaction,
  createPendingAgentChangeReveal,
  readinessContextKey,
  settleAgentChangeReveal,
  type AgentChangeReveal,
} from '../circuit/agentChangeReveal';
import type { ElectronicsEditorAPI } from '../editorApi';
import type { ProjectGuidance } from '../circuit/projectGuidance';
import type { PartEvidenceReport } from '../circuit/partEvidence';
import { buildPartTrustSpotlight, type ActivePartTrustSpotlight } from '../circuit/partTrustSpotlight';
import {
  buildAssemblyHandoffSpotlight,
  type ActiveAssemblyHandoffSpotlight,
} from '../circuit/assemblyHandoffSpotlight';
import { buildAssemblyHandoffReport } from '../circuit/assemblyHandoff';
import { buildBomProjection } from '../circuit/bomProjection';
import {
  beginPartEvidenceSessionRefresh,
  buildDefaultPartEvidenceBootstrapSnapshot,
  buildSelectedPartEvidenceSnapshot,
  createPartEvidenceSessionGrant,
  validatePartEvidenceSessionReport,
  type PartEvidenceSessionGrant,
  type PartEvidenceReportBinding,
} from '../circuit/partEvidenceAgent';
import {
  createPartEvidenceCandidateGrant,
  validatePartEvidenceCandidateGrant,
  type PartEvidenceCandidateGrant,
} from '../circuit/partEvidenceContribution';
import { buildGeometryPreview, validateGeometryChangeRequest, type GeometryChangeRequest } from '../circuit/pcbGeometry';
import { measurePcb, type ActivePcbMeasurement } from '../circuit/pcbMeasurement';
import { buildPcbGrid, type ActivePcbGrid } from '../circuit/pcbGrid';
import {
  buildPcbRouteProposal,
  PCB_ROUTE_PROPOSAL_LIMITATION,
  type ActivePcbRouteProposal,
} from '../circuit/pcbRouteProposal';
import { hashCircuitJson, runPcbAutorouter } from '../tscircuit/AutorouteRunner';
import { buildPcbRuleLens, type ActivePcbRuleLens } from '../circuit/pcbRuleLens';
import { getReviewedFabProfile, REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID } from '../circuit/fabProfiles';
import { buildPcbLayerInventory, resolvePcbLayerView, type PcbLayerViewResult } from '../circuit/pcbLayerView';
import {
  buildConnectivityEvidence,
  type ActiveConnectivityEvidence,
} from '../circuit/connectivityEvidence';
import {
  appendAdvisorAffectedGeometryContext,
  buildEvaluatorDiagnosticBeaconStory,
  buildNetDetectiveStory,
  deriveAdvisorAffectedGeometry,
  isAdvisorAffectedGeometryTarget,
  visibleAdvisorAffectedGeometry,
} from '../circuit/advisorAffectedGeometry';
import {
  consumeAdvisorConnectionGrantRequest,
  createAdvisorConnectionGrant,
  getAdvisorConnectionEligibility,
  validateAdvisorConnectionProposal,
  type AdvisorConnectionGrant,
} from '../circuit/advisorConnection';
import {
  buildMountingHolePreview,
  insertMountingHolesInCode,
  type MountingHoleRequest,
} from '../circuit/pcbMountingHoles';
import {
  buildKeepoutPreview,
  insertKeepoutsInCode,
  type KeepoutRequest,
} from '../circuit/pcbKeepouts';
import {
  buildConnectionPreview,
  assertConnectionPreviewProjectionFresh,
  insertConnectionInCode,
  resolveConnectionProposal,
  type ConnectionPreviewRequest,
  type ResolvedConnectionProposal,
} from '../circuit/connectionPreview';
import {
  buildAssemblyMetadataPreview,
  buildAssemblyMetadataBatchPreview,
  consumeAssemblyMetadataBatchAgentGrant,
  createAssemblyMetadataAgentGrant,
  createAssemblyMetadataBatchAgentGrant,
  prepareAssemblyMetadataProposal,
  prepareAssemblyMetadataBatchProposal,
  validateAssemblyMetadataAgentGrant,
  type AssemblyMetadataAgentGrant,
  type AssemblyMetadataBatchAgentGrant,
  type AssemblyMetadataPreviewRequest,
  type AssemblyMetadataBatchRequest,
  type ResolvedAssemblyMetadataBatchProposal,
  type ResolvedAssemblyMetadataProposal,
} from '../circuit/assemblyMetadataPreview';
import {
  buildPartWireEvidence,
  createPartConnectionGrant,
  createPinConnectionGrant,
  validatePartConnectionGrant,
  type PartConnectionGrant,
} from '../circuit/partWire';
import {
  buildPinSelectionSnapshot,
  derivePinSelectionConstellation,
  type PinSelectionSnapshot,
  type PinSelectionTarget,
} from '../circuit/pinSelection';
import {
  buildFindingSelectionContext,
  buildNetSelectionContext,
  buildPartSelectionContext,
  buildPartSelectionContextItem,
  buildPartSelectionContextItems,
  buildProjectTemplateSelectionContext,
  buildReadinessSelectionContext,
  buildSelectionContextItem,
  resolvePartFromLatestProjection,
  advisorAgentTargetKey,
  createLintAgentTarget,
  createNetAgentTarget,
  createReadinessAgentTarget,
  resolveAdvisorAgentTarget,
  type AdvisorAgentTarget,
  type SelectionEditorContext,
} from '../circuit/selectionContext';
import {
  buildPairEvidenceSnapshot,
  reducePairSelection,
  resolvePairTargets,
  type PairSelectionState,
} from '../circuit/pairSelection';
import {
  buildLayoutEvidenceSnapshot,
  layoutTargetKey,
  reduceLayoutSelection,
  resolveLayoutTargets,
  validateLayoutGeometryGrant,
  type LayoutSelectionState,
} from '../circuit/layoutSelection';
import {
  ADVISOR_DIAGNOSTIC_DEFAULT_REQUEST,
  ASSEMBLY_HANDOFF_INSPECT_REQUEST,
  NET_DETECTIVE_DEFAULT_REQUEST,
  PROJECT_GUIDANCE_CAPTURE_REQUEST,
  agentAIServiceBridge,
  appendLoadedGuidancePcbRuleContext,
  beginAgentRequest,
  buildAgentSessionName,
  buildAdvisorAgentPrompt,
  buildAdvisorRequestPresets,
  consumeAdvisorAssemblyExport,
  consumeAdvisorReadinessAction,
  createAdvisorAgentAuthorization,
  buildPartRequestPresets,
  validateAdvisorPresetSelection,
  buildPartAgentPrompt,
  buildPinAgentPrompt,
  buildPinAgentSessionName,
  buildPinRequestPresets,
  buildPairAgentPrompt,
  buildPairAgentSessionName,
  buildLayoutAgentPrompt,
  buildLayoutAgentSessionName,
  buildLayoutRequestPresets,
  LAYOUT_DEFAULT_REQUEST,
  buildProjectTemplateAgentPrompt,
  buildProjectTemplateAgentSessionName,
  buildSimulationAgentPrompt,
  buildSimulationAgentSessionName,
  buildSimulationRequestPresets,
  getAgentSendAvailability,
  getProjectTemplateAgentAvailability,
  isAgentProvider,
  loadAgentProviderPreference,
  normalizeAgentRequestTarget,
  persistAgentProviderPreference,
  reduceAgentRequestState,
  validateSimulationPresetSelection,
  validateLayoutPresetSelection,
  validatePartPresetSelection,
  validatePinPresetSelection,
  type AgentProvider,
  type AgentRequestPreset,
  type AgentRequestAction,
  type AgentRequestState,
  type AgentRequestTarget,
  type AdvisorAgentAuthorization,
} from '../agentSession';
import {
  assertNoProjectGuidanceContradiction,
  classifyBlankEditableTsx,
  generateProjectTemplateSource,
  getProjectTemplate,
  projectTemplateAgentTargetIdentity,
  validateProjectTemplateRequirements,
  verifyProjectTemplateProjection,
  type ProjectTemplateId,
} from '../circuit/projectTemplates';

type Tab = 'schematic' | 'pcb' | '3d' | 'assembly' | 'bom' | 'code' | 'simulate';
type DocKind = 'tsx' | 'json';
const evaluateProjection = createEvaluationCache(evalTscircuitProject);

interface DeriveState {
  running: boolean;
  ok: boolean;
  error?: string;
  durationMs?: number;
  cached?: boolean;
}

interface ManualEditingState {
  enabled: boolean;
  status: 'disabled' | 'ready' | 'saving' | 'conflicted' | 'invalid' | 'unavailable';
  message: string;
  receiptId?: string;
}

// Extension-owned undo/redo entry: to undo, write `undo`; to redo, write `redo`.
interface HostEditEntry {
  summary: EditTransactionSummary;
  undo: ProjectFileChange[];
  redo: ProjectFileChange[];
}

const TAB_META: Array<{ id: Tab; label: string; glyph: string }> = [
  { id: 'schematic', label: 'Schematic', glyph: '⌁' },
  { id: 'pcb', label: 'PCB', glyph: '▦' },
  { id: '3d', label: '3D', glyph: '◇' },
  { id: 'assembly', label: 'Assembly', glyph: '◫' },
  { id: 'bom', label: 'BOM', glyph: '≣' },
  { id: 'code', label: 'Code', glyph: '</>' },
  { id: 'simulate', label: 'Simulate', glyph: '▶' },
];

function themeNameIsDark(themeName: string | null | undefined): boolean | undefined {
  const normalized = themeName?.trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'system') return undefined;
  if (normalized === 'dark' || normalized === 'crystal-dark' || normalized.includes('-dark')) return true;
  if (normalized === 'light' || normalized.includes('-light')) return false;
  return undefined;
}

function resolveDarkTheme(hostTheme: string): boolean {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const documentDark = themeNameIsDark(root.getAttribute('data-theme'));
    if (documentDark !== undefined) return documentDark;
    if (root.classList.contains('dark-theme') || root.classList.contains('crystal-dark-theme')) return true;
    if (root.classList.contains('light-theme')) return false;
  }

  const hostDark = themeNameIsDark(hostTheme);
  if (hostDark !== undefined) return hostDark;

  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

interface SimulationRunState {
  runId: number;
  source: string;
  result: SimResult;
}

export function ElectronicsEditor({ host }: { host: EditorHost }) {
  const docName = host.filePath || host.fileName || '';
  const fileName = host.fileName || docName.split(/[\\/]/).pop() || 'Untitled circuit';
  const kind: DocKind = docName.endsWith('.circuit.tsx') ? 'tsx' : 'json';

  const [code, setCode] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dark, setDark] = useState(() => resolveDarkTheme(host.theme || 'light'));
  const [circuitJson, setCircuitJson] = useState<AnyCircuitElement[]>([]);
  const [derivedCode, setDerivedCode] = useState<string | null>(null);
  const [derive, setDerive] = useState<DeriveState>({ running: false, ok: true });
  const [tab, setTab] = useState<Tab>('schematic');
  const [showAdvisor, setShowAdvisor] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [wiring, setWiring] = useState(false);
  const [wireFrom, setWireFrom] = useState<{ id: string; selector: string }>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [pendingEditPreview, setPendingEditPreview] = useState<PendingEditPreview>();
  const [agentChangeReveal, setAgentChangeReveal] = useState<AgentChangeReveal>();
  const [revealEmphasisActive, setRevealEmphasisActive] = useState(false);
  const [projectGuidance, setProjectGuidance] = useState<ProjectGuidance>();
  const [partEvidenceReport, setPartEvidenceReport] = useState<PartEvidenceReport>();
  const [activePartTrustSpotlight, setActivePartTrustSpotlight] = useState<ActivePartTrustSpotlight>();
  const [activeAssemblyHandoffSpotlight, setActiveAssemblyHandoffSpotlight] = useState<ActiveAssemblyHandoffSpotlight>();
  const [selectedComponentId, setSelectedComponentId] = useState<string>();
  const [selectedPinTarget, setSelectedPinTarget] = useState<PinSelectionTarget>();
  const [pairSelection, setPairSelection] = useState<PairSelectionState>({ phase: 'idle' });
  const [layoutSelection, setLayoutSelection] = useState<LayoutSelectionState>({ phase: 'idle', components: [] });
  const [selectedProjectTemplateId, setSelectedProjectTemplateId] = useState<ProjectTemplateId>();
  const [advisorAgentTarget, setAdvisorAgentTarget] = useState<AdvisorAgentTarget>();
  const [passiveAgentContext, setPassiveAgentContext] = useState<SelectionEditorContext>();
  const [pcbLayers, setPcbLayers] = useState<PcbLayerDefinition[]>([]);
  const [hiddenPcbLayers, setHiddenPcbLayers] = useState<Set<string>>(() => new Set());
  const [activePcbLayerView, setActivePcbLayerView] = useState<PcbLayerViewResult>();
  const [simulationRun, setSimulationRun] = useState<SimulationRunState | null>(null);
  const [activePcbMeasurement, setActivePcbMeasurement] = useState<ActivePcbMeasurement>();
  const [activePcbGrid, setActivePcbGrid] = useState<ActivePcbGrid>();
  const [activePcbRouteProposal, setActivePcbRouteProposal] = useState<ActivePcbRouteProposal>();
  const [activePcbRuleLens, setActivePcbRuleLens] = useState<ActivePcbRuleLens>();
  const [activeConnectivityEvidence, setActiveConnectivityEvidence] = useState<ActiveConnectivityEvidence>();
  const [agentProviderPreference, setAgentProviderPreference] = useState(() => loadAgentProviderPreference(host.storage));
  const [agentRequestState, setAgentRequestState] = useState<AgentRequestState>({});
  const [upstreamCheckFindings, setUpstreamCheckFindings] = useState<LintFinding[]>([]);
  const [projectFileRevision, setProjectFileRevision] = useState(0);
  const [evaluationRevision, setEvaluationRevision] = useState(0);
  const forceEvaluation = useRef(false);
  const [manualEditing, setManualEditing] = useState<ManualEditingState>(() => (
    kind === 'tsx' && hasHostProjectFiles(host)
      ? { enabled: false, status: 'disabled', message: 'Enable upstream manual-edits.json to drag PCB components.' }
      : { enabled: false, status: 'unavailable', message: 'Manual editing requires a CutuCircuits host with project filesystem access.' }
  ));
  const [hostReceiptHistory, setHostReceiptHistory] = useState<{ applied: HostEditEntry[]; redo: HostEditEntry[] }>({ applied: [], redo: [] });

  const codeRef = useRef(code);
  codeRef.current = code;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const circuitJsonRef = useRef(circuitJson);
  circuitJsonRef.current = circuitJson;
  const selectedPinTargetRef = useRef(selectedPinTarget);
  selectedPinTargetRef.current = selectedPinTarget;
  const hiddenPcbLayersRef = useRef(hiddenPcbLayers);
  hiddenPcbLayersRef.current = hiddenPcbLayers;
  const activePcbLayerViewRef = useRef(activePcbLayerView);
  activePcbLayerViewRef.current = activePcbLayerView;
  const derivedCodeRef = useRef(derivedCode);
  derivedCodeRef.current = derivedCode;
  const deriveRef = useRef(derive);
  deriveRef.current = derive;
  const historyRef = useRef(new EditHistory(''));
  const approvalQueueRef = useRef(new EditApprovalQueue());
  const projectGuidanceRef = useRef<ProjectGuidance | undefined>(undefined);
  const partEvidenceReportRef = useRef<PartEvidenceReport | undefined>(undefined);
  const partEvidenceReportBindingRef = useRef<PartEvidenceReportBinding | undefined>(undefined);
  const activePartTrustSpotlightRef = useRef<ActivePartTrustSpotlight | undefined>(undefined);
  activePartTrustSpotlightRef.current = activePartTrustSpotlight;
  const activeAssemblyHandoffSpotlightRef = useRef<ActiveAssemblyHandoffSpotlight | undefined>(undefined);
  activeAssemblyHandoffSpotlightRef.current = activeAssemblyHandoffSpotlight;
  const activePcbMeasurementRef = useRef<ActivePcbMeasurement | undefined>(undefined);
  const activePcbGridRef = useRef<ActivePcbGrid | undefined>(undefined);
  const activePcbRouteProposalRef = useRef<ActivePcbRouteProposal | undefined>(undefined);
  const autorouteControllerRef = useRef<AbortController | undefined>(undefined);
  const activePcbRuleLensRef = useRef<ActivePcbRuleLens | undefined>(undefined);
  const activeConnectivityEvidenceRef = useRef<ActiveConnectivityEvidence | undefined>(undefined);
  const agentRequestStateRef = useRef<AgentRequestState>({});
  const hostReceiptHistoryRef = useRef(hostReceiptHistory);
  hostReceiptHistoryRef.current = hostReceiptHistory;
  const agentRequestSequenceRef = useRef(0);
  const simulationRunSequenceRef = useRef(0);
  const simulationRunRef = useRef(simulationRun);
  simulationRunRef.current = simulationRun;
  const simulationAgentSessionModeRef = useRef<'read-only' | 'matrix' | undefined>(undefined);
  const simulationMatrixAgentGrantRef = useRef<SimulationMatrixAgentGrant | undefined>(undefined);
  const pairSelectionRef = useRef(pairSelection);
  pairSelectionRef.current = pairSelection;
  const clearPairSelection = useCallback(() => {
    const idle: PairSelectionState = { phase: 'idle' };
    pairSelectionRef.current = idle;
    setPairSelection(idle);
  }, []);
  const layoutSelectionRef = useRef(layoutSelection);
  layoutSelectionRef.current = layoutSelection;
  const layoutAgentGrantRef = useRef<{ baseline: string; refs: string[] } | undefined>(undefined);
  const partAgentSessionModeRef = useRef<'read-only' | 'evidence' | 'contribution' | 'contribution-draft' | 'wire' | 'assembly-metadata' | undefined>(undefined);
  const advisorAgentAuthorizationRef = useRef<AdvisorAgentAuthorization | undefined>(undefined);
  const partConnectionGrantRef = useRef<PartConnectionGrant | undefined>(undefined);
  const partEvidenceSessionGrantRef = useRef<PartEvidenceSessionGrant | undefined>(undefined);
  const partEvidenceCandidateGrantRef = useRef<PartEvidenceCandidateGrant | undefined>(undefined);
  const partEvidenceDraftGrantRef = useRef<PartEvidenceCandidateGrant | undefined>(undefined);
  const assemblyMetadataGrantRef = useRef<AssemblyMetadataAgentGrant | undefined>(undefined);
  const assemblyMetadataBatchGrantRef = useRef<AssemblyMetadataBatchAgentGrant | undefined>(undefined);
  const advisorConnectionGrantRef = useRef<AdvisorConnectionGrant | undefined>(undefined);
  const partEvidenceRefreshStartedRef = useRef(false);
  const invalidatePartConnectionGrant = useCallback(() => {
    partConnectionGrantRef.current = undefined;
    partEvidenceSessionGrantRef.current = undefined;
    partEvidenceCandidateGrantRef.current = undefined;
    partEvidenceDraftGrantRef.current = undefined;
    assemblyMetadataGrantRef.current = undefined;
    partEvidenceRefreshStartedRef.current = false;
  }, []);
  const finishPartAgentSession = useCallback(() => {
    partAgentSessionModeRef.current = undefined;
    partConnectionGrantRef.current = undefined;
    partEvidenceSessionGrantRef.current = undefined;
    partEvidenceCandidateGrantRef.current = undefined;
    partEvidenceDraftGrantRef.current = undefined;
    assemblyMetadataGrantRef.current = undefined;
    partEvidenceRefreshStartedRef.current = false;
  }, []);
  const clearLayoutSelection = useCallback(() => {
    const idle: LayoutSelectionState = { phase: 'idle', components: [] };
    layoutSelectionRef.current = idle;
    layoutAgentGrantRef.current = undefined;
    setLayoutSelection(idle);
  }, []);
  const clearPcbLayerView = useCallback(() => {
    const cleared = activePcbLayerViewRef.current != null || hiddenPcbLayersRef.current.size > 0;
    hiddenPcbLayersRef.current = new Set();
    activePcbLayerViewRef.current = undefined;
    setHiddenPcbLayers(new Set());
    setActivePcbLayerView(undefined);
    return { cleared };
  }, []);
  const clearPartTrustSpotlight = useCallback(() => {
    const cleared = activePartTrustSpotlightRef.current != null;
    activePartTrustSpotlightRef.current = undefined;
    setActivePartTrustSpotlight(undefined);
    return { cleared };
  }, []);
  const clearAssemblyHandoffSpotlight = useCallback(() => {
    const cleared = activeAssemblyHandoffSpotlightRef.current != null;
    activeAssemblyHandoffSpotlightRef.current = undefined;
    setActiveAssemblyHandoffSpotlight(undefined);
    return { cleared };
  }, []);
  const handleHiddenPcbLayersChange = useCallback((hidden: Set<string>) => {
    hiddenPcbLayersRef.current = hidden;
    activePcbLayerViewRef.current = undefined;
    setHiddenPcbLayers(hidden);
    setActivePcbLayerView(undefined);
  }, []);
  const ensurePcbLayerVisible = useCallback((id: string) => {
    if (!hiddenPcbLayersRef.current.has(id)) return;
    const next = new Set(hiddenPcbLayersRef.current);
    next.delete(id);
    hiddenPcbLayersRef.current = next;
    activePcbLayerViewRef.current = undefined;
    setHiddenPcbLayers(next);
    setActivePcbLayerView(undefined);
  }, []);

  useEffect(() => {
    invalidatePartConnectionGrant();
  }, [invalidatePartConnectionGrant, selectedComponentId]);

  useEffect(() => {
    if (!activePcbLayerViewRef.current && hiddenPcbLayersRef.current.size === 0) return;
    if (!loaded || derivedCode !== code || derive.running || !derive.ok) clearPcbLayerView();
  }, [clearPcbLayerView, code, derive.ok, derive.running, derivedCode, loaded]);

  useEffect(() => {
    if (!activePartTrustSpotlightRef.current) return;
    if (!loaded || derivedCode !== code || derive.running || !derive.ok
      || activePartTrustSpotlightRef.current.source !== code) clearPartTrustSpotlight();
  }, [clearPartTrustSpotlight, code, derive.ok, derive.running, derivedCode, loaded]);

  useEffect(() => {
    if (!activeAssemblyHandoffSpotlightRef.current) return;
    if (!loaded || derivedCode !== code || derive.running || !derive.ok
      || activeAssemblyHandoffSpotlightRef.current.source !== code) clearAssemblyHandoffSpotlight();
  }, [clearAssemblyHandoffSpotlight, code, derive.ok, derive.running, derivedCode, loaded]);

  useEffect(() => {
    let active = true;
    host
      .loadContent()
      .then((content) => {
        if (active) {
          const next = content ?? '';
          approvalQueueRef.current.clear();
          setPendingEditPreview(undefined);
          setAgentChangeReveal(undefined);
          setAdvisorAgentTarget(undefined);
          setSelectedComponentId(undefined);
          invalidatePartConnectionGrant();
          clearPairSelection();
          clearLayoutSelection();
          setSelectedProjectTemplateId(undefined);
          setPassiveAgentContext(undefined);
          partEvidenceReportRef.current = undefined;
          partEvidenceReportBindingRef.current = undefined;
          setPartEvidenceReport(undefined);
          clearPartTrustSpotlight();
          clearAssemblyHandoffSpotlight();
          activePcbMeasurementRef.current = undefined;
          setActivePcbMeasurement(undefined);
          activePcbGridRef.current = undefined;
          setActivePcbGrid(undefined);
          autorouteControllerRef.current?.abort();
          autorouteControllerRef.current = undefined;
          activePcbRouteProposalRef.current = undefined;
          setActivePcbRouteProposal(undefined);
          activePcbRuleLensRef.current = undefined;
          setActivePcbRuleLens(undefined);
          activeConnectivityEvidenceRef.current = undefined;
          setActiveConnectivityEvidence(undefined);
          hiddenPcbLayersRef.current = new Set();
          activePcbLayerViewRef.current = undefined;
          setHiddenPcbLayers(new Set());
          setActivePcbLayerView(undefined);
          historyRef.current.reset(next);
          codeRef.current = next;
          setCode(next);
          loadedRef.current = true;
          setLoaded(true);
        }
      })
      .catch((error) => {
        console.error('[ElectronicsStudio] loadContent failed:', error);
        if (active) {
          loadedRef.current = true;
          setLoaded(true);
        }
      });

    const offSave = host.onSaveRequested(() => {
      host.saveContent(codeRef.current).then(() => host.setDirty(false)).catch(() => undefined);
    });
    const offFile = host.onFileChanged((newContent) => {
      const next = newContent ?? '';
      approvalQueueRef.current.clear();
      setPendingEditPreview(undefined);
      setAgentChangeReveal(undefined);
      setAdvisorAgentTarget(undefined);
      setSelectedComponentId(undefined);
      invalidatePartConnectionGrant();
      clearPairSelection();
      clearLayoutSelection();
      setSelectedProjectTemplateId(undefined);
      setPassiveAgentContext(undefined);
      partEvidenceReportRef.current = undefined;
      partEvidenceReportBindingRef.current = undefined;
      setPartEvidenceReport(undefined);
      clearPartTrustSpotlight();
      clearAssemblyHandoffSpotlight();
      activePcbMeasurementRef.current = undefined;
      setActivePcbMeasurement(undefined);
      activePcbGridRef.current = undefined;
      setActivePcbGrid(undefined);
      autorouteControllerRef.current?.abort();
      autorouteControllerRef.current = undefined;
      activePcbRouteProposalRef.current = undefined;
      setActivePcbRouteProposal(undefined);
      activePcbRuleLensRef.current = undefined;
      setActivePcbRuleLens(undefined);
      activeConnectivityEvidenceRef.current = undefined;
      setActiveConnectivityEvidence(undefined);
      hiddenPcbLayersRef.current = new Set();
      activePcbLayerViewRef.current = undefined;
      setHiddenPcbLayers(new Set());
      setActivePcbLayerView(undefined);
      codeRef.current = next;
      historyRef.current.reset(next);
      setHistoryRevision((revision) => revision + 1);
      setCode(next);
    });
    const syncTheme = (nextTheme = host.theme || 'light') => setDark(resolveDarkTheme(nextTheme));
    const offTheme = host.onThemeChanged(syncTheme);
    const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
    const syncSystemTheme = () => syncTheme();
    const observer = typeof document !== 'undefined' && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(syncSystemTheme)
      : undefined;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    media?.addEventListener?.('change', syncSystemTheme);
    return () => {
      active = false;
      offSave?.();
      offFile?.();
      offTheme?.();
      observer?.disconnect();
      media?.removeEventListener?.('change', syncSystemTheme);
    };
  }, [clearAssemblyHandoffSpotlight, clearLayoutSelection, clearPairSelection, clearPartTrustSpotlight, docName, host, invalidatePartConnectionGrant]);

  useEffect(() => {
    if (kind !== 'tsx' || !host.fs) return;
    const sidecarPath = manualEditsPathForCircuit(docName).replace(/\\/g, '/');
    return host.fs.onChanged((paths) => {
      if (paths.some((candidate) => candidate.replace(/\\/g, '/') === sidecarPath)) {
        setProjectFileRevision((revision) => revision + 1);
      }
    });
  }, [docName, host, kind]);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    if (kind === 'tsx') {
      const running = { ...deriveRef.current, running: true };
      deriveRef.current = running;
      setDerive(running);
    }
    const handle = setTimeout(async () => {
      if (kind === 'json') {
        const projection = parseCircuitJsonProjection(code);
        circuitJsonRef.current = projection.circuitJson;
        setCircuitJson(projection.circuitJson);
        derivedCodeRef.current = code;
        setDerivedCode(code);
        const state = { running: false, ok: !projection.error, error: projection.error };
        deriveRef.current = state;
        setDerive(state);
        return;
      }
      const bypass = forceEvaluation.current || !host.workspaceId;
      forceEvaluation.current = false;
      const context = JSON.stringify([host.workspaceId, docName]);
      const evaluateCode = (source: string) => evaluateProjection(context,
        { entrypoint: 'user-code.tsx', files: { 'user-code.tsx': source } },
        { bypass, active: () => !cancelled });
      const evaluateProject = (input: Parameters<typeof evalTscircuitProject>[0]) =>
        evaluateProjection(context, input, { bypass, active: () => !cancelled });
      let result;
      let nextManualEditing: ManualEditingState = hasHostProjectFiles(host)
        ? { enabled: false, status: 'disabled', message: 'Enable upstream manual-edits.json to drag PCB components.' }
        : { enabled: false, status: 'unavailable', message: 'Manual editing requires a CutuCircuits host with project filesystem access.' };
      if (hasHostProjectFiles(host)) {
        try {
          const sidecarPath = manualEditsPathForCircuit(docName);
          const files = await host.fs!.read([docName, sidecarPath]);
          const sourceFile = files.find((file) => file.path.replace(/\\/g, '/') === docName.replace(/\\/g, '/'));
          const sidecarFile = files.find((file) => file.path.replace(/\\/g, '/') === sidecarPath.replace(/\\/g, '/'));
          if (!sourceFile || !sidecarFile) throw new Error('The host returned an incomplete project read.');
          if (sourceFile.content !== code) {
            nextManualEditing = { enabled: false, status: 'conflicted', message: 'Save or reload the source before enabling PCB drag editing.' };
            result = await evaluateCode(code);
          } else if (!sidecarFile.exists || sidecarFile.content === null) {
            result = await evaluateCode(code);
          } else {
            const parsed = parseManualEdits(sidecarFile.content);
            if (!parsed.ok) {
              nextManualEditing = { enabled: false, status: 'invalid', message: parsed.error ?? 'manual-edits.json is invalid.' };
              result = await evaluateCode(code);
            } else {
              const binding = ensureManualEditsBinding(code);
              if (binding.changed) {
                nextManualEditing = { enabled: false, status: 'invalid', message: 'manual-edits.json exists but the circuit does not import and pass it to its single board.' };
                result = await evaluateCode(code);
              } else {
                result = await evaluateProject({
                  entrypoint: fileName,
                  files: { [fileName]: code, 'manual-edits.json': sidecarFile.content },
                });
                nextManualEditing = result.ok
                  ? { enabled: true, status: 'ready', message: 'PCB drag edits save through grouped host history and upstream manual-edits.json.' }
                  : { enabled: false, status: 'invalid', message: `The bound manual-edit project failed evaluation: ${result.error}` };
              }
            }
          }
        } catch (error) {
          nextManualEditing = { enabled: false, status: 'invalid', message: error instanceof Error ? error.message : String(error) };
          result = await evaluateCode(code);
        }
      } else {
        result = await evaluateCode(code);
      }
      if (cancelled) return;
      setManualEditing((current) => ({
        ...nextManualEditing,
        ...(nextManualEditing.enabled && current.receiptId ? { receiptId: current.receiptId } : {}),
      }));
      circuitJsonRef.current = result.circuitJson;
      setCircuitJson(result.circuitJson);
      derivedCodeRef.current = code;
      setDerivedCode(code);
      const state = { running: false, ok: result.ok, error: result.error, durationMs: result.durationMs, cached: result.cached };
      deriveRef.current = state;
      setDerive(state);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [code, docName, fileName, host, kind, loaded, projectFileRevision, evaluationRevision]);

  useEffect(() => {
    if (pairSelection.phase === 'idle') return;
    if (!loaded || derivedCode !== code || derive.running || !derive.ok || agentChangeReveal) {
      clearPairSelection();
    }
  }, [agentChangeReveal, clearPairSelection, code, derive.ok, derive.running, derivedCode, loaded, pairSelection.phase]);

  useEffect(() => {
    if (layoutSelection.phase === 'idle') return;
    if (!loaded || derivedCode !== code || derive.running || !derive.ok || agentChangeReveal) clearLayoutSelection();
  }, [agentChangeReveal, clearLayoutSelection, code, derive.ok, derive.running, derivedCode, layoutSelection.phase, loaded]);

  useEffect(() => {
    if (simulationRun && simulationRun.source !== code) {
      simulationRunRef.current = null;
      setSimulationRun(null);
    }
  }, [code, simulationRun]);

  useEffect(() => {
    if (!loaded || derivedCode !== code || derive.running || !derive.ok) {
      setUpstreamCheckFindings([]);
      return;
    }
    const controller = new AbortController();
    const sourceIdentity = code;
    void runUpstreamCircuitChecks(circuitJson, { signal: controller.signal }).then((result) => {
      if (codeRef.current !== sourceIdentity || controller.signal.aborted) return;
      const findings = result.diagnostics.map((diagnostic): LintFinding => ({
        severity: diagnostic.type.includes('warning') ? 'warning' : 'error',
        rule: `tscircuit-checks/${diagnostic.type}`,
        message: diagnostic.message,
        relatedRefs: exactDiagnosticRefs(circuitJson, diagnostic.element),
      }));
      setUpstreamCheckFindings(findings);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setUpstreamCheckFindings([{
        severity: 'warning',
        rule: 'tscircuit-checks/unavailable',
        message: `Upstream tscircuit checks did not complete: ${error instanceof Error ? error.message : String(error)}`,
      }]);
    });
    return () => controller.abort();
  }, [circuitJson, code, derive.ok, derive.running, derivedCode, loaded]);

  const clearSimulationRun = useCallback(() => {
    simulationRunRef.current = null;
    setSimulationRun(null);
  }, []);
  const handleSimulationResult = useCallback((result: SimResult, sourceIdentity: string) => {
    if (sourceIdentity !== codeRef.current) {
      simulationRunRef.current = null;
      setSimulationRun(null);
      return;
    }
    const next: SimulationRunState = {
      runId: ++simulationRunSequenceRef.current,
      source: sourceIdentity,
      result,
    };
    simulationRunRef.current = next;
    setSimulationRun(next);
  }, []);

  const markDirty = useCallback(() => host.setDirty(true), [host]);
  const clearPcbMeasurement = useCallback(() => {
    const cleared = activePcbMeasurementRef.current != null;
    activePcbMeasurementRef.current = undefined;
    setActivePcbMeasurement(undefined);
    return { cleared };
  }, []);
  const clearPcbGrid = useCallback(() => {
    const cleared = activePcbGridRef.current != null;
    activePcbGridRef.current = undefined;
    setActivePcbGrid(undefined);
    return { cleared };
  }, []);
  const clearPcbRouteProposal = useCallback(() => {
    autorouteControllerRef.current?.abort();
    autorouteControllerRef.current = undefined;
    const cleared = activePcbRouteProposalRef.current != null;
    activePcbRouteProposalRef.current = undefined;
    setActivePcbRouteProposal(undefined);
    return { cleared };
  }, []);
  useEffect(() => {
    clearPcbRouteProposal();
  }, [clearPcbRouteProposal, code]);
  const clearPcbRuleLens = useCallback(() => {
    const cleared = activePcbRuleLensRef.current != null;
    activePcbRuleLensRef.current = undefined;
    setActivePcbRuleLens(undefined);
    return { cleared };
  }, []);
  const clearConnectivityEvidence = useCallback(() => {
    const cleared = activeConnectivityEvidenceRef.current != null;
    activeConnectivityEvidenceRef.current = undefined;
    setActiveConnectivityEvidence(undefined);
    return { cleared };
  }, []);
  const applyManualTransactionResult = useCallback((result: Awaited<ReturnType<typeof ensureManualEditsProject>>) => {
    codeRef.current = result.source;
    setCode(result.source);
    circuitJsonRef.current = result.projection.circuitJson;
    setCircuitJson(result.projection.circuitJson);
    derivedCodeRef.current = result.source;
    setDerivedCode(result.source);
    const nextDerive = {
      running: false,
      ok: result.projection.ok,
      error: result.projection.error,
      durationMs: result.projection.durationMs,
    };
    deriveRef.current = nextDerive;
    setDerive(nextDerive);
    host.setDirty(false);
    setManualEditing({
      enabled: true,
      status: 'ready',
      message: 'PCB drag edits save through document history and upstream manual-edits.json.',
      receiptId: result.receipt.id,
    });
    const entry: HostEditEntry = {
      summary: {
        id: result.receipt.id,
        actor: result.receipt.actor,
        operation: 'manual_edits',
        label: result.receipt.label,
        timestamp: result.receipt.timestamp,
        addedLines: 0,
        removedLines: 0,
        beforePreview: '',
        afterPreview: '',
      },
      undo: result.undoChanges,
      redo: result.redoChanges,
    };
    setHostReceiptHistory((current) => current.applied.some((existing) => existing.summary.id === result.receipt.id)
      ? current
      : { applied: [...current.applied, entry].slice(-100), redo: [] });
  }, [host]);
  const handleEnableManualEditing = useCallback(async () => {
    setManualEditing((current) => ({ ...current, enabled: false, status: 'saving', message: 'Creating the grouped source and sidecar transaction…' }));
    try {
      applyManualTransactionResult(await ensureManualEditsProject(host));
    } catch (error) {
      setManualEditing({ enabled: false, status: 'conflicted', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [applyManualTransactionResult, host]);
  const handleCommitManualEditEvents = useCallback(async (events: ManualEditEvent[]) => {
    setManualEditing((current) => ({ ...current, status: 'saving', message: 'Saving one grouped PCB placement transaction…' }));
    try {
      const result = await commitManualEditEvents({
        host,
        expectedSource: codeRef.current,
        circuitJson: circuitJsonRef.current,
        events,
        actor: 'user',
        label: events.length === 1 ? 'Move PCB component' : `Move ${events.length} PCB components`,
      });
      applyManualTransactionResult(result);
    } catch (error) {
      setManualEditing((current) => ({ ...current, enabled: true, status: 'conflicted', message: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }, [applyManualTransactionResult, host]);
  const updateCode = useCallback(async (next: string, descriptor: EditDescriptor) => {
    const previous = codeRef.current;
    if (next === previous) return undefined;
    let transaction: EditTransactionSummary | undefined;
    if (hasHostProjectFiles(host)) {
      const files = await host.fs!.read([docName]);
      const sourceFile = files[0];
      if (!sourceFile?.exists || sourceFile.content === null || sourceFile.sha256 === null) {
        throw new Error('The circuit source is missing from the workspace.');
      }
      if (sourceFile.content !== previous) {
        throw new Error('The circuit source changed on disk; reload before applying this edit.');
      }
      const receipt = await host.fs!.write({
        label: descriptor.label,
        actor: descriptor.actor,
        changes: [{ path: docName, expectedSha256: sourceFile.sha256, content: next }],
      });
      const rf = receipt.files[0];
      const entry: HostEditEntry = {
        summary: {
          id: receipt.id,
          actor: descriptor.actor,
          operation: descriptor.operation,
          label: descriptor.label,
          timestamp: receipt.timestamp,
          ...summarizeSourceChange(previous, next),
        },
        undo: [{ path: docName, expectedSha256: rf.afterSha256, content: previous }],
        redo: [{ path: docName, expectedSha256: rf.beforeSha256, content: next }],
      };
      transaction = entry.summary;
      setHostReceiptHistory((current) => ({ applied: [...current.applied, entry].slice(-100), redo: [] }));
    } else {
      transaction = historyRef.current.commit(next, descriptor);
      if (!transaction) return undefined;
    }
    approvalQueueRef.current.clear();
    setPendingEditPreview(undefined);
    setAgentChangeReveal(undefined);
    invalidatePartConnectionGrant();
    clearPairSelection();
    clearLayoutSelection();
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    partEvidenceReportRef.current = undefined;
    partEvidenceReportBindingRef.current = undefined;
    setPartEvidenceReport(undefined);
    clearPartTrustSpotlight();
    clearAssemblyHandoffSpotlight();
    clearPcbMeasurement();
    clearPcbGrid();
    clearPcbRouteProposal();
    clearPcbRuleLens();
    clearConnectivityEvidence();
    clearPcbLayerView();
    codeRef.current = next;
    setCode(next);
    setHistoryRevision((revision) => revision + 1);
    if (!hasHostProjectFiles(host)) markDirty();
    else host.setDirty(false);
    return transaction;
  }, [clearAssemblyHandoffSpotlight, clearConnectivityEvidence, clearLayoutSelection, clearPairSelection, clearPartTrustSpotlight, clearPcbGrid, clearPcbLayerView, clearPcbMeasurement, clearPcbRouteProposal, clearPcbRuleLens, docName, host, invalidatePartConnectionGrant, markDirty]);

  const moveHistory = useCallback(async (direction: 'undo' | 'redo') => {
    let transaction: EditTransactionSummary | undefined;
    let legacySource: string | undefined;
    if (hasHostProjectFiles(host)) {
      const history = hostReceiptHistoryRef.current;
      const entry = direction === 'undo' ? history.applied.at(-1) : history.redo.at(-1);
      if (!entry) return undefined;
      await host.fs!.write({
        label: `${direction === 'undo' ? 'Undo' : 'Redo'} ${entry.summary.label}`,
        actor: 'user',
        changes: direction === 'undo' ? entry.undo : entry.redo,
      });
      setHostReceiptHistory((current) => direction === 'undo'
        ? { applied: current.applied.slice(0, -1), redo: [...current.redo, entry] }
        : { applied: [...current.applied, entry], redo: current.redo.slice(0, -1) });
      setProjectFileRevision((revision) => revision + 1);
      transaction = entry.summary;
    } else {
      const move = direction === 'undo' ? historyRef.current.undo() : historyRef.current.redoLast();
      if (!move) return undefined;
      transaction = move.transaction;
      legacySource = move.source;
    }
    approvalQueueRef.current.clear();
    setPendingEditPreview(undefined);
    setAgentChangeReveal(undefined);
    invalidatePartConnectionGrant();
    clearPairSelection();
    clearLayoutSelection();
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    partEvidenceReportRef.current = undefined;
    partEvidenceReportBindingRef.current = undefined;
    setPartEvidenceReport(undefined);
    clearPartTrustSpotlight();
    clearAssemblyHandoffSpotlight();
    clearPcbMeasurement();
    clearPcbGrid();
    clearPcbRouteProposal();
    clearPcbRuleLens();
    clearConnectivityEvidence();
    clearPcbLayerView();
    if (legacySource !== undefined) {
      codeRef.current = legacySource;
      setCode(legacySource);
      markDirty();
    }
    setHistoryRevision((revision) => revision + 1);
    return transaction;
  }, [clearAssemblyHandoffSpotlight, clearConnectivityEvidence, clearLayoutSelection, clearPairSelection, clearPartTrustSpotlight, clearPcbGrid, clearPcbLayerView, clearPcbMeasurement, clearPcbRouteProposal, clearPcbRuleLens, host, invalidatePartConnectionGrant, markDirty]);

  const handleManualHistory = useCallback(async (direction: 'undo' | 'redo') => {
    setManualEditing((current) => ({ ...current, status: 'saving', message: `${direction === 'undo' ? 'Undoing' : 'Redoing'} the grouped placement edit…` }));
    try {
      await moveHistory(direction);
      setProjectFileRevision((revision) => revision + 1);
      setManualEditing((current) => ({ ...current, status: 'ready', message: 'PCB drag edits save through document history and upstream manual-edits.json.' }));
    } catch (error) {
      setManualEditing((current) => ({ ...current, status: 'conflicted', message: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }, [moveHistory]);

  const editHistory = useMemo(() => hasHostProjectFiles(host)
    ? {
      canUndo: hostReceiptHistory.applied.length > 0,
      canRedo: hostReceiptHistory.redo.length > 0,
      archived: [],
      applied: hostReceiptHistory.applied.map((entry) => entry.summary),
      redo: hostReceiptHistory.redo.map((entry) => entry.summary),
    }
    : historyRef.current.snapshot(), [historyRevision, host, hostReceiptHistory]);

  const previewHighImpactEdit = useCallback(async (
    nextSource: string,
    descriptor: EditDescriptor,
    geometryRequest?: GeometryChangeRequest,
    mountingHoleRequest?: MountingHoleRequest,
    keepoutRequest?: KeepoutRequest,
    connectionProposal?: ResolvedConnectionProposal,
    assemblyMetadataProposal?: ResolvedAssemblyMetadataProposal,
    assemblyMetadataBatchProposal?: ResolvedAssemblyMetadataBatchProposal,
  ) => {
    const baseline = codeRef.current;
    const [before, after] = await Promise.all([
      evalTscircuitCode(baseline),
      evalTscircuitCode(nextSource),
    ]);
    if (baseline !== codeRef.current) {
      throw new Error('The circuit changed while the preview was being prepared. Request the edit again.');
    }
    const errors = [
      before.ok ? undefined : `current source: ${before.error ?? 'evaluation failed'}`,
      after.ok ? undefined : `proposed source: ${after.error ?? 'evaluation failed'}`,
    ].filter((value): value is string => Boolean(value));
    const visual = buildVisualEditDiff(before.circuitJson, after.circuitJson, errors.join('; ') || undefined);
    if (geometryRequest) {
      if (errors.length > 0) throw new Error(`Geometry preview requires exact before/after evaluation: ${errors.join('; ')}`);
      visual.geometry = buildGeometryPreview(before.circuitJson, after.circuitJson, geometryRequest);
    }
    if (mountingHoleRequest) {
      if (errors.length > 0) throw new Error(`Mounting-hole preview requires exact before/after evaluation: ${errors.join('; ')}`);
      visual.mountingHoles = buildMountingHolePreview(before.circuitJson, after.circuitJson, mountingHoleRequest);
    }
    if (keepoutRequest) {
      if (errors.length > 0) throw new Error(`Keep-out preview requires exact before/after evaluation: ${errors.join('; ')}`);
      visual.keepouts = buildKeepoutPreview(before.circuitJson, after.circuitJson, keepoutRequest);
    }
    if (connectionProposal) {
      if (errors.length > 0) throw new Error(`Connection preview requires exact before/after evaluation: ${errors.join('; ')}`);
      visual.connection = buildConnectionPreview(before.circuitJson, after.circuitJson, connectionProposal);
      if (visual.affectedNetCount !== 1 || visual.affectedNets.length !== 1 || visual.affectedNets[0].change !== 'added') {
        throw new Error('Connection preview did not produce exactly one added affected-net visual diff.');
      }
      const affectedNet = visual.affectedNets[0];
      const expectedEndpoints = [
        `${visual.connection.from.ref}.${visual.connection.from.port}`,
        `${visual.connection.to.ref}.${visual.connection.to.port}`,
      ].sort();
      if (affectedNet.connectivityKey !== visual.connection.addedConnectivityKey
        || affectedNet.afterEndpointCount !== 2
        || JSON.stringify([...affectedNet.afterEndpoints].sort()) !== JSON.stringify(expectedEndpoints)) {
        throw new Error('Connection preview affected-net identity or endpoints do not match the verified new source trace.');
      }
    }
    if (assemblyMetadataProposal) {
      if (errors.length > 0) throw new Error(`Assembly metadata preview requires exact before/after evaluation: ${errors.join('; ')}`);
      visual.assemblyMetadata = buildAssemblyMetadataPreview(before.circuitJson, after.circuitJson, assemblyMetadataProposal);
    }
    if (assemblyMetadataBatchProposal) {
      if (errors.length > 0) throw new Error(`Assembly Fix Queue requires exact before/after evaluation: ${errors.join('; ')}`);
      visual.assemblyMetadataBatch = buildAssemblyMetadataBatchPreview(before.circuitJson, after.circuitJson, assemblyMetadataBatchProposal);
    }
    if (errors.length === 0) {
      visual.readinessBefore = buildReadinessReport(before.circuitJson, projectGuidanceRef.current, baseline).score;
      visual.readinessContextKey = readinessContextKey(projectGuidanceRef.current);
    }
    const preview = approvalQueueRef.current.stage(
      baseline,
      nextSource,
      descriptor,
      visual,
    );
    setPendingEditPreview(preview);
    return preview;
  }, []);

  const resolveEditPreview = useCallback(async (approvalId: string, action: 'apply' | 'cancel') => {
    if (!approvalId.trim()) throw new Error('An approval_id is required.');
    if (action === 'cancel') {
      const preview = approvalQueueRef.current.cancel(approvalId.trim());
      setPendingEditPreview((current) => current?.approvalId === preview.approvalId ? undefined : current);
      return { action: 'cancelled' as const, preview };
    }
    const approved = approvalQueueRef.current.approve(approvalId.trim(), codeRef.current);
    const transaction = await updateCode(approved.nextSource, approved.descriptor);
    if (!transaction) throw new Error('The approved edit no longer changes the circuit.');
    setAgentChangeReveal(createPendingAgentChangeReveal(transaction, approved.nextSource, approved.preview));
    return { action: 'applied' as const, preview: approved.preview, transaction };
  }, [updateCode]);

  useEffect(() => {
    if (agentChangeReveal?.phase !== 'reevaluating') return;
    const settled = settleAgentChangeReveal(agentChangeReveal, {
      source: derivedCode,
      running: derive.running,
      ok: derive.ok,
      error: derive.error,
      circuitJson,
      guidance: projectGuidance,
    });
    if (settled !== agentChangeReveal) setAgentChangeReveal(settled);
  }, [agentChangeReveal, circuitJson, derive.error, derive.ok, derive.running, derivedCode, projectGuidance]);

  useEffect(() => {
    if (agentChangeReveal?.phase !== 'ready' && agentChangeReveal?.phase !== 'failed') {
      setRevealEmphasisActive(false);
      return;
    }
    setRevealEmphasisActive(agentChangeReveal.phase === 'ready');
    const emphasisTimer = window.setTimeout(() => setRevealEmphasisActive(false), 4200);
    return () => window.clearTimeout(emphasisTimer);
  }, [agentChangeReveal?.phase, agentChangeReveal?.transactionId]);

  useEffect(() => {
    if (!wiring) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setWiring(false);
      setWireFrom(undefined);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [wiring]);

  // A pin selection is bound to one exact successful projection. Never carry it
  // across source/file changes or a running/failed evaluation.
  useEffect(() => {
    setSelectedPinTarget(undefined);
  }, [code, docName]);
  useEffect(() => {
    if (derive.running || !derive.ok) setSelectedPinTarget(undefined);
  }, [derive.ok, derive.running]);
  useEffect(() => {
    if (tab !== 'schematic') setSelectedPinTarget(undefined);
  }, [tab]);

  useEffect(() => {
    const deriveFresh = async () => {
      if (kind === 'json') return { circuitJson: parseCircuitJson(codeRef.current) };
      const result = await evalTscircuitCode(codeRef.current);
      return { circuitJson: result.circuitJson, evalError: result.ok ? undefined : result.error };
    };
    const assertAgentMutationAllowed = (operation: string) => {
      const simulationMode = simulationAgentSessionModeRef.current;
      if (simulationMode) {
        throw new Error(`The active simulation request permits no editor mutation; ${operation} is not permitted.`);
      }
      const mode = partAgentSessionModeRef.current;
      if (mode === 'read-only') {
        throw new Error(`The active selected-part request is read-only; ${operation} is not permitted.`);
      }
      if (mode === 'wire' && operation !== 'preview_connection') {
        throw new Error(`Wire one port permits only one electronics.preview_connection mutation attempt; ${operation} is not permitted.`);
      }
      if (mode === 'evidence' && operation !== 'set_part_evidence_report') {
        throw new Error(`Check evidence permits only one session-only electronics.part_evidence_report refresh; ${operation} is not permitted.`);
      }
      if (mode === 'contribution') {
        throw new Error(`Validate record is read-only and permits no editor mutation; ${operation} is not permitted.`);
      }
      if (mode === 'contribution-draft') {
        throw new Error(`Create contribution permits only one standalone draft plus manifest; editor mutation ${operation} is not permitted.`);
      }
      if (mode === 'assembly-metadata' && operation !== 'preview_assembly_metadata') {
        throw new Error(`Fix assembly blocker permits only one electronics.preview_assembly_metadata attempt; ${operation} is not permitted.`);
      }
      const advisor = advisorAgentAuthorizationRef.current;
      if (advisor?.mode === 'read-only') {
        throw new Error(`The active Advisor request is read-only; ${operation} is not permitted.`);
      }
      if (advisor?.mode === 'readiness-action' && operation !== 'apply_readiness_action') {
        throw new Error(`Stage safe fix permits only one electronics.apply_readiness_action attempt; ${operation} is not permitted.`);
      }
      if (advisor?.mode === 'assembly-metadata-batch' && operation !== 'preview_assembly_metadata_batch') {
        throw new Error(`Fix blockers permits only one electronics.preview_assembly_metadata_batch attempt; ${operation} is not permitted.`);
      }
      if (advisor?.mode === 'assembly-export' && operation !== 'export_assembly_handoff') {
        throw new Error(`Export assembly permits only one electronics.export_assembly_handoff attempt; ${operation} is not permitted.`);
      }
      if (advisor?.mode === 'connection-preview' && operation !== 'preview_connection') {
        throw new Error(`Wire one gap permits only one electronics.preview_connection attempt; ${operation} is not permitted.`);
      }
    };
    const api: ElectronicsEditorAPI = {
      getKind: () => kind,
      getCode: () => codeRef.current,
      getCircuitJson: deriveFresh,
      captureDesignReviewSnapshot: async () => {
        const source = codeRef.current;
        const evaluation = kind === 'json'
          ? (() => {
              const parsed = parseCircuitJsonProjection(source);
              return { circuitJson: parsed.circuitJson, evalError: parsed.error };
            })()
          : await evalTscircuitCode(source).then((result) => ({
              circuitJson: result.circuitJson,
              evalError: result.ok ? undefined : result.error,
            }));
        const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
        return {
          source,
          sourceOrigin: 'editor-buffer' as const,
          persistenceState: 'unknown' as const,
          circuitJson: copy(evaluation.circuitJson),
          ...(evaluation.evalError ? { evalError: evaluation.evalError } : {}),
          ...(projectGuidanceRef.current ? { loadedProjectGuidance: copy(projectGuidanceRef.current) } : {}),
          ...(partEvidenceReportRef.current ? { loadedPartEvidence: copy(partEvidenceReportRef.current) } : {}),
        };
      },
      inspect: async () => {
        const { circuitJson: fresh, evalError } = await deriveFresh();
        return { components: listComponents(fresh), nets: listNets(fresh), evalError };
      },
      lint: async () => {
        const { circuitJson: fresh, evalError } = await deriveFresh();
        return { findings: lintCircuit(fresh), evalError };
      },
      readiness: async () => {
        const { circuitJson: fresh, evalError } = await deriveFresh();
        return { report: buildReadinessReport(fresh, projectGuidanceRef.current, kind === 'tsx' ? codeRef.current : undefined, partEvidenceReportRef.current), evalError };
      },
      setProjectGuidance: (guidance) => {
        assertAgentMutationAllowed('set_project_guidance');
        if (activePcbRuleLensRef.current?.result.reference.kind === 'loaded-project-guidance') {
          clearPcbRuleLens();
        }
        projectGuidanceRef.current = guidance;
        setProjectGuidance(guidance);
      },
      proposeProjectTemplate: async (rawRequirements) => {
        assertAgentMutationAllowed('propose_project_template');
        assertEditable(kind, 'propose_project_template');
        const requirements = validateProjectTemplateRequirements(rawRequirements);
        const baseline = codeRef.current;
        const blank = classifyBlankEditableTsx(baseline);
        if (!blank.eligible) {
          throw new Error(`${blank.reason} Create a new blank .circuit.tsx or explicitly remove the existing design; this tool never overwrites or offers replace-anyway.`);
        }
        const current = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while blank-template eligibility was being checked. Request the template again.');
        }
        if (current.evalError) {
          throw new Error(`The current TSX failed evaluation and is not eligible for replacement: ${current.evalError}`);
        }
        assertNoProjectGuidanceContradiction(requirements, projectGuidanceRef.current);
        const nextSource = generateProjectTemplateSource(requirements);
        const proposed = await evalTscircuitCode(nextSource);
        if (!proposed.ok) throw new Error(`The generated template failed exact evaluation: ${proposed.error ?? 'evaluation failed'}`);
        const metadata = verifyProjectTemplateProjection(nextSource, proposed.circuitJson);
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while the template was being verified. Request the template again.');
        }
        const preview = await previewHighImpactEdit(nextSource, {
          actor: 'agent',
          operation: `propose_project_template:${metadata.templateId}`,
          label: `Propose ${getProjectTemplate(metadata.templateId).label}`,
        });
        preview.visual.projectTemplate = metadata;
        setPendingEditPreview({ ...preview, visual: { ...preview.visual, projectTemplate: metadata } });
        return {
          templateId: metadata.templateId,
          requirements: metadata.requirements,
          expectedRefs: metadata.expectedRefs,
          limitations: metadata.limitations,
          applied: false,
          requiresApproval: true,
          preview,
        };
      },
      setPartEvidenceReport: (report, binding) => {
        assertAgentMutationAllowed('set_part_evidence_report');
        clearPartTrustSpotlight();
        if (partAgentSessionModeRef.current === 'evidence') {
          if (!report) {
            if (partEvidenceRefreshStartedRef.current) {
              throw new Error('Check evidence permits only one electronics.part_evidence_report refresh.');
            }
            const evidenceGrant = partEvidenceSessionGrantRef.current;
            if (!evidenceGrant) {
              throw new Error('The Check evidence report grant was invalidated by a selection, source, history, or file change. The loaded report was preserved.');
            }
            partEvidenceSessionGrantRef.current = beginPartEvidenceSessionRefresh(evidenceGrant, codeRef.current, binding);
            partEvidenceRefreshStartedRef.current = true;
            partEvidenceReportRef.current = undefined;
            setPartEvidenceReport(undefined);
            return;
          }
          if (!partEvidenceRefreshStartedRef.current) {
            throw new Error('Check evidence accepts a refreshed report only from its one started electronics.part_evidence_report call.');
          }
          const evidenceGrant = partEvidenceSessionGrantRef.current;
          partEvidenceSessionGrantRef.current = undefined;
          if (!evidenceGrant) throw new Error('The Check evidence report refresh was already consumed. Select the intent again; no report was attached.');
          validatePartEvidenceSessionReport(evidenceGrant, codeRef.current, report, binding);
        }
        partEvidenceReportRef.current = report;
        partEvidenceReportBindingRef.current = binding;
        setPartEvidenceReport(report);
      },
      authorizePartEvidenceCandidate: (request) => {
        const mode = partAgentSessionModeRef.current;
        if (mode && mode !== 'contribution') {
          throw new Error('Only the trusted Validate record intent may use selected-part contribution authority.');
        }
        if (mode === 'contribution') {
          const grant = partEvidenceCandidateGrantRef.current;
          partEvidenceCandidateGrantRef.current = undefined;
          if (!grant) throw new Error('The Validate record attempt was already consumed or invalidated. Select it again.');
          validatePartEvidenceCandidateGrant(grant, codeRef.current, circuitJsonRef.current, request);
        }
      },
      authorizePartEvidenceDraft: (request) => {
        const mode = partAgentSessionModeRef.current;
        if (mode && mode !== 'contribution-draft') {
          throw new Error('Only the trusted Create contribution intent may use selected-part contribution-draft authority.');
        }
        if (mode === 'contribution-draft') {
          const grant = partEvidenceDraftGrantRef.current;
          partEvidenceDraftGrantRef.current = undefined;
          if (!grant) throw new Error('The Create contribution attempt was already consumed or invalidated. Select it again.');
          validatePartEvidenceCandidateGrant(grant, codeRef.current, circuitJsonRef.current, request);
        }
      },
      authorizeSimulationMatrixCreation: (fixture) => {
        const mode = simulationAgentSessionModeRef.current;
        if (mode && mode !== 'matrix') {
          throw new Error('Only the trusted Scenario matrix intent may create a matrix from a simulation session.');
        }
        if (mode === 'matrix') {
          const grant = simulationMatrixAgentGrantRef.current;
          if (!grant) throw new Error('The Scenario matrix attempt was already consumed or invalidated. Select it again.');
          simulationMatrixAgentGrantRef.current = consumeSimulationMatrixAgentGrant(grant, codeRef.current, fixture);
        }
      },
      authorizeAssemblyHandoffExport: () => {
        assertAgentMutationAllowed('export_assembly_handoff');
        const authorization = advisorAgentAuthorizationRef.current;
        if (authorization?.mode === 'assembly-export') {
          advisorAgentAuthorizationRef.current = consumeAdvisorAssemblyExport(authorization, codeRef.current);
        }
      },
      addPart: async (partKey, name) => {
        assertAgentMutationAllowed('add_part');
        assertEditable(kind, 'add_part');
        const part = findPart(partKey);
        if (!part) throw new Error(`Unknown part "${partKey}".`);
        const current = codeRef.current;
        const assigned = name?.trim() || nextRefDesignator(current, prefixForPart(part));
        const position = nextPlacement(current, part);
        const transaction = await updateCode(insertIntoBoard(current, part.jsx(assigned, position)), {
          actor: 'agent', operation: 'add_part', label: `Add ${assigned} (${part.label})`,
        });
        return { name: assigned, part: part.key, transaction };
      },
      addBlock: async (blockKey) => {
        assertAgentMutationAllowed('add_block');
        assertEditable(kind, 'add_block');
        const result = insertFunctionalBlock(codeRef.current, blockKey);
        const preview = await previewHighImpactEdit(result.code, {
          actor: 'agent', operation: 'add_block', label: `Add ${result.block} block`,
        });
        return {
          block: result.block,
          parts: result.parts,
          connections: result.connections,
          applied: false,
          requiresApproval: true,
          preview,
        };
      },
      connect: async (from, to) => {
        assertAgentMutationAllowed('connect');
        assertEditable(kind, 'connect');
        if (!from?.trim() || !to?.trim()) throw new Error('Both "from" and "to" selectors are required.');
        const transaction = await updateCode(insertIntoBoard(codeRef.current, buildTrace(from.trim(), to.trim())), {
          actor: 'agent', operation: 'connect', label: `Connect ${from.trim()} → ${to.trim()}`,
        });
        return { transaction };
      },
      previewConnection: async (request: ConnectionPreviewRequest) => {
        assertEditable(kind, 'preview_connection');
        const partMode = partAgentSessionModeRef.current;
        const partGrant = partConnectionGrantRef.current;
        const advisorMode = advisorAgentAuthorizationRef.current?.mode;
        const advisorGrant = advisorConnectionGrantRef.current;
        if (partMode === 'read-only' || advisorAgentAuthorizationRef.current) assertAgentMutationAllowed('preview_connection');
        if (partMode === 'wire') {
          partConnectionGrantRef.current = undefined;
          if (!partGrant) throw new Error('The Wire one port preview attempt was already consumed. Select the intent again; no preview was staged.');
        }
        if (advisorMode === 'connection-preview') {
          if (!advisorGrant) throw new Error('The Wire one gap preview attempt was already consumed. Select the intent again; no preview was staged.');
          advisorConnectionGrantRef.current = undefined;
          advisorConnectionGrantRef.current = consumeAdvisorConnectionGrantRequest(advisorGrant, codeRef.current, request);
        }
        assertConnectionPreviewProjectionFresh({
          loaded: loadedRef.current,
          currentSource: codeRef.current,
          projectedSource: derivedCodeRef.current,
          running: deriveRef.current.running,
          ok: deriveRef.current.ok,
          error: deriveRef.current.error,
        });
        const baseline = codeRef.current;
        const proposal = resolveConnectionProposal(circuitJsonRef.current, request);
        if (partGrant) {
          validatePartConnectionGrant(partGrant, baseline, proposal);
        }
        if (advisorMode === 'connection-preview' && advisorConnectionGrantRef.current) {
          validateAdvisorConnectionProposal(advisorConnectionGrantRef.current, proposal);
        }
        const nextSource = insertConnectionInCode(baseline, proposal);
        const preview = await previewHighImpactEdit(nextSource, {
          actor: 'agent',
          operation: 'preview_connection',
          label: `Connect ${proposal.from.selector} ↔ ${proposal.to.selector}`,
        }, undefined, undefined, undefined, proposal);
        return { from: proposal.from, to: proposal.to, applied: false, requiresApproval: true, preview };
      },
      previewAssemblyMetadata: async (request: AssemblyMetadataPreviewRequest) => {
        assertAgentMutationAllowed('preview_assembly_metadata');
        assertEditable(kind, 'preview_assembly_metadata');
        assertConnectionPreviewProjectionFresh({
          loaded: loadedRef.current,
          currentSource: codeRef.current,
          projectedSource: derivedCodeRef.current,
          running: deriveRef.current.running,
          ok: deriveRef.current.ok,
          error: deriveRef.current.error,
        });
        const grant = assemblyMetadataGrantRef.current;
        if (partAgentSessionModeRef.current === 'assembly-metadata') {
          assemblyMetadataGrantRef.current = undefined;
          if (!grant) throw new Error('The Fix assembly blocker preview attempt was already consumed. Select the intent again; no preview was staged.');
        }
        const proposal = prepareAssemblyMetadataProposal(codeRef.current, circuitJsonRef.current, request);
        if (grant) validateAssemblyMetadataAgentGrant(grant, codeRef.current, proposal);
        const preview = await previewHighImpactEdit(proposal.nextSource, {
          actor: 'agent',
          operation: 'preview_assembly_metadata',
          label: `Fix ${proposal.request.ref} assembly metadata`,
        }, undefined, undefined, undefined, undefined, proposal);
        if (!preview.visual.assemblyMetadata) throw new Error('Assembly metadata preview evidence was not attached.');
        return { metadata: preview.visual.assemblyMetadata, applied: false, requiresApproval: true, preview };
      },
      previewAssemblyMetadataBatch: async (request: AssemblyMetadataBatchRequest) => {
        assertAgentMutationAllowed('preview_assembly_metadata_batch');
        assertEditable(kind, 'preview_assembly_metadata_batch');
        assertConnectionPreviewProjectionFresh({
          loaded: loadedRef.current,
          currentSource: codeRef.current,
          projectedSource: derivedCodeRef.current,
          running: deriveRef.current.running,
          ok: deriveRef.current.ok,
          error: deriveRef.current.error,
        });
        const proposal = prepareAssemblyMetadataBatchProposal(codeRef.current, circuitJsonRef.current, request);
        if (advisorAgentAuthorizationRef.current?.mode === 'assembly-metadata-batch') {
          const grant = assemblyMetadataBatchGrantRef.current;
          if (!grant) throw new Error('The Assembly Fix Queue preview attempt was already consumed. Select Fix blockers again; no preview was staged.');
          assemblyMetadataBatchGrantRef.current = consumeAssemblyMetadataBatchAgentGrant(grant, codeRef.current, proposal);
        }
        const preview = await previewHighImpactEdit(proposal.nextSource, {
          actor: 'agent',
          operation: 'preview_assembly_metadata_batch',
          label: `Assembly Fix Queue · ${proposal.updates.map((update) => update.request.ref).join(', ')}`,
        }, undefined, undefined, undefined, undefined, undefined, proposal);
        if (!preview.visual.assemblyMetadataBatch) throw new Error('Assembly Fix Queue preview evidence was not attached.');
        return { metadata: preview.visual.assemblyMetadataBatch, applied: false, requiresApproval: true, preview };
      },
      removePart: async (name) => {
        assertAgentMutationAllowed('remove_part');
        assertEditable(kind, 'remove_part');
        const ref = name?.trim();
        if (!ref) throw new Error('A part ref designator (e.g. "R1") is required.');
        const result = removePartFromCode(codeRef.current, ref);
        if (!result.removed) throw new Error(`No part named "${ref}" found in the circuit.`);
        const preview = await previewHighImpactEdit(result.code, {
          actor: 'agent', operation: 'remove_part', label: `Remove ${ref}`,
        });
        return {
          name: ref,
          removedTraces: result.removedTraces,
          applied: false,
          requiresApproval: true,
          preview,
        };
      },
      removeConnection: async (from, to) => {
        assertAgentMutationAllowed('remove_connection');
        assertEditable(kind, 'remove_connection');
        if (!from?.trim() || !to?.trim()) throw new Error('Both "from" and "to" selectors are required.');
        const result = removeConnectionFromCode(codeRef.current, from.trim(), to.trim());
        if (!result.removed) throw new Error(`No trace connecting "${from}" and "${to}" was found.`);
        const transaction = await updateCode(result.code, {
          actor: 'agent', operation: 'remove_connection', label: `Disconnect ${from.trim()} ↔ ${to.trim()}`,
        });
        return { transaction };
      },
      updatePart: async (name, changes) => {
        assertAgentMutationAllowed('update_part');
        assertEditable(kind, 'update_part');
        const ref = name?.trim();
        if (!ref) throw new Error('A part ref designator (e.g. "R1") is required.');
        if (changes.value == null && changes.footprint == null && changes.manufacturerPartNumber == null) {
          throw new Error('Provide at least one of value, footprint, or manufacturerPartNumber to change.');
        }
        const result = updatePartInCode(codeRef.current, ref, changes);
        if (!result.found) throw new Error(`No part named "${ref}" found in the circuit.`);
        const transaction = await updateCode(result.code, {
          actor: 'agent', operation: 'update_part', label: `Update ${ref}: ${result.changed.join(', ')}`,
        });
        return { name: ref, changed: result.changed, transaction };
      },
      transformPart: async (name, options) => {
        assertAgentMutationAllowed('transform_part');
        assertEditable(kind, 'transform_part');
        const ref = name?.trim();
        if (!ref) throw new Error('A part ref designator is required.');
        const result = transformPartInCode(codeRef.current, ref, options);
        if (!result.found) throw new Error(`No part named "${ref}" found in the circuit.`);
        const transaction = result.changed.length
          ? await updateCode(result.code, {
            actor: 'agent', operation: 'transform_part', label: `Transform ${ref} on ${options.surface}`,
          })
          : undefined;
        return { name: ref, changed: result.changed, transaction };
      },
      duplicatePart: async (name, requestedName) => {
        assertAgentMutationAllowed('duplicate_part');
        assertEditable(kind, 'duplicate_part');
        const ref = name?.trim();
        if (!ref) throw new Error('A part ref designator is required.');
        const result = duplicatePartInCode(codeRef.current, ref, requestedName);
        if (!result.found || !result.name) throw new Error(`No part named "${ref}" found in the circuit.`);
        const transaction = await updateCode(result.code, {
          actor: 'agent', operation: 'duplicate_part', label: `Duplicate ${ref} as ${result.name}`,
        });
        return { sourceName: ref, name: result.name, transaction };
      },
      setBoard: async (opts) => {
        assertAgentMutationAllowed('set_board');
        assertEditable(kind, 'set_board');
        if (opts.width == null && opts.height == null) {
          throw new Error('Provide a width and/or height (e.g. "40mm").');
        }
        const result = setBoardSizeInCode(codeRef.current, opts);
        if (!result.changed) throw new Error('The requested board dimensions are already applied.');
        const preview = await previewHighImpactEdit(result.code, {
          actor: 'agent', operation: 'set_board', label: 'Update board size',
        });
        return { changed: true, applied: false, requiresApproval: true, preview };
      },
      previewGeometryChange: async (rawRequest) => {
        assertAgentMutationAllowed('preview_geometry_change');
        assertEditable(kind, 'preview_geometry_change');
        const request = validateGeometryChangeRequest(rawRequest);
        const layoutGrant = layoutAgentGrantRef.current;
        if (layoutGrant) {
          layoutAgentGrantRef.current = undefined;
          validateLayoutGeometryGrant(layoutGrant, codeRef.current, request);
        }
        const edit = applyAbsoluteGeometryInCode(codeRef.current, request);
        if (!edit.changed) throw new Error('The requested geometry does not change the source.');
        const refs = (request.parts ?? []).map((part) => part.ref);
        const label = refs.length > 0
          ? `Preview PCB geometry for ${refs.join(', ')}${request.board ? ' and board' : ''}`
          : 'Preview board geometry';
        const preview = await previewHighImpactEdit(edit.code, {
          actor: 'agent', operation: 'preview_geometry_change', label,
        }, request);
        return { targets: refs, applied: false, requiresApproval: true, preview };
      },
      previewMountingHoles: async (rawRequest) => {
        assertAgentMutationAllowed('preview_mounting_holes');
        assertEditable(kind, 'preview_mounting_holes');
        const edit = insertMountingHolesInCode(codeRef.current, rawRequest);
        const names = edit.request.holes.map((hole) => hole.name);
        const preview = await previewHighImpactEdit(edit.code, {
          actor: 'agent',
          operation: 'preview_mounting_holes',
          label: `Preview ${names.length} unplated mounting hole${names.length === 1 ? '' : 's'}: ${names.join(', ')}`,
        }, undefined, edit.request);
        return { holes: edit.request.holes, applied: false, requiresApproval: true, preview };
      },
      previewKeepouts: async (rawRequest) => {
        assertAgentMutationAllowed('preview_keepouts');
        assertEditable(kind, 'preview_keepouts');
        const edit = insertKeepoutsInCode(codeRef.current, rawRequest);
        const names = edit.request.keepouts.map((keepout) => keepout.name);
        const preview = await previewHighImpactEdit(edit.code, {
          actor: 'agent',
          operation: 'preview_keepouts',
          label: `Preview ${names.length} PCB keep-out${names.length === 1 ? '' : 's'}: ${names.join(', ')}`,
        }, undefined, undefined, edit.request);
        return { keepouts: edit.request.keepouts, applied: false, requiresApproval: true, preview };
      },
      measurePcb: async (request) => {
        const baseline = codeRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while PCB geometry was being measured. Request the measurement again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        const measurement = measurePcb(fresh.circuitJson, request);
        activePcbMeasurementRef.current = measurement;
        setActivePcbMeasurement(measurement);
        setTab('pcb');
        ensurePcbLayerVisible('annotations');
        return measurement.result;
      },
      clearPcbMeasurement,
      showPcbGrid: async (request) => {
        const baseline = codeRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while the PCB grid was being prepared. Request the grid again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        const grid = buildPcbGrid(fresh.circuitJson, request);
        activePcbGridRef.current = grid;
        setActivePcbGrid(grid);
        setTab('pcb');
        ensurePcbLayerVisible('annotations');
        return grid.result;
      },
      clearPcbGrid,
      proposePcbRoutes: async (options = {}) => {
        const baseline = codeRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while the autorouter input was being prepared. Request a new proposal.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        clearPcbRouteProposal();
        const controller = new AbortController();
        autorouteControllerRef.current = controller;
        try {
          const run = await runPcbAutorouter(fresh.circuitJson, { ...options, signal: controller.signal });
          const current = await deriveFresh();
          const currentHash = current.evalError ? undefined : await hashCircuitJson(current.circuitJson);
          if (baseline !== codeRef.current || current.evalError || currentHash !== run.inputHash) {
            throw new Error('The circuit projection changed while routes were being proposed. The stale proposal was refused; request it again.');
          }
          if (run.status === 'failed') {
            return {
              status: 'failed', inputHash: run.inputHash, traceCount: 0, layerCounts: {},
              solverProgress: run.solverProgress, diagnostics: run.diagnostics,
              durationMs: run.durationMs, overlayLineCount: 0,
              limitation: PCB_ROUTE_PROPOSAL_LIMITATION,
            };
          }
          const active = buildPcbRouteProposal(run);
          activePcbRouteProposalRef.current = active;
          setActivePcbRouteProposal(active);
          setTab('pcb');
          ensurePcbLayerVisible('annotations');
          return active.result;
        } finally {
          if (autorouteControllerRef.current === controller) autorouteControllerRef.current = undefined;
        }
      },
      clearPcbRouteProposal,
      showPcbRuleLens: async (request = {}) => {
        const baseline = codeRef.current;
        const referenceKind = request.reference ?? 'board-declarations';
        const guidanceBaseline = projectGuidanceRef.current;
        if (referenceKind === REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID && !request.profileAssumptions) {
          throw new Error('The reviewed fabrication profile requires explicit profile assumptions.');
        }
        const reviewedProfile = referenceKind === REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID
          ? getReviewedFabProfile(referenceKind, request.profileAssumptions!)
          : undefined;
        if (referenceKind !== REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID && request.profileAssumptions) {
          throw new Error('profile assumptions are accepted only with the exact reviewed fabrication profile reference.');
        }
        if (referenceKind === 'loaded-project-guidance' && !guidanceBaseline?.rules.pcbScalarMinimums) {
          throw new Error('Loaded project guidance does not declare rules.pcbScalarMinimums. Load reviewed guidance with at least one explicit scalar minimum, or use board-declarations.');
        }
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while PCB Rule Lens evidence was being prepared. Request it again.');
        }
        if (referenceKind === 'loaded-project-guidance' && guidanceBaseline !== projectGuidanceRef.current) {
          throw new Error('Loaded project guidance changed while PCB Rule Lens evidence was being prepared. Request it again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        const active = buildPcbRuleLens(fresh.circuitJson, referenceKind === 'loaded-project-guidance'
          ? { kind: 'loaded-project-guidance', minimums: { ...guidanceBaseline!.rules.pcbScalarMinimums! } }
          : reviewedProfile
            ? { kind: 'reviewed-fab-profile', profile: reviewedProfile }
            : { kind: 'board-declarations' });
        activePcbRuleLensRef.current = active;
        setActivePcbRuleLens(active);
        setTab('pcb');
        ensurePcbLayerVisible('annotations');
        return active.result;
      },
      clearPcbRuleLens,
      setPcbLayerView: async (request) => {
        const baseline = codeRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while the PCB layer view was being prepared. Request the layer view again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        if (!hasPcbElements(fresh.circuitJson)) throw new Error('The current evaluation has no PCB elements to inspect.');
        const overlayElements = [
          ...(activePcbGridRef.current?.overlayElements ?? []),
          ...(activePcbRouteProposalRef.current?.overlayElements ?? []),
          ...(activePcbRuleLensRef.current?.overlayElements ?? []),
          ...(activePcbMeasurementRef.current?.overlayElements ?? []),
          ...(activeConnectivityEvidenceRef.current?.overlayElements ?? []),
        ];
        const inventory = buildPcbLayerInventory([...fresh.circuitJson, ...overlayElements]);
        const activeSessionOverlays = [
          activePcbGridRef.current ? 'PCB coordinate grid' : undefined,
          activePcbRouteProposalRef.current ? 'PCB route proposal' : undefined,
          activePcbRuleLensRef.current ? 'PCB Rule Lens markers' : undefined,
          activePcbMeasurementRef.current ? 'PCB measurement' : undefined,
          activeConnectivityEvidenceRef.current ? 'connectivity evidence markers' : undefined,
        ].filter((value): value is string => Boolean(value));
        const resolved = resolvePcbLayerView(request, hiddenPcbLayersRef.current, inventory, activeSessionOverlays);
        hiddenPcbLayersRef.current = resolved.hidden;
        activePcbLayerViewRef.current = resolved.result;
        setHiddenPcbLayers(resolved.hidden);
        setActivePcbLayerView(resolved.result);
        setTab('pcb');
        return resolved.result;
      },
      clearPcbLayerView,
      showPartTrustSpotlight: async (request) => {
        const baseline = codeRef.current;
        const report = partEvidenceReportRef.current;
        const binding = partEvidenceReportBindingRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current || report !== partEvidenceReportRef.current || binding !== partEvidenceReportBindingRef.current) {
          throw new Error('The circuit or attached part-evidence report changed while Part Trust Spotlight was being prepared. Run the report and request again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        const result = buildPartTrustSpotlight(fresh.circuitJson, report, binding, request);
        const active = { source: baseline, result };
        clearAssemblyHandoffSpotlight();
        activePartTrustSpotlightRef.current = active;
        setActivePartTrustSpotlight(active);
        return result;
      },
      clearPartTrustSpotlight,
      showAssemblyHandoffSpotlight: async (request) => {
        const baseline = codeRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while Assembly Scout was being prepared. Request the spotlight again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        const result = buildAssemblyHandoffSpotlight(fresh.circuitJson, request);
        const active = { source: baseline, result };
        clearPartTrustSpotlight();
        activeAssemblyHandoffSpotlightRef.current = active;
        setActiveAssemblyHandoffSpotlight(active);
        setTab('schematic');
        return result;
      },
      clearAssemblyHandoffSpotlight,
      showConnectivityEvidence: async (request) => {
        const baseline = codeRef.current;
        const fresh = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while connectivity evidence was being prepared. Request the evidence again.');
        }
        if (fresh.evalError) throw new Error(`The current circuit cannot be evaluated: ${fresh.evalError}`);
        const evidence = buildConnectivityEvidence(fresh.circuitJson, request);
        activeConnectivityEvidenceRef.current = evidence;
        setActiveConnectivityEvidence(evidence);
        setTab('schematic');
        if (evidence.overlayElements.length > 0) {
          ensurePcbLayerVisible('annotations');
        }
        return evidence.result;
      },
      clearConnectivityEvidence,
      applyReadinessAction: async (actionId) => {
        assertAgentMutationAllowed('apply_readiness_action');
        const advisorAuthorization = advisorAgentAuthorizationRef.current;
        if (advisorAuthorization) {
          advisorAgentAuthorizationRef.current = consumeAdvisorReadinessAction(
            advisorAuthorization,
            codeRef.current,
            actionId,
          );
        }
        assertEditable(kind, 'apply_readiness_action');
        const baseline = codeRef.current;
        const current = await deriveFresh();
        if (baseline !== codeRef.current) {
          throw new Error('The circuit changed while readiness was being evaluated. Run electronics.readiness again.');
        }
        if (current.evalError) {
          throw new Error(`The current circuit cannot be evaluated: ${current.evalError}`);
        }
        const currentReport = buildReadinessReport(current.circuitJson, projectGuidanceRef.current, baseline);
        const edit = buildReadinessActionEdit(baseline, currentReport, actionId);
        const proposed = await evalTscircuitCode(edit.code);
        if (!proposed.ok) {
          throw new Error(`The proposed readiness action cannot be evaluated: ${proposed.error ?? 'evaluation failed'}`);
        }
        const proposedCheck = buildReadinessReport(proposed.circuitJson, projectGuidanceRef.current, edit.code)
          .checks.find((check) => check.id === edit.checkId);
        if (!proposedCheck || proposedCheck.status !== 'pass' || proposedCheck.automaticAction) {
          throw new Error('The proposed edit did not resolve the outline readiness check, so no preview was staged.');
        }
        const preview = await previewHighImpactEdit(edit.code, {
          actor: 'agent',
          operation: `apply_readiness_action:${edit.actionId}`,
          label: `Make board outline explicit (${edit.dimensions.widthMm} × ${edit.dimensions.heightMm} mm)`,
        });
        return {
          diagnostic: 'readiness',
          diagnosticId: edit.checkId,
          actionId: edit.actionId,
          dimensions: edit.dimensions,
          applied: false,
          requiresApproval: true,
          preview,
        };
      },
      resolveEditPreview: async (previewId, decision) => {
        assertAgentMutationAllowed('resolve_edit_preview');
        return resolveEditPreview(previewId, decision);
      },
      getEditHistory: () => editHistory,
      undo: async () => {
        assertAgentMutationAllowed('undo');
        return moveHistory('undo');
      },
      redo: async () => {
        assertAgentMutationAllowed('redo');
        return moveHistory('redo');
      },
      simulate: async (request, readFile) => {
        const { circuitJson: fresh } = await deriveFresh();
        return simulate({ circuitJson: fresh, code: codeRef.current, readFile }, request);
      },
      runTest: async (request, assertions, readFile) => {
        const { circuitJson: fresh } = await deriveFresh();
        return runFirmwareTest({ circuitJson: fresh, code: codeRef.current, readFile }, request, assertions);
      },
    };
    host.registerEditorAPI(api);
    return () => host.registerEditorAPI(null);
  }, [clearAssemblyHandoffSpotlight, clearPartTrustSpotlight, clearPcbGrid, clearPcbLayerView, clearPcbMeasurement, clearPcbRouteProposal, clearPcbRuleLens, editHistory, ensurePcbLayerVisible, host, kind, moveHistory, previewHighImpactEdit, resolveEditPreview, updateCode]);

  const findings = useMemo(() => [...lintCircuit(circuitJson), ...upstreamCheckFindings], [circuitJson, upstreamCheckFindings]);
  const components = useMemo(() => listComponents(circuitJson), [circuitJson]);
  const nets = useMemo(() => listNets(circuitJson), [circuitJson]);
  const readiness = useMemo(
    () => buildReadinessReport(circuitJson, projectGuidance, kind === 'tsx' ? code : undefined, partEvidenceReport),
    [circuitJson, code, kind, partEvidenceReport, projectGuidance],
  );
  const simulationResult = simulationRun?.result ?? null;
  const simulationFeedback = useMemo(
    () => deriveCanvasFeedback(circuitJson, simulationResult),
    [circuitJson, simulationResult],
  );
  const simulationAgentSnapshot = useMemo<SimulationAgentSnapshot | undefined>(() => {
    if (!simulationRun || simulationRun.source !== code) return undefined;
    try {
      return buildSimulationAgentSnapshot({
        runId: simulationRun.runId,
        result: simulationRun.result,
        feedback: simulationFeedback,
      });
    } catch {
      return undefined;
    }
  }, [code, simulationFeedback, simulationRun]);
  const canUndoAgentChange = agentChangeReveal
    ? canUndoRevealedTransaction(editHistory, agentChangeReveal.transactionId)
    : false;
  const selectedPart = useMemo(
    () => components.find((component) => component.id === selectedComponentId),
    [components, selectedComponentId],
  );
  const pairEvidence = useMemo(() => {
    if (pairSelection.phase !== 'ready' || !loaded || derivedCode !== code || derive.running || !derive.ok) return undefined;
    try {
      return buildPairEvidenceSnapshot(circuitJson, pairSelection.components);
    } catch {
      return undefined;
    }
  }, [circuitJson, code, derive.ok, derive.running, derivedCode, loaded, pairSelection]);
  const pairedComponentIds = pairSelection.phase === 'idle'
    ? []
    : pairSelection.components.map((entry) => entry.sourceComponentId);
  const layoutEvidence = useMemo(() => {
    if (layoutSelection.phase !== 'collecting' || layoutSelection.components.length < 2
      || !loaded || derivedCode !== code || derive.running || !derive.ok) return undefined;
    try {
      return buildLayoutEvidenceSnapshot(circuitJson, layoutSelection.components);
    } catch {
      return undefined;
    }
  }, [circuitJson, code, derive.ok, derive.running, derivedCode, layoutSelection, loaded]);
  const layoutComponentIds = layoutSelection.phase === 'collecting'
    ? layoutSelection.components.map((entry) => entry.sourceComponentId)
    : [];
  const layoutSelectionKey = layoutSelection.phase === 'collecting'
    ? layoutTargetKey(layoutSelection.components)
    : undefined;
  const partAgentContext = useMemo(
    () => selectedPart ? buildPartSelectionContext(selectedPart, circuitJson, {
      filePath: docName,
      surface: tab,
      editable: kind === 'tsx',
    }) : undefined,
    [circuitJson, docName, kind, selectedPart, tab],
  );
  const pinSelectionSnapshot = useMemo<PinSelectionSnapshot | undefined>(() => {
    if (!selectedPinTarget || !loaded || derivedCode !== code || derive.running || !derive.ok) return undefined;
    try {
      return buildPinSelectionSnapshot(circuitJson, selectedPinTarget);
    } catch {
      return undefined;
    }
  }, [circuitJson, code, derive.ok, derive.running, derivedCode, loaded, selectedPinTarget]);
  const pinSelectionConstellation = derivePinSelectionConstellation(pinSelectionSnapshot);
  const advisorAffectedGeometryResolution = useMemo(() => {
    if (!advisorAgentTarget || !loaded || derivedCode !== code || derive.running || !derive.ok) return undefined;
    return deriveAdvisorAffectedGeometry(advisorAgentTarget, {
      checks: readiness.checks,
      findings,
      nets,
      circuitJson,
    });
  }, [advisorAgentTarget, circuitJson, code, derive.ok, derive.running, derivedCode, findings, loaded, nets, readiness.checks]);
  const advisorAffectedGeometry = visibleAdvisorAffectedGeometry(advisorAffectedGeometryResolution, {
    targetValid: advisorAgentTarget != null,
    sourceValid: derivedCode === code,
    fileValid: loaded,
    evaluationValid: !derive.running && derive.ok,
    appliedRevealAuthoritative: agentChangeReveal != null,
  });
  const netDetectiveStory = useMemo(() => {
    if (!advisorAgentTarget || advisorAgentTarget.kind !== 'net' || !advisorAffectedGeometry) return undefined;
    try {
      const resolved = resolveAdvisorAgentTarget(advisorAgentTarget, { checks: readiness.checks, findings, nets });
      return resolved.kind === 'net' ? buildNetDetectiveStory(resolved.net, advisorAffectedGeometry) : undefined;
    } catch {
      return undefined;
    }
  }, [advisorAffectedGeometry, advisorAgentTarget, findings, nets, readiness.checks]);
  const evaluatorDiagnosticBeaconStory = useMemo(() => (
    advisorAffectedGeometry?.basis === 'evaluator-diagnostics'
      ? buildEvaluatorDiagnosticBeaconStory(advisorAffectedGeometry)
      : undefined
  ), [advisorAffectedGeometry]);
  const advisorAgentContext = useMemo(() => {
    if (!advisorAgentTarget) return undefined;
    try {
      const resolved = resolveAdvisorAgentTarget(advisorAgentTarget, { checks: readiness.checks, findings, nets });
      const context = resolved.kind === 'lint'
        ? buildFindingSelectionContext(resolved.finding, { filePath: docName, editable: kind === 'tsx' })
        : resolved.kind === 'readiness'
          ? buildReadinessSelectionContext(resolved.check, { filePath: docName, editable: kind === 'tsx' })
          : buildNetSelectionContext(resolved.net, { filePath: docName, surface: tab, editable: kind === 'tsx' });
      return advisorAffectedGeometry
        ? { ...context, description: appendAdvisorAffectedGeometryContext(context.description, advisorAffectedGeometry) }
        : context;
    } catch {
      return undefined;
    }
  }, [advisorAffectedGeometry, advisorAgentTarget, docName, findings, kind, nets, readiness.checks, tab]);
  const activeAgentContext = advisorAgentContext ?? passiveAgentContext ?? (pinSelectionSnapshot
    ? { label: `Pin ${pinSelectionSnapshot.selector}`, description: pinSelectionSnapshot.description }
    : partAgentContext);
  const editorContextItems = useMemo<EditorContextItem[]>(() => {
    if (advisorAgentContext && advisorAgentTarget) {
      return [buildSelectionContextItem(
        `advisor:${advisorAgentTargetKey(advisorAgentTarget)}`,
        advisorAgentContext,
        { icon: advisorAgentTarget.kind === 'net' ? 'hub' : 'fact_check', groupLabel: 'advisor evidence' },
      )];
    }
    if (passiveAgentContext) {
      return [buildSelectionContextItem(
        `context:${passiveAgentContext.label}`,
        passiveAgentContext,
        { icon: 'bookmark', groupLabel: 'editor context' },
      )];
    }
    if (pinSelectionSnapshot) {
      return [buildSelectionContextItem(
        `port:${pinSelectionSnapshot.sourcePortId}`,
        { label: `Pin ${pinSelectionSnapshot.selector}`, description: pinSelectionSnapshot.description },
        {
          icon: 'electrical_services',
          groupLabel: 'pins',
          data: {
            sourcePortId: pinSelectionSnapshot.sourcePortId,
            selector: pinSelectionSnapshot.selector,
            sourceComponentId: pinSelectionSnapshot.sourceComponentId,
            currentlyUntraced: pinSelectionSnapshot.currentlyUntraced,
            logicalTraceCount: pinSelectionSnapshot.logicalTraceCount,
          },
        },
      )];
    }

    const selectedIds = layoutSelection.phase === 'collecting'
      ? layoutSelection.components.map((entry) => entry.sourceComponentId)
      : pairSelection.phase === 'idle'
        ? []
        : pairSelection.components.map((entry) => entry.sourceComponentId);
    if (layoutSelection.phase === 'collecting' || pairSelection.phase !== 'idle') {
      return buildPartSelectionContextItems(components, selectedIds, circuitJson, {
        filePath: docName,
        surface: tab,
        editable: kind === 'tsx',
      });
    }
    return selectedPart
      ? [buildPartSelectionContextItem(selectedPart, circuitJson, {
          filePath: docName,
          surface: tab,
          editable: kind === 'tsx',
        })]
      : [];
  }, [advisorAgentContext, advisorAgentTarget, circuitJson, components, docName, kind, layoutSelection, pairSelection, passiveAgentContext, pinSelectionSnapshot, selectedPart, tab]);
  useEffect(() => {
    if (host.setEditorContextItems) {
      host.setEditorContextItems(editorContextItems.length ? editorContextItems : null);
    } else {
      host.setEditorContext?.(activeAgentContext ?? null);
    }
  }, [activeAgentContext, editorContextItems, host]);
  useEffect(() => () => {
    host.setEditorContextItems?.(null);
    if (!host.setEditorContextItems) host.setEditorContext?.(null);
  }, [host]);
  const commitAgentRequestAction = useCallback((action: AgentRequestAction) => {
    const next = reduceAgentRequestState(agentRequestStateRef.current, action);
    agentRequestStateRef.current = next;
    setAgentRequestState(next);
  }, []);
  const handleAgentProviderChange = useCallback((provider: AgentProvider) => {
    if (!isAgentProvider(provider)) return;
    setAgentProviderPreference({ provider, persistence: 'saving' });
    void persistAgentProviderPreference(host.storage, provider).then(setAgentProviderPreference);
  }, [host.storage]);
  const startAgentRequest = useCallback(async (options: {
    target: AgentRequestTarget;
    provider: AgentProvider;
    sessionName: string;
    prompt: string;
  }): Promise<void> => {
    const service = agentAIServiceBridge.get();
    if (!service) throw new Error('CutuCircuits AI sessions are unavailable in this host. No request was sent.');
    if (!isAgentProvider(options.provider)) throw new Error('The selected provider is unsupported. No request was sent.');
    const requestId = `${Date.now().toString(36)}-${++agentRequestSequenceRef.current}`;
    const target = normalizeAgentRequestTarget(options.target);
    const start = beginAgentRequest(agentRequestStateRef.current, {
      requestId,
      target,
      provider: options.provider,
      sessionName: options.sessionName,
      phase: 'pending',
      message: `Agent is working on “${target.label}” in a visibly named ${options.provider} session…`,
    });
    if (!start.accepted) throw new Error(start.reason ?? 'An agent request is already active. No duplicate session was started.');
    agentRequestStateRef.current = start.state;
    setAgentRequestState(start.state);
    try {
      await service.sendPrompt({ prompt: options.prompt, sessionName: options.sessionName, provider: options.provider });
      commitAgentRequestAction({
        type: 'success',
        requestId,
        message: 'Agent finished. Open Sessions to review the result.',
      });
    } catch (caught) {
      const hostMessage = caught instanceof Error && caught.message ? caught.message : String(caught || 'The host could not complete the agent session.');
      commitAgentRequestAction({
        type: 'error',
        requestId,
        message: `${hostMessage} A session may already have been created. Check Sessions before retrying. No automatic retry or provider fallback was attempted.`,
      });
    }
  }, [commitAgentRequestAction]);
  const handleAskSelectedPart = useCallback(async (
    part: ComponentSummary,
    request: string,
    provider: AgentProvider,
    intentId?: AgentRequestPreset['id'],
  ): Promise<void> => {
    const partPresets = buildPartRequestPresets();
    validatePartPresetSelection(partPresets, intentId, request);
    const freshness = getAgentSendAvailability({
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!freshness.allowed) throw new Error(freshness.reason ?? 'Wait for evaluation before sending. No request was sent.');
    if (pendingEditPreview) throw new Error('Resolve the current edit preview before asking about this part. No request was sent.');
    const latestProjection = circuitJsonRef.current;
    const currentPart = resolvePartFromLatestProjection(part.id, latestProjection);
    const context = buildPartSelectionContext(currentPart, latestProjection, {
      filePath: docName,
      surface: tab,
      editable: kind === 'tsx',
    });
    const wireIntent = intentId === 'part-wire';
    const evidenceIntent = intentId === 'part-evidence';
    const contributionIntent = intentId === 'part-validate-record';
    const contributionDraftIntent = intentId === 'part-create-contribution-draft';
    const assemblyFixIntent = intentId === 'part-fix-assembly';
    if (wireIntent && kind !== 'tsx') {
      throw new Error('Wire one port requires an editable .circuit.tsx source. No request was sent.');
    }
    const wireEvidence = wireIntent ? buildPartWireEvidence(latestProjection, currentPart) : undefined;
    const evidenceSnapshot = evidenceIntent
      ? partEvidenceReportRef.current
        ? buildSelectedPartEvidenceSnapshot(partEvidenceReportRef.current, currentPart, partEvidenceReportBindingRef.current)
        : buildDefaultPartEvidenceBootstrapSnapshot(currentPart)
      : undefined;
    const contributionGrant = contributionIntent || contributionDraftIntent
      ? createPartEvidenceCandidateGrant(codeRef.current, currentPart)
      : undefined;
    const assemblyMetadataGrant = assemblyFixIntent
      ? createAssemblyMetadataAgentGrant(codeRef.current, latestProjection, currentPart.id, currentPart.name)
      : undefined;
    const contributionDescription = contributionGrant ? JSON.stringify({
      selectedSourceComponentId: contributionGrant.sourceComponentId,
      selectedRef: contributionGrant.ref,
      currentMpn: contributionGrant.mpn,
      placedFootprint: contributionGrant.footprint,
      targetEvidenceFile: 'electronics.parts.json',
      classification: 'No candidate has been validated yet.',
    }) : undefined;
    const selectionDescription = wireEvidence
      ? JSON.stringify({ selection: context.description, wireEvidence: wireEvidence.description })
      : evidenceSnapshot
        ? JSON.stringify({ selection: context.description, partEvidence: evidenceSnapshot.description })
        : contributionDescription
          ? JSON.stringify({ selection: context.description, partRecordCandidate: contributionDescription })
          : assemblyMetadataGrant
            ? JSON.stringify({
              selection: context.description,
              assemblyTemplateBlocker: {
                selectedSourceComponentId: assemblyMetadataGrant.sourceComponentId,
                selectedRef: assemblyMetadataGrant.ref,
                supportedMissingFields: assemblyMetadataGrant.allowedFields,
                exactCurrentIssueCodes: buildAssemblyHandoffReport(latestProjection).parts.find((candidate) => candidate.sourceComponentId === assemblyMetadataGrant.sourceComponentId)?.issues.map((issue) => issue.code) ?? [],
                suppliedValues: 'none; ask the user explicitly',
              },
            })
      : context.description;
    const sessionName = buildAgentSessionName(wireIntent
      ? `${currentPart.name} Wire Scout`
      : evidenceIntent
        ? `${currentPart.name} Evidence Scout`
        : contributionDraftIntent
          ? `${currentPart.name} Contribution Draft`
        : contributionIntent
          ? `${currentPart.name} Record Check`
        : assemblyFixIntent
          ? `${currentPart.name} Assembly Fix`
        : currentPart.name);
    const prompt = buildPartAgentPrompt({
      selectionDescription,
      request,
      filePath: docName,
      intentId,
      evidenceBootstrap: evidenceSnapshot?.pathAuthority === 'default-bootstrap',
    });
    partAgentSessionModeRef.current = wireEvidence
      ? 'wire'
      : evidenceSnapshot
        ? 'evidence'
        : contributionDraftIntent
          ? 'contribution-draft'
          : contributionGrant
            ? 'contribution'
            : assemblyMetadataGrant
              ? 'assembly-metadata'
            : 'read-only';
    if (wireEvidence) partConnectionGrantRef.current = createPartConnectionGrant(codeRef.current, wireEvidence);
    if (evidenceSnapshot) partEvidenceSessionGrantRef.current = createPartEvidenceSessionGrant(codeRef.current, evidenceSnapshot);
    if (contributionGrant && contributionDraftIntent) partEvidenceDraftGrantRef.current = contributionGrant;
    else if (contributionGrant) partEvidenceCandidateGrantRef.current = contributionGrant;
    if (assemblyMetadataGrant) assemblyMetadataGrantRef.current = assemblyMetadataGrant;
    partEvidenceRefreshStartedRef.current = false;
    try {
      await startAgentRequest({
        target: { kind: 'part' as const, identity: `part:${currentPart.id}`, label: context.label },
        provider,
        sessionName,
        prompt,
      });
    } finally {
      finishPartAgentSession();
    }
  }, [docName, finishPartAgentSession, kind, pendingEditPreview, startAgentRequest, tab]);
  const handleAskSelectedPin = useCallback(async (
    request: string,
    provider: AgentProvider,
    intentId?: AgentRequestPreset['id'],
  ): Promise<void> => {
    const freshness = getAgentSendAvailability({
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!freshness.allowed) throw new Error(freshness.reason ?? 'Wait for evaluation before sending. No request was sent.');
    if (pendingEditPreview) throw new Error('Resolve the current edit preview before asking about this pin. No request was sent.');
    const target = selectedPinTargetRef.current;
    if (!target) throw new Error('The exact Pin Scout selection was cleared. Select the schematic pin again; no request was sent.');
    const snapshot = buildPinSelectionSnapshot(circuitJsonRef.current, target);
    const presets = buildPinRequestPresets(snapshot.currentlyUntraced);
    validatePinPresetSelection(presets, intentId, request);
    const wireIntent = intentId === 'pin-wire';
    if (wireIntent && kind !== 'tsx') {
      throw new Error('Wire this pin requires an editable .circuit.tsx source. No request was sent.');
    }
    const prompt = buildPinAgentPrompt({
      selectionDescription: snapshot.description,
      request,
      filePath: docName,
      intentId,
    });
    partAgentSessionModeRef.current = wireIntent ? 'wire' : 'read-only';
    if (wireIntent) partConnectionGrantRef.current = createPinConnectionGrant(codeRef.current, snapshot);
    try {
      await startAgentRequest({
        target: { kind: 'pin' as const, identity: snapshot.targetKey, label: `Pin ${snapshot.selector}` },
        provider,
        sessionName: buildPinAgentSessionName(snapshot.ref, snapshot.port),
        prompt,
      });
    } finally {
      finishPartAgentSession();
    }
  }, [docName, finishPartAgentSession, kind, pendingEditPreview, startAgentRequest]);
  const handleAskPair = useCallback(async (
    request: string,
    provider: AgentProvider,
  ): Promise<void> => {
    const freshness = getAgentSendAvailability({
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!freshness.allowed) throw new Error(freshness.reason ?? 'Wait for evaluation before sending. No request was sent.');
    const selection = pairSelectionRef.current;
    if (selection.phase !== 'ready') throw new Error('The Pair selection changed. Select exactly two parts again; no request was sent.');
    const latestProjection = circuitJsonRef.current;
    const resolved = resolvePairTargets(latestProjection, selection.components);
    const snapshot = buildPairEvidenceSnapshot(latestProjection, resolved);
    await startAgentRequest({
      target: { kind: 'pair', identity: snapshot.targetKey, label: `Pair: ${snapshot.refs.join(' + ')}` },
      provider,
      sessionName: buildPairAgentSessionName(snapshot.refs),
      prompt: buildPairAgentPrompt({ selectionDescription: snapshot.description, request, filePath: docName }),
    });
  }, [docName, startAgentRequest]);
  const handleAskLayout = useCallback(async (
    request: string,
    provider: AgentProvider,
    intentId?: AgentRequestPreset['id'],
  ): Promise<void> => {
    const freshness = getAgentSendAvailability({
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!freshness.allowed) throw new Error(freshness.reason ?? 'Wait for evaluation before sending. No request was sent.');
    if (pendingEditPreview) throw new Error('Resolve the current edit preview before starting Layout Crew. No request was sent.');
    const selection = layoutSelectionRef.current;
    if (selection.phase !== 'collecting') throw new Error('Layout Crew is not active. Select 2 to 12 PCB parts again; no request was sent.');
    const latestProjection = circuitJsonRef.current;
    const resolved = resolveLayoutTargets(latestProjection, selection.components);
    const snapshot = buildLayoutEvidenceSnapshot(latestProjection, resolved);
    validateLayoutPresetSelection(buildLayoutRequestPresets(), intentId, request);
    // Read-only preflight of the same conservative literal source seam the
    // eventual geometry preview must use. This prevents creating a doomed session.
    applyAbsoluteGeometryInCode(codeRef.current, {
      parts: snapshot.components.map((component) => ({
        ref: component.ref,
        pcbX: component.pcb.x,
        pcbY: component.pcb.y,
        pcbRotation: component.pcb.rotation,
      })),
    });
    layoutAgentGrantRef.current = { baseline: codeRef.current, refs: [...snapshot.refs] };
    try {
      await startAgentRequest({
        target: { kind: 'layout', identity: snapshot.targetKey, label: `Layout Crew: ${snapshot.refs.join(', ')}` },
        provider,
        sessionName: buildLayoutAgentSessionName(snapshot.refs),
        prompt: buildLayoutAgentPrompt({
          selectionDescription: snapshot.description,
          request,
          filePath: docName,
          refs: snapshot.refs,
        }),
      });
    } finally {
      layoutAgentGrantRef.current = undefined;
    }
  }, [docName, pendingEditPreview, startAgentRequest]);
  const handleAskSimulation = useCallback(async (
    request: string,
    provider: AgentProvider,
    intentId?: AgentRequestPreset['id'],
  ): Promise<void> => {
    const freshness = getAgentSendAvailability({
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!freshness.allowed) throw new Error(freshness.reason ?? 'Wait for evaluation before sending. No request was sent.');
    const run = simulationRunRef.current;
    if (!run || run.source !== codeRef.current) {
      throw new Error('The simulation evidence is missing or belongs to an earlier source. Run simulation again; no request was sent.');
    }
    const snapshot = buildSimulationAgentSnapshot({
      runId: run.runId,
      result: run.result,
      feedback: deriveCanvasFeedback(circuitJsonRef.current, run.result),
    });
    const currentPresets = buildSimulationRequestPresets({
      engine: run.result.engine,
      fixtureId: run.result.firmwareFixture?.id,
      resultOk: run.result.ok,
    });
    validateSimulationPresetSelection(currentPresets, intentId, request);
    const matrixIntent = intentId === 'create-simulation-matrix';
    simulationAgentSessionModeRef.current = matrixIntent ? 'matrix' : 'read-only';
    simulationMatrixAgentGrantRef.current = matrixIntent && run.result.firmwareFixture
      ? createSimulationMatrixAgentGrant(codeRef.current, run.result.firmwareFixture.id)
      : undefined;
    try {
      await startAgentRequest({
        target: { kind: 'simulation', identity: snapshot.targetKey, label: snapshot.label },
        provider,
        sessionName: buildSimulationAgentSessionName(run.result.engine, intentId),
        prompt: buildSimulationAgentPrompt({
          selectionDescription: snapshot.description,
          request,
          filePath: docName,
          intentId,
          fixtureId: run.result.firmwareFixture?.id,
        }),
      });
    } finally {
      simulationAgentSessionModeRef.current = undefined;
      simulationMatrixAgentGrantRef.current = undefined;
    }
  }, [docName, startAgentRequest]);
  const handleAskProjectTemplate = useCallback(async (
    request: string,
    provider: AgentProvider,
  ): Promise<void> => {
    if (!selectedProjectTemplateId) {
      throw new Error('The project template selection changed. Select it again; no request was sent.');
    }
    const availability = getProjectTemplateAgentAvailability({
      kind,
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!availability.allowed) throw new Error(availability.reason ?? 'The project template request is unavailable. No request was sent.');
    const templateId = selectedProjectTemplateId;
    const context = buildProjectTemplateSelectionContext({ filePath: docName, templateId });
    const prompt = buildProjectTemplateAgentPrompt({ templateId, selectionDescription: context.description, request });
    await startAgentRequest({
      target: {
        kind: 'project-template',
        identity: projectTemplateAgentTargetIdentity(templateId),
        label: context.label,
      },
      provider,
      sessionName: buildProjectTemplateAgentSessionName(templateId),
      prompt,
    });
  }, [docName, kind, selectedProjectTemplateId, startAgentRequest]);
  const handleAskAdvisorTarget = useCallback(async (
    target: AdvisorAgentTarget,
    request: string,
    provider: AgentProvider,
    intentId?: AgentRequestPreset['id'],
  ): Promise<void> => {
    const freshness = getAgentSendAvailability({
      loaded: loadedRef.current,
      currentSource: codeRef.current,
      projectedSource: derivedCodeRef.current,
      running: deriveRef.current.running,
      ok: deriveRef.current.ok,
      error: deriveRef.current.error,
    });
    if (!freshness.allowed) throw new Error(freshness.reason ?? 'Wait for evaluation before sending. No request was sent.');
    const latestProjection = circuitJsonRef.current;
    const latestFindings = lintCircuit(latestProjection);
    const latestNets = listNets(latestProjection);
    const latestReadiness = buildReadinessReport(
      latestProjection,
      projectGuidanceRef.current,
      kind === 'tsx' ? codeRef.current : undefined,
      partEvidenceReportRef.current,
    );
    const resolved = resolveAdvisorAgentTarget(target, {
      checks: latestReadiness.checks,
      findings: latestFindings,
      nets: latestNets,
    });
    const diagnosticOnly = isAdvisorAffectedGeometryTarget(resolved);
    const geometry = diagnosticOnly ? deriveAdvisorAffectedGeometry(target, {
      checks: latestReadiness.checks,
      findings: latestFindings,
      nets: latestNets,
      circuitJson: latestProjection,
    }) : undefined;
    if (geometry?.state === 'refused') {
      throw new Error(`${geometry.detail} No diagnostic request was sent.`);
    }
    const exactConnectivityMode = geometry?.state === 'resolved' ? geometry.exactConnectivityMode : undefined;
    const connectionPreviewEligible = getAdvisorConnectionEligibility(geometry).allowed;
    const advertisedActionId = resolved.kind === 'readiness' ? resolved.check.automaticAction?.id : undefined;
    const loadedGuidancePcbMinimums = resolved.kind === 'readiness'
      && resolved.check.id === 'project-guidance'
      && resolved.check.status === 'pass'
      ? projectGuidanceRef.current?.rules.pcbScalarMinimums
      : undefined;
    const assemblyExportReport = resolved.kind === 'readiness' && resolved.check.id === 'sourcing'
      ? buildAssemblyHandoffReport(latestProjection)
      : undefined;
    const assemblyExportEligible = Boolean(
      assemblyExportReport
      && assemblyExportReport.summary.total > 0
      && assemblyExportReport.summary.blocked === 0
      && assemblyExportReport.summary.ready === assemblyExportReport.summary.total,
    );
    validateAdvisorPresetSelection(buildAdvisorRequestPresets({
      kind: resolved.kind,
      diagnosticOnly,
      automaticActionId: advertisedActionId,
      readinessCheckId: resolved.kind === 'readiness' ? resolved.check.id : undefined,
      readinessStatus: resolved.kind === 'readiness' ? resolved.check.status : undefined,
      connectionPreviewEligible,
      loadedGuidancePcbRulesAvailable: Boolean(loadedGuidancePcbMinimums),
      assemblyExportEligible,
    }), intentId, request);
    const authorizedActionId = intentId === 'stage-readiness-action' ? advertisedActionId : undefined;
    const captureProjectGuidance = intentId === 'capture-project-guidance'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'project-guidance'
      && resolved.check.status !== 'pass';
    const inspectPcbRules = intentId === 'inspect-pcb-rules'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'project-guidance'
      && resolved.check.status === 'pass'
      && Boolean(loadedGuidancePcbMinimums);
    const inspectAssemblyHandoff = intentId === 'inspect-assembly-handoff'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'sourcing';
    const fixAssemblyHandoff = intentId === 'fix-assembly-handoff'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'sourcing';
    const exportAssemblyHandoff = intentId === 'export-assembly-handoff'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'sourcing'
      && assemblyExportEligible;
    const inspectEvaluatorDiagnostics = intentId === 'inspect-evaluator-diagnostics'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'evaluator-diagnostics'
      && resolved.check.status !== 'pass';
    const documentEvaluatorDiagnostic = intentId === 'document-evaluator-diagnostic'
      && resolved.kind === 'readiness'
      && resolved.check.id === 'evaluator-diagnostics'
      && resolved.check.status !== 'pass';
    const wireUnconnectedPorts = intentId === 'wire-unconnected-ports' && connectionPreviewEligible;
    if (fixAssemblyHandoff && kind !== 'tsx') {
      throw new Error('Assembly Fix Queue requires an editable .circuit.tsx source. No request was sent.');
    }
    if (wireUnconnectedPorts && kind !== 'tsx') {
      throw new Error('Wire one gap requires an editable .circuit.tsx source. No request was sent.');
    }
    const baseContext = resolved.kind === 'lint'
      ? buildFindingSelectionContext(resolved.finding, { filePath: docName, editable: kind === 'tsx' })
      : resolved.kind === 'readiness'
        ? buildReadinessSelectionContext(resolved.check, { filePath: docName, editable: kind === 'tsx' })
        : buildNetSelectionContext(resolved.net, { filePath: docName, surface: tab, editable: kind === 'tsx' });
    const context = geometry?.state === 'resolved'
      ? { ...baseContext, description: appendAdvisorAffectedGeometryContext(baseContext.description, geometry) }
      : baseContext;
    const requestContext = inspectPcbRules
      ? { ...context, description: appendLoadedGuidancePcbRuleContext(context.description, loadedGuidancePcbMinimums!) }
      : context;
    const sessionName = buildAgentSessionName(requestContext.label);
    const prompt = buildAdvisorAgentPrompt({
      kind: resolved.kind,
      selectionDescription: requestContext.description,
      request,
      automaticActionId: authorizedActionId,
      diagnosticOnly: captureProjectGuidance || inspectAssemblyHandoff || fixAssemblyHandoff || exportAssemblyHandoff || documentEvaluatorDiagnostic ? false : !authorizedActionId,
      exactConnectivityMode,
      captureProjectGuidance,
      inspectPcbRules,
      inspectAssemblyHandoff,
      fixAssemblyHandoff,
      exportAssemblyHandoff,
      inspectEvaluatorDiagnostics,
      documentEvaluatorDiagnostic,
      wireUnconnectedPorts,
    });
    const assemblyMetadataBatchGrant = fixAssemblyHandoff
      ? createAssemblyMetadataBatchAgentGrant(codeRef.current, latestProjection)
      : undefined;
    const advisorConnectionGrant = wireUnconnectedPorts && geometry
      ? createAdvisorConnectionGrant(codeRef.current, geometry, latestProjection)
      : undefined;
    advisorAgentAuthorizationRef.current = createAdvisorAgentAuthorization({
      currentSource: codeRef.current,
      kind: resolved.kind,
      intentId,
      advertisedActionId,
      readinessCheckId: resolved.kind === 'readiness' ? resolved.check.id : undefined,
      connectionPreviewEligible,
      assemblyExportEligible,
    });
    assemblyMetadataBatchGrantRef.current = assemblyMetadataBatchGrant;
    advisorConnectionGrantRef.current = advisorConnectionGrant;
    try {
      await startAgentRequest({
        target: { kind: resolved.kind, identity: advisorAgentTargetKey(target), label: requestContext.label },
        provider,
        sessionName,
        prompt,
      });
    } finally {
      advisorAgentAuthorizationRef.current = undefined;
      assemblyMetadataBatchGrantRef.current = undefined;
      advisorConnectionGrantRef.current = undefined;
    }
  }, [docName, kind, startAgentRequest, tab]);
  const problemCount = findings.filter((finding) => finding.severity !== 'info').length;
  const bomProjectionState = useMemo(() => {
    try {
      return { projection: buildBomProjection(circuitJson) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [circuitJson]);
  const resolvedTheme = dark ? 'dark' : 'light';
  const circuitLoading = !loaded || derivedCode !== code;
  const agentEvaluationAvailability = getAgentSendAvailability({
    loaded,
    currentSource: code,
    projectedSource: derivedCode,
    running: derive.running,
    ok: derive.ok,
    error: derive.error,
  });
  const agentAvailability = agentAIServiceBridge.get()
    ? agentEvaluationAvailability
    : { allowed: false, reason: 'CutuCircuits AI sessions are unavailable in this host. No request can be sent.' };
  const projectTemplateEvaluationAvailability = getProjectTemplateAgentAvailability({
    kind,
    loaded,
    currentSource: code,
    projectedSource: derivedCode,
    running: derive.running,
    ok: derive.ok,
    error: derive.error,
  });
  const projectTemplateAgentAvailability = agentAIServiceBridge.get()
    ? projectTemplateEvaluationAvailability
    : { allowed: false, reason: 'CutuCircuits AI sessions are unavailable in this host. No request can be sent.' };
  const advisorCard = useMemo(() => {
    if (!advisorAgentTarget) return undefined;
    const fallbackLabel = advisorAgentTarget.kind === 'readiness'
      ? `Check: ${advisorAgentTarget.checkId}`
      : advisorAgentTarget.kind === 'lint'
        ? `Finding: ${advisorAgentTarget.identity.nativeId ?? advisorAgentTarget.identity.rule ?? 'selected lint item'}`
        : `Net: ${advisorAgentTarget.name}`;
    try {
      const resolved = resolveAdvisorAgentTarget(advisorAgentTarget, { checks: readiness.checks, findings, nets });
      const context = resolved.kind === 'lint'
        ? buildFindingSelectionContext(resolved.finding, { filePath: docName, editable: kind === 'tsx' })
        : resolved.kind === 'readiness'
          ? buildReadinessSelectionContext(resolved.check, { filePath: docName, editable: kind === 'tsx' })
          : buildNetSelectionContext(resolved.net, { filePath: docName, surface: tab, editable: kind === 'tsx' });
      const diagnosticOnly = isAdvisorAffectedGeometryTarget(resolved);
      const connectionPreviewEligible = getAdvisorConnectionEligibility(advisorAffectedGeometryResolution).allowed;
      const assemblyExportReport = resolved.kind === 'readiness' && resolved.check.id === 'sourcing'
        ? buildAssemblyHandoffReport(circuitJson)
        : undefined;
      const assemblyExportEligible = Boolean(
        assemblyExportReport
        && assemblyExportReport.summary.total > 0
        && assemblyExportReport.summary.blocked === 0
        && assemblyExportReport.summary.ready === assemblyExportReport.summary.total,
      );
      const refusal = diagnosticOnly && advisorAffectedGeometryResolution?.state === 'refused'
        ? advisorAffectedGeometryResolution
        : undefined;
      const boundedContext = advisorAffectedGeometry
        ? { ...context, description: appendAdvisorAffectedGeometryContext(context.description, advisorAffectedGeometry) }
        : context;
      const defaultRequest = resolved.kind === 'net'
        ? NET_DETECTIVE_DEFAULT_REQUEST
        : diagnosticOnly
          ? ADVISOR_DIAGNOSTIC_DEFAULT_REQUEST
          : resolved.kind === 'readiness'
            && resolved.check.id === 'project-guidance'
            && resolved.check.status !== 'pass'
            ? PROJECT_GUIDANCE_CAPTURE_REQUEST
          : resolved.kind === 'readiness'
            && resolved.check.id === 'sourcing'
            ? ASSEMBLY_HANDOFF_INSPECT_REQUEST
          : resolved.kind === 'lint'
            ? 'Explain this exact finding and propose the smallest safe next step. Do not mutate the design.'
            : 'Explain this exact readiness check and propose the smallest safe next step. Do not mutate the design unless I explicitly choose Stage safe fix.';
      return {
        context: boundedContext,
        defaultRequest,
        requestPresets: buildAdvisorRequestPresets({
          kind: resolved.kind,
          diagnosticOnly,
          automaticActionId: resolved.kind === 'readiness' ? resolved.check.automaticAction?.id : undefined,
          readinessCheckId: resolved.kind === 'readiness' ? resolved.check.id : undefined,
          readinessStatus: resolved.kind === 'readiness' ? resolved.check.status : undefined,
          connectionPreviewEligible,
          loadedGuidancePcbRulesAvailable: Boolean(
            resolved.kind === 'readiness'
            && resolved.check.id === 'project-guidance'
            && resolved.check.status === 'pass'
            && projectGuidance?.rules.pcbScalarMinimums,
          ),
          assemblyExportEligible,
        }),
        description: resolved.kind === 'readiness'
          && resolved.check.id === 'project-guidance'
          && resolved.check.status !== 'pass'
          ? 'Selection alone never sends. Capture requirements asks for every value and path before one new local file can be created; review and load it separately.'
          : resolved.kind === 'readiness'
            && resolved.check.id === 'project-guidance'
            && resolved.check.status === 'pass'
            && projectGuidance?.rules.pcbScalarMinimums
          ? 'Selection alone never sends. Inspect PCB rules opens one read-only loaded-guidance Rule Lens observation; it does not edit, export, approve, or claim DRC/DFM/fabrication signoff.'
          : resolved.kind === 'readiness' && resolved.check.id === 'sourcing'
          ? assemblyExportEligible
            ? 'Selection alone never sends. Export assembly requires three explicit new workspace-relative paths and one strict complete installed-template export; it does not claim vendor-portal, orientation, stock, pricing, or manufacturing acceptance.'
            : 'Selection alone never sends. Inspect assembly runs one exact read-only completeness report; blocked designs can ask for an approval-gated metadata fix, but no partial export or vendor-acceptance claim is offered.'
          : resolved.kind === 'readiness' && resolved.check.id === 'evaluator-diagnostics' && resolved.check.status !== 'pass'
          ? 'Selection alone never sends. Inspect diagnostics reads only bounded native Circuit JSON *_error elements and exact ID joins; it does not edit or claim comprehensive ERC/DRC/DFM coverage.'
          : resolved.kind === 'readiness' && resolved.check.automaticAction
          ? 'Selection alone never sends. Only Stage safe fix can stage its one exact advertised preview; every other draft is editor-enforced read-only.'
          : connectionPreviewEligible
          ? 'Selection alone never sends. Wire one gap grants one exact preview attempt between authorized currently-untraced ports and stops at approval; every other draft is editor-enforced read-only.'
          : 'Selection alone never sends. This Advisor request is editor-enforced read-only and starts one visibly named session from the latest exact report.',
        availability: refusal
          ? { allowed: false, reason: `${refusal.detail} No diagnostic request can be sent.` }
          : agentAvailability,
      };
    } catch (caught) {
      return {
        context: { label: fallbackLabel, description: '' },
        defaultRequest: 'Re-inspect this selected Advisor item and explain the safest next step.',
        requestPresets: [],
        description: 'This Advisor target is no longer exact. Select it again; no request can be sent.',
        availability: { allowed: false, reason: caught instanceof Error ? caught.message : String(caught) },
      };
    }
  }, [advisorAffectedGeometry, advisorAffectedGeometryResolution, advisorAgentTarget, agentAvailability, circuitJson, docName, findings, kind, nets, projectGuidance, readiness.checks, tab]);
  const beginPairSelection = useCallback((preseed?: ComponentSummary) => {
    if (agentChangeReveal) return;
    clearLayoutSelection();
    const exact = preseed ? { sourceComponentId: preseed.id, ref: preseed.name } : undefined;
    const next = reducePairSelection({ phase: 'idle' }, { type: 'start', preseed: exact });
    pairSelectionRef.current = next;
    setPairSelection(next);
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setSelectedProjectTemplateId(undefined);
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    setWiring(false);
    setWireFrom(undefined);
    setTab('schematic');
  }, [agentChangeReveal, clearLayoutSelection]);
  const consumePairComponent = useCallback((part: ComponentSummary): boolean => {
    const current = pairSelectionRef.current;
    if (current.phase !== 'collecting') return false;
    const next = reducePairSelection(current, {
      type: 'select',
      component: { sourceComponentId: part.id, ref: part.name },
    });
    pairSelectionRef.current = next;
    setPairSelection(next);
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setSelectedProjectTemplateId(undefined);
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    return true;
  }, []);
  const selectComponentNormally = useCallback((part: ComponentSummary) => {
    clearPairSelection();
    clearLayoutSelection();
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    setSelectedProjectTemplateId(undefined);
    setSelectedComponentId(part.id);
    setSelectedPinTarget(undefined);
    setTab((current) => {
      if (current === 'pcb' && part.pcbComponentId) return 'pcb';
      if (part.schematicComponentId) return 'schematic';
      if (part.pcbComponentId) return 'pcb';
      return current === 'pcb' ? 'pcb' : 'schematic';
    });
  }, [clearLayoutSelection, clearPairSelection]);
  const handleAdvisorSelectComponent = useCallback((part: ComponentSummary) => {
    if (!consumePairComponent(part)) selectComponentNormally(part);
  }, [consumePairComponent, selectComponentNormally]);
  const handleSchematicSelectComponent = useCallback((sourceComponentId: string) => {
    const matches = components.filter((part) => part.id === sourceComponentId);
    if (pairSelectionRef.current.phase === 'collecting' && matches.length === 1 && consumePairComponent(matches[0])) return;
    clearPairSelection();
    clearLayoutSelection();
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    setSelectedProjectTemplateId(undefined);
    setSelectedComponentId(sourceComponentId);
    setSelectedPinTarget(undefined);
  }, [clearLayoutSelection, clearPairSelection, components, consumePairComponent]);
  const beginLayoutSelection = useCallback(() => {
    if (agentChangeReveal || pendingEditPreview) return;
    clearPairSelection();
    const next = reduceLayoutSelection({ phase: 'idle', components: [] }, { type: 'start' });
    layoutSelectionRef.current = next;
    setLayoutSelection(next);
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setSelectedProjectTemplateId(undefined);
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    setWiring(false);
    setWireFrom(undefined);
    setTab('pcb');
  }, [agentChangeReveal, clearPairSelection, pendingEditPreview]);
  const handlePcbSelectComponent = useCallback((sourceComponentId: string) => {
    if (layoutSelectionRef.current.phase === 'collecting') {
      if (agentRequestStateRef.current.request?.phase === 'pending'
        && agentRequestStateRef.current.request.target.kind === 'layout') return;
      const matches = components.filter((part) => part.id === sourceComponentId && part.pcbComponentId);
      if (matches.length !== 1) return;
      const next = reduceLayoutSelection(layoutSelectionRef.current, {
        type: 'toggle',
        component: { sourceComponentId: matches[0].id, ref: matches[0].name },
      });
      layoutSelectionRef.current = next;
      setLayoutSelection(next);
      return;
    }
    clearPairSelection();
    clearLayoutSelection();
    setAdvisorAgentTarget(undefined);
    setPassiveAgentContext(undefined);
    setSelectedProjectTemplateId(undefined);
    setSelectedComponentId(sourceComponentId);
    setSelectedPinTarget(undefined);
  }, [clearLayoutSelection, clearPairSelection, components]);
  const handleSelectFinding = useCallback((finding: LintFinding) => {
    clearPairSelection();
    clearLayoutSelection();
    setPassiveAgentContext(undefined);
    setSelectedProjectTemplateId(undefined);
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setAdvisorAgentTarget(createLintAgentTarget(finding, findings));
  }, [clearLayoutSelection, clearPairSelection, findings]);
  const handleSelectReadinessCheck = useCallback((check: ReadinessCheck) => {
    clearPairSelection();
    clearLayoutSelection();
    setPassiveAgentContext(undefined);
    setSelectedProjectTemplateId(undefined);
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setAdvisorAgentTarget(createReadinessAgentTarget(check));
  }, [clearLayoutSelection, clearPairSelection]);
  const handleSelectNet = useCallback((net: NetSummary) => {
    const idle: PairSelectionState = { phase: 'idle' };
    pairSelectionRef.current = idle;
    setPairSelection(idle);
    clearLayoutSelection();
    setPassiveAgentContext(undefined);
    setSelectedProjectTemplateId(undefined);
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setAdvisorAgentTarget(createNetAgentTarget(net));
  }, [clearLayoutSelection]);
  const handleInspectSchematicPin = useCallback((port: { id: string; selector: string }) => {
    if (!loadedRef.current || derivedCodeRef.current !== codeRef.current
      || deriveRef.current.running || !deriveRef.current.ok) {
      setSelectedPinTarget(undefined);
      return;
    }
    try {
      const target = { sourcePortId: port.id, selector: port.selector };
      const snapshot = buildPinSelectionSnapshot(circuitJsonRef.current, target);
      clearPairSelection();
      clearLayoutSelection();
      setAdvisorAgentTarget(undefined);
      setPassiveAgentContext(undefined);
      setSelectedProjectTemplateId(undefined);
      setSelectedComponentId(snapshot.sourceComponentId);
      setSelectedPinTarget(target);
    } catch {
      setSelectedPinTarget(undefined);
    }
  }, [clearLayoutSelection, clearPairSelection]);
  const handleSelectWirePort = useCallback(async (port: { id: string; selector: string }) => {
    clearPairSelection();
    clearLayoutSelection();
    setSelectedPinTarget(undefined);
    assertEditable(kind, 'click-to-wire');
    if (!wireFrom) {
      setWireFrom(port);
      return;
    }
    if (wireFrom.id === port.id) {
      setWireFrom(undefined);
      return;
    }
    await updateCode(insertIntoBoard(codeRef.current, buildTrace(wireFrom.selector, port.selector)), {
      actor: 'user', operation: 'click_to_wire', label: `Connect ${wireFrom.selector} → ${port.selector}`,
    });
    setWireFrom(undefined);
    setWiring(false);
  }, [clearLayoutSelection, clearPairSelection, kind, updateCode, wireFrom]);
  const handleUpdateSelectedPart = useCallback(async (part: ComponentSummary, changes: { value?: string; footprint?: string }) => {
    assertEditable(kind, 'property editing');
    if (changes.value == null && changes.footprint == null) return;
    const result = updatePartInCode(codeRef.current, part.name, changes);
    if (!result.found) throw new Error(`No part named "${part.name}" found in the source.`);
    await updateCode(result.code, {
      actor: 'user', operation: 'edit_part_properties', label: `Edit ${part.name}: ${result.changed.join(', ')}`,
    });
  }, [kind, updateCode]);
  const handleRemoveSelectedPart = useCallback(async (part: ComponentSummary) => {
    assertEditable(kind, 'remove part');
    const result = removePartFromCode(codeRef.current, part.name);
    if (!result.removed) throw new Error(`No part named "${part.name}" found in the source.`);
    await updateCode(result.code, { actor: 'user', operation: 'remove_part', label: `Remove ${part.name}` });
    setSelectedComponentId(undefined);
  }, [kind, updateCode]);
  const handleTransformSelectedPart = useCallback(async (options: { dx?: number; dy?: number; rotationDelta?: number }) => {
    if (!selectedPart || (tab !== 'schematic' && tab !== 'pcb')) return;
    assertEditable(kind, 'move/rotate');
    const result = transformPartInCode(codeRef.current, selectedPart.name, { surface: tab, ...options });
    if (!result.found) throw new Error(`No part named "${selectedPart.name}" found in the source.`);
    if (!result.changed.length) return;
    await updateCode(result.code, {
      actor: 'user',
      operation: 'transform_part',
      label: `${options.rotationDelta ? 'Rotate' : 'Move'} ${selectedPart.name} on ${tab}`,
      coalesceKey: `transform-${tab}-${selectedPart.name}`,
    });
  }, [kind, selectedPart, tab, updateCode]);
  const handleDuplicateSelectedPart = useCallback(async () => {
    if (!selectedPart) return;
    assertEditable(kind, 'duplicate part');
    const result = duplicatePartInCode(codeRef.current, selectedPart.name);
    if (!result.found || !result.name) throw new Error(`No part named "${selectedPart.name}" found in the source.`);
    await updateCode(result.code, {
      actor: 'user', operation: 'duplicate_part', label: `Duplicate ${selectedPart.name} as ${result.name}`,
    });
  }, [kind, selectedPart, updateCode]);
  const handleAddStarter = useCallback(async (blockKey: string) => {
    assertEditable(kind, 'project starter');
    const result = insertFunctionalBlock(codeRef.current, blockKey);
    await updateCode(result.code, {
      actor: 'user', operation: 'add_starter', label: `Start with ${result.block}`,
    });
  }, [kind, updateCode]);
  const projectTemplateEligible = kind === 'tsx'
    && loaded
    && derivedCode === code
    && !derive.running
    && derive.ok
    && classifyBlankEditableTsx(code).eligible;
  const handleSelectProjectTemplate = useCallback((templateId: ProjectTemplateId) => {
    if (!projectTemplateEligible) return;
    clearPairSelection();
    clearLayoutSelection();
    setSelectedComponentId(undefined);
    setSelectedPinTarget(undefined);
    setAdvisorAgentTarget(undefined);
    setSelectedProjectTemplateId(templateId);
    setPassiveAgentContext(buildProjectTemplateSelectionContext({ filePath: docName, templateId }));
  }, [clearLayoutSelection, clearPairSelection, docName, projectTemplateEligible]);
  const layoutRequestPending = agentRequestState.request?.phase === 'pending'
    && agentRequestState.request.target.kind === 'layout';
  const layoutAvailability = pendingEditPreview
    ? { allowed: false, reason: 'Resolve the current edit preview before asking Layout Crew.' }
    : !layoutEvidence
      ? { allowed: false, reason: 'Select 2 to 12 exact PCB parts with proven rectangle geometry.' }
      : agentAvailability;
  return (
    <div className="es-editor" data-theme={resolvedTheme} data-file-path={host.filePath} data-technical-details={showTechnicalDetails}>
      <header className="es-appbar">
        <div className="es-appbar-navigation">
          <nav className="es-tabs" aria-label="Circuit views">
            {TAB_META.filter((item) => ['schematic', 'pcb', '3d'].includes(item.id)).map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                className={tab === item.id ? 'es-tab es-tab-active' : 'es-tab'}
                aria-pressed={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                <span className="es-tab-label">{item.label}</span>
              </Button>
            ))}
          </nav>
        </div>
        <div className="es-appbar-actions">
          <Tooltip content={tab === 'pcb' ? 'PCB layers and selected parts' : 'Find and inspect circuit parts'}>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showParts}
              onClick={() => setShowParts((visible) => !visible)}
            >
              {tab === 'pcb' ? 'Layers' : 'Parts'}
            </Button>
          </Tooltip>
          <Tooltip content={`${problemCount} findings · readiness ${readiness.score}`}>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Review"
              aria-pressed={showAdvisor}
              onClick={() => setShowAdvisor((visible) => !visible)}
            >
              Review{problemCount > 0 && <span className="es-review-count">{problemCount}</span>}
            </Button>
          </Tooltip>
          <Menu
            triggerLabel="More circuit views and tools"
            trigger={(props) => <Button {...props} variant="ghost" size="sm">•••</Button>}
          >
            {TAB_META.filter((item) => !['schematic', 'pcb', '3d'].includes(item.id)).map((item) => (
              <MenuItem key={item.id} onClick={() => setTab(item.id)}>
                {item.id === 'code' ? 'Source' : item.label}
              </MenuItem>
            ))}
            {tab === 'schematic' && (
              <MenuItem
                disabled={agentChangeReveal != null}
                onClick={() => {
                  setShowParts(true);
                  pairSelection.phase === 'idle' ? beginPairSelection() : clearPairSelection();
                }}
              >
                {pairSelection.phase === 'idle' ? 'Pair parts' : 'Exit pair selection'}
              </MenuItem>
            )}
            {tab === 'pcb' && (
              <MenuItem
                disabled={kind !== 'tsx' || agentChangeReveal != null || pendingEditPreview != null || layoutRequestPending}
                onClick={() => {
                  setShowParts(true);
                  layoutSelection.phase === 'idle' ? beginLayoutSelection() : clearLayoutSelection();
                }}
              >
                {layoutSelection.phase === 'idle' ? 'Arrange parts' : 'Exit arrangement'}
              </MenuItem>
            )}
            <MenuItem onClick={() => host.openHistory()}>Document history</MenuItem>
            <MenuItem onClick={() => setShowTechnicalDetails((visible) => !visible)}>
              {showTechnicalDetails ? 'Hide technical details' : 'Technical details'}
            </MenuItem>
            <MenuItem onClick={() => setShowHelp(true)}>Help</MenuItem>
          </Menu>
        </div>
        <nav className="es-toolbar" aria-label="View tools">
          <div className="es-toolbar-stack">
            <div className="es-toolbar-right">
              {tab === 'schematic' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={wiring ? 'es-wire-toggle es-wire-toggle-active' : 'es-wire-toggle'}
                  aria-pressed={wiring}
                  disabled={kind !== 'tsx'}
                  onClick={() => {
                    setSelectedPinTarget(undefined);
                    clearPairSelection();
                    clearLayoutSelection();
                    setWiring((active) => !active);
                    setWireFrom(undefined);
                  }}
                  title={kind === 'tsx' ? 'Connect two schematic pins' : 'Click-to-wire requires editable TSX'}
                >
                  Wire
                </Button>
              )}
              {(tab === 'schematic' || tab === 'pcb') && selectedPart && (
                <Menu
                  triggerLabel={`Tools for ${selectedPart.name}`}
                  trigger={(props) => <Button {...props} variant="ghost" size="sm">{selectedPart.name}</Button>}
                >
                  <MenuItem onClick={() => setShowParts(true)}>Inspect part</MenuItem>
                  <MenuItem disabled={kind !== 'tsx'} onClick={() => handleTransformSelectedPart({ dx: -1 })}>Move left</MenuItem>
                  <MenuItem disabled={kind !== 'tsx'} onClick={() => handleTransformSelectedPart({ dy: 1 })}>Move up</MenuItem>
                  <MenuItem disabled={kind !== 'tsx'} onClick={() => handleTransformSelectedPart({ dy: -1 })}>Move down</MenuItem>
                  <MenuItem disabled={kind !== 'tsx'} onClick={() => handleTransformSelectedPart({ dx: 1 })}>Move right</MenuItem>
                  <MenuItem disabled={kind !== 'tsx'} onClick={() => handleTransformSelectedPart({ rotationDelta: 90 })}>Rotate clockwise</MenuItem>
                  <MenuItem disabled={kind !== 'tsx'} onClick={handleDuplicateSelectedPart}>Duplicate part</MenuItem>
                </Menu>
              )}
              <div className="es-history-controls" aria-label="Undo and redo">
                <Tooltip content="Undo last host transaction">
                  <Button variant="ghost" size="sm" onClick={() => void moveHistory('undo')} disabled={!editHistory.canUndo} aria-label="Undo">↶</Button>
                </Tooltip>
                <Tooltip content="Redo host transaction">
                  <Button variant="ghost" size="sm" onClick={() => void moveHistory('redo')} disabled={!editHistory.canRedo} aria-label="Redo">↷</Button>
                </Tooltip>
              </div>
            </div>
          </div>
        </nav>
      </header>

      {agentRequestState.request && (
        <div className={`es-agent-global-status es-agent-request-${agentRequestState.request.phase}`} role="status" aria-live="polite">
          <strong>✦ {agentRequestState.request.target.label}</strong>
          <span>{agentRequestState.request.message}</span>
        </div>
      )}
      <div className="es-body">
        {showParts && (tab === 'pcb'
          ? (
            <PcbLayersPanel
              layers={pcbLayers}
              hiddenLayers={hiddenPcbLayers}
              onHiddenLayersChange={handleHiddenPcbLayersChange}
              agentView={activePcbLayerView}
              onClearAgentView={clearPcbLayerView}
            >
              {layoutSelection.phase === 'collecting' && (
                <section className="es-layout-crew" aria-label="Layout Crew">
                  <header>
                    <div><small>Agent-first PCB placement</small><strong>✦ Layout Crew</strong></div>
                    <span>{layoutSelection.components.length}/12</span>
                  </header>
                  <p>Click PCB parts to add or remove them. Selection and typing do not edit source or start a session.</p>
                  <div className="es-layout-crew-chips" aria-label="Selected PCB parts">
                    {layoutSelection.components.map((component) => (
                      <button
                        key={component.sourceComponentId}
                        type="button"
                        disabled={layoutRequestPending}
                        aria-label={`Remove ${component.ref} from Layout Crew`}
                        onClick={() => {
                          const next = reduceLayoutSelection(layoutSelectionRef.current, { type: 'remove', sourceComponentId: component.sourceComponentId });
                          layoutSelectionRef.current = next;
                          setLayoutSelection(next);
                        }}
                      >{component.ref}<span>×</span></button>
                    ))}
                    {layoutSelection.components.length === 0 && <small>No PCB parts selected yet.</small>}
                  </div>
                  <div className="es-layout-crew-actions">
                    <button type="button" disabled={layoutRequestPending || layoutSelection.components.length === 0} onClick={() => {
                      const next = reduceLayoutSelection(layoutSelectionRef.current, { type: 'start' });
                      layoutSelectionRef.current = next;
                      setLayoutSelection(next);
                    }}>Clear selection</button>
                  </div>
                  {layoutEvidence && layoutSelectionKey && (
                    <AgentRequestCard
                      key={layoutSelectionKey}
                      targetKey={layoutSelectionKey}
                      title={`Layout agent · ${layoutEvidence.refs.length} PCB parts`}
                      description={`${layoutEvidence.refs.join(', ')} · evaluated rectangles on ${layoutEvidence.board.width} × ${layoutEvidence.board.height} mm board. The agent may stage one exact placement preview; no board resize.`}
                      defaultRequest={LAYOUT_DEFAULT_REQUEST}
                      requestPresets={buildLayoutRequestPresets()}
                      agentAvailability={layoutAvailability}
                      agentProviderPreference={agentProviderPreference}
                      agentRequestStatus={agentRequestState.request}
                      onAgentProviderChange={handleAgentProviderChange}
                      onAskAgent={handleAskLayout}
                    />
                  )}
                </section>
              )}
              {selectedPart && !selectedPinTarget && !advisorAgentTarget && pairSelection.phase === 'idle' && layoutSelection.phase === 'idle' && (
                <PartAgentRequestCard
                  part={selectedPart}
                  agentAvailability={agentAvailability}
                  agentProviderPreference={agentProviderPreference}
                  agentRequestStatus={agentRequestState.request}
                  onAgentProviderChange={handleAgentProviderChange}
                  onAskAgent={handleAskSelectedPart}
                />
              )}
              {selectedProjectTemplateId && (
                <TemplateAgentRequestCard
                  templateId={selectedProjectTemplateId}
                  agentAvailability={projectTemplateAgentAvailability}
                  agentProviderPreference={agentProviderPreference}
                  agentRequestStatus={agentRequestState.request}
                  onAgentProviderChange={handleAgentProviderChange}
                  onAskAgent={handleAskProjectTemplate}
                />
              )}
            </PcbLayersPanel>
          )
          : (
            <PartsPalette
              components={components}
              partEvidence={partEvidenceReport}
              selectedId={selectedComponentId}
              onSelectPart={selectComponentNormally}
              editable={kind === 'tsx'}
              onUpdatePart={handleUpdateSelectedPart}
              onRemovePart={handleRemoveSelectedPart}
              onAddStarter={handleAddStarter}
              projectTemplateEligible={projectTemplateEligible}
              selectedProjectTemplateId={selectedProjectTemplateId}
              onSelectProjectTemplate={handleSelectProjectTemplate}
              projectTemplateAgentAvailability={projectTemplateAgentAvailability}
              agentAvailability={agentAvailability}
              agentProviderPreference={agentProviderPreference}
              agentRequestStatus={agentRequestState.request}
              showAgentCard={!advisorAgentTarget && pairSelection.phase === 'idle'}
              onAgentProviderChange={handleAgentProviderChange}
              onAskAgent={handleAskSelectedPart}
              selectedPin={pinSelectionSnapshot}
              onAskPin={handleAskSelectedPin}
              onAskProjectTemplate={handleAskProjectTemplate}
              pairSelection={pairSelection}
              pairEvidence={pairEvidence}
              onStartPair={beginPairSelection}
              onChangePairSecond={() => {
                const next = reducePairSelection(pairSelectionRef.current, { type: 'change-second' });
                pairSelectionRef.current = next;
                setPairSelection(next);
              }}
              onClearPair={clearPairSelection}
              onAskPair={handleAskPair}
              pairStartDisabled={agentChangeReveal != null}
            />
          ))}
        <main className="es-workbench">
          <div className="es-canvas">
            {tab === 'schematic' && (
              <TscircuitSchematicPane
                circuitJson={circuitJson}
                loading={circuitLoading}
                dark={dark}
                onSelectSourceComponent={handleSchematicSelectComponent}
                onClearSelection={() => setSelectedComponentId(undefined)}
                onInspectPort={handleInspectSchematicPin}
                wiring={wiring}
                activePortId={wireFrom?.id}
                onSelectPort={handleSelectWirePort}
                selectedComponentId={selectedComponentId}
                pairedComponentIds={pairedComponentIds}
                advisorAffectedGeometry={advisorAffectedGeometry}
                connectivityEvidence={activeConnectivityEvidence}
                onClearConnectivityEvidence={clearConnectivityEvidence}
                partTrustSpotlight={activePartTrustSpotlight}
                onClearPartTrustSpotlight={clearPartTrustSpotlight}
                assemblyHandoffSpotlight={activeAssemblyHandoffSpotlight}
                onClearAssemblyHandoffSpotlight={clearAssemblyHandoffSpotlight}
                revealedComponentIds={revealEmphasisActive && agentChangeReveal?.phase === 'ready'
                  ? agentChangeReveal.affectedComponentIds
                  : []}
                revealedConnectivityKeys={revealEmphasisActive && agentChangeReveal?.phase === 'ready'
                  ? agentChangeReveal.affectedConnectivityKeys
                  : []}
                feedback={simulationFeedback}
                selectedPortId={pinSelectionSnapshot?.sourcePortId}
                pinTracePortIds={pinSelectionConstellation?.endpointSourcePortIds}
                pinTraceConnectivityKey={pinSelectionConstellation?.connectivityKey}
              />
            )}
            {tab === 'schematic' && wiring && (
              <div className="es-wire-banner">
                {wireFrom ? <><strong>{wireFrom.selector}</strong><span>Click a destination pin</span></> : <span>Click a source pin</span>}
                <button onClick={() => { setWiring(false); setWireFrom(undefined); }}>Cancel · Esc</button>
              </div>
            )}
            {tab === 'pcb' && (
              <TscircuitPcbPane
                circuitJson={circuitJson}
                loading={circuitLoading}
                dark={dark}
                selectedComponentId={selectedComponentId}
                onSelectSourceComponent={handlePcbSelectComponent}
                onClearSelection={() => setSelectedComponentId(undefined)}
                advisorAffectedGeometry={advisorAffectedGeometry}
                grid={activePcbGrid}
                onClearGrid={clearPcbGrid}
                routeProposal={activePcbRouteProposal}
                onClearRouteProposal={clearPcbRouteProposal}
                ruleLens={activePcbRuleLens}
                onClearRuleLens={clearPcbRuleLens}
                measurement={activePcbMeasurement}
                onClearMeasurement={clearPcbMeasurement}
                connectivityEvidence={activeConnectivityEvidence}
                onClearConnectivityEvidence={clearConnectivityEvidence}
                partTrustSpotlight={activePartTrustSpotlight}
                onClearPartTrustSpotlight={clearPartTrustSpotlight}
                assemblyHandoffSpotlight={activeAssemblyHandoffSpotlight}
                onClearAssemblyHandoffSpotlight={clearAssemblyHandoffSpotlight}
                revealedComponentIds={revealEmphasisActive && agentChangeReveal?.phase === 'ready'
                  ? agentChangeReveal.affectedComponentIds
                  : []}
                revealedConnectivityKeys={revealEmphasisActive && agentChangeReveal?.phase === 'ready'
                  ? agentChangeReveal.affectedConnectivityKeys
                  : []}
                feedback={simulationFeedback}
                hiddenLayers={hiddenPcbLayers}
                onLayersChange={setPcbLayers}
                layoutComponentIds={layoutComponentIds}
                editing={{
                  enabled: manualEditing.enabled && manualEditing.status !== 'saving',
                  status: manualEditing.status,
                  message: manualEditing.message,
                  onEnable: handleEnableManualEditing,
                  onCommit: handleCommitManualEditEvents,
                  canUndo: hostReceiptHistory.applied.length > 0,
                  canRedo: hostReceiptHistory.redo.length > 0,
                  onUndo: () => handleManualHistory('undo'),
                  onRedo: () => handleManualHistory('redo'),
                }}
              />
            )}
            {tab === '3d' && (
              <Tscircuit3dPane
                circuitJson={circuitJson}
                loading={circuitLoading}
              />
            )}
            {tab === 'bom' && (bomProjectionState.projection
              ? <BomPanel
                  projection={bomProjectionState.projection}
                  selectedComponentId={selectedComponentId}
                  openExternal={host.openExternal?.bind(host)}
                  onSelectRef={(sourceComponentId) => {
                    const matches = components.filter((part) => part.id === sourceComponentId);
                    if (matches.length === 1) selectComponentNormally(matches[0]);
                  }}
                />
              : <div className="es-bom-error" role="alert"><strong>BOM projection unavailable</strong><span>{bomProjectionState.error}</span></div>)}
            {tab === 'assembly' && (
              <TscircuitAssemblyDirectPane
                circuitJson={circuitJson}
                loading={circuitLoading}
                selectedSourceComponentId={selectedComponentId}
                onSelectSourceComponent={(sourceComponentId) => {
                  const matches = components.filter((part) => part.id === sourceComponentId);
                  if (matches.length !== 1) return;
                  clearPairSelection();
                  clearLayoutSelection();
                  setAdvisorAgentTarget(undefined);
                  setPassiveAgentContext(undefined);
                  setSelectedProjectTemplateId(undefined);
                  setSelectedComponentId(sourceComponentId);
                  setSelectedPinTarget(undefined);
                }}
                onOpenBom={() => setTab('bom')}
              />
            )}
            {tab === 'code' && (
              <div className="es-code-shell">
                <div className="es-code-gutter"><span>TSX</span><small>live source</small></div>
                <textarea
                  className="es-code"
                  spellCheck={false}
                  value={code}
                  onChange={(event) => {
                    const next = event.target.value;
                    approvalQueueRef.current.clear();
                    setPendingEditPreview(undefined);
                    setAgentChangeReveal(undefined);
                    codeRef.current = next;
                    setCode(next);
                    markDirty();
                  }}
                  placeholder={kind === 'tsx' ? 'Describe the circuit with tscircuit JSX…' : 'Circuit JSON…'}
                />
              </div>
            )}
            {tab === 'simulate' && (
              <SimulationPanel
                circuitJson={circuitJson}
                sourceIdentity={code}
                runAvailability={agentEvaluationAvailability}
                result={simulationResult}
                onResult={handleSimulationResult}
                onClear={clearSimulationRun}
                agentSnapshot={simulationAgentSnapshot}
                agentAvailability={simulationAgentSnapshot ? agentAvailability : {
                  allowed: false,
                  reason: 'Run simulation against the latest successful projection before asking. No request can be sent.',
                }}
                agentProviderPreference={agentProviderPreference}
                agentRequestStatus={agentRequestState.request}
                onAgentProviderChange={handleAgentProviderChange}
                onAskAgent={handleAskSimulation}
              />
            )}
          </div>
        </main>
        {showAdvisor && (
          <DesignAdvisor
            report={readiness}
            partEvidence={partEvidenceReport}
            findings={findings}
            components={components}
            nets={nets}
            activeContextLabel={activeAgentContext?.label}
            activeAdvisorTargetKey={advisorAgentTarget ? advisorAgentTargetKey(advisorAgentTarget) : undefined}
            netDetectiveStory={netDetectiveStory}
            evaluatorDiagnosticBeaconStory={evaluatorDiagnosticBeaconStory}
            pairComponentIds={pairedComponentIds}
            agentRequestCard={advisorAgentTarget && advisorCard ? (
              <AgentRequestCard
                key={advisorAgentTargetKey(advisorAgentTarget)}
                targetKey={advisorAgentTargetKey(advisorAgentTarget)}
                title={`Ask agent · ${advisorCard.context.label.replace(/^[^:]+:\s*/, '')}`}
                description={advisorCard.description}
                defaultRequest={advisorCard.defaultRequest}
                requestPresets={advisorCard.requestPresets}
                agentAvailability={advisorCard.availability}
                agentProviderPreference={agentProviderPreference}
                agentRequestStatus={agentRequestState.request}
                onAgentProviderChange={handleAgentProviderChange}
                onAskAgent={(request, provider, intentId) => handleAskAdvisorTarget(advisorAgentTarget, request, provider, intentId)}
              />
            ) : undefined}
            onSelectCheck={handleSelectReadinessCheck}
            onSelectFinding={handleSelectFinding}
            onSelectComponent={handleAdvisorSelectComponent}
            onSelectNet={handleSelectNet}
            onClose={() => setShowAdvisor(false)}
          />
        )}
      </div>

      {showHelp && (
        <HelpOverlay
          kind={kind}
          openExternal={host.openExternal?.bind(host)}
          onClose={() => setShowHelp(false)}
        />
      )}
      {pendingEditPreview && (
        <EditPreviewDialog
          preview={pendingEditPreview}
          onApply={() => resolveEditPreview(pendingEditPreview.approvalId, 'apply')}
          onCancel={() => resolveEditPreview(pendingEditPreview.approvalId, 'cancel')}
        />
      )}
      {agentChangeReveal && (
        <AgentChangeRevealCard
          reveal={agentChangeReveal}
          canUndo={canUndoAgentChange}
          onUndo={() => {
            if (!canUndoRevealedTransaction(editHistory, agentChangeReveal.transactionId)) return;
            void moveHistory('undo');
          }}
          onViewDiff={() => {
            host.openHistory();
            setAgentChangeReveal(undefined);
          }}
          onClose={() => setAgentChangeReveal(undefined)}
        />
      )}

      <footer className="es-status">
        <span className="es-status-kind">{kind === 'tsx' ? 'TSCIRCUIT' : 'CIRCUIT JSON'}</span>
        <span><b>{components.length}</b> parts</span>
        <span><b>{nets.length}</b> nets</span>
        <span className="es-status-spacer" />
        <span className="es-attribution">Powered by tscircuit</span>
        {kind === 'tsx' && <button className="es-status-refresh" type="button" onClick={() => { forceEvaluation.current = true; setEvaluationRevision((value) => value + 1); }} title="Evaluate the current source again">Refresh circuit</button>}
        {kind === 'tsx' && (
          (!loaded || derivedCode !== code || derive.running)
            ? <span className="es-status-eval"><i /> evaluating</span>
            : derive.ok
              ? <span className="es-status-ok"><i /> {derive.cached ? 'cached' : 'live'}{derive.durationMs != null ? ` · ${derive.durationMs}ms` : ''}</span>
              : <span className="es-status-err" title={derive.error}><i /> {truncate(derive.error)}</span>
        )}
      </footer>
    </div>
  );
}

function EditPreviewDialog({
  preview,
  onApply,
  onCancel,
}: {
  preview: PendingEditPreview;
  onApply: () => unknown;
  onCancel: () => unknown;
}) {
  const { before, after } = preview.visual;
  return (
    <div className="es-edit-preview-backdrop" role="presentation">
      <section className="es-edit-preview" role="dialog" aria-modal="true" aria-label="Review proposed edit">
        <header>
          <div><small>High-impact edit · not applied</small><strong>{preview.label}</strong></div>
          <button className="es-icon-button" onClick={onCancel} aria-label="Cancel proposed edit">×</button>
        </header>
        <div className="es-edit-preview-impact">
          <div><small>Parts</small><strong>{before.components} → {after.components}</strong></div>
          <div><small>Connections</small><strong>{before.connections} → {after.connections}</strong></div>
          <div><small>PCB items</small><strong>{before.pcbComponents} → {after.pcbComponents}</strong></div>
          <div><small>Board geometry</small><strong>{before.boardGeometry} → {after.boardGeometry}</strong></div>
        </div>
        {(preview.visual.addedComponents.length > 0 || preview.visual.removedComponents.length > 0) && (
          <p className="es-edit-preview-components">
            {preview.visual.addedComponents.length > 0 && <span>Adding: {preview.visual.addedComponents.join(', ')}</span>}
            {preview.visual.removedComponents.length > 0 && <span>Removing: {preview.visual.removedComponents.join(', ')}</span>}
          </p>
        )}
        {preview.visual.limitation && <p className="es-edit-preview-warning">Visual comparison limited: {preview.visual.limitation}</p>}
        {preview.visual.connection && <ConnectionPreviewPanel preview={preview.visual.connection} />}
        {preview.visual.assemblyMetadata && <AssemblyMetadataPreviewPanel preview={preview.visual.assemblyMetadata} />}
        {preview.visual.assemblyMetadataBatch && <AssemblyMetadataBatchPreviewPanel preview={preview.visual.assemblyMetadataBatch} />}
        {preview.visual.geometry && <GeometryPreviewPanel geometry={preview.visual.geometry} />}
        {preview.visual.mountingHoles && <MountingHolePreviewPanel preview={preview.visual.mountingHoles} />}
        {preview.visual.keepouts && <KeepoutPreviewPanel preview={preview.visual.keepouts} />}
        {preview.visual.projectTemplate && <ProjectTemplatePreviewPanel preview={preview.visual.projectTemplate} />}
        <div className="es-edit-preview-diff">
          <label>Before</label><pre>{preview.beforePreview || '(empty)'}</pre>
          <label>After</label><pre>{preview.afterPreview || '(empty)'}</pre>
        </div>
        <footer>
          <span>Approval {preview.approvalId} applies only to this exact source state.</span>
          <button onClick={onCancel}>Cancel</button>
          <button className="es-edit-preview-apply" onClick={onApply}>Apply edit</button>
        </footer>
      </section>
    </div>
  );
}

function AssemblyMetadataPreviewPanel({ preview }: { preview: NonNullable<PendingEditPreview['visual']['assemblyMetadata']> }) {
  const value = (candidate?: string) => candidate ?? 'missing';
  return (
    <section className="es-geometry-preview" aria-label="Exact assembly metadata proposal">
      <div className="es-geometry-deltas">
        <p><strong>Assembly blocker proposal · not applied</strong><span>{preview.ref} · {preview.sourceComponentId}</span></p>
        <p><strong>Footprint</strong><span>{value(preview.before.footprint)} → {value(preview.after.footprint)}{preview.requested.footprint && preview.requested.footprint !== preview.after.footprint ? ` (source literal ${preview.requested.footprint})` : ''}</span></p>
        <p><strong>LCSC</strong><span>{value(preview.before.lcscPartNumber)} → {value(preview.after.lcscPartNumber)}</span></p>
        <p><strong>Resolved blockers</strong><span>{preview.resolvedIssues.join(', ') || 'none'}</span></p>
        <p><strong>Remaining blockers</strong><span>{preview.remainingIssues.join(', ') || 'none'} · {preview.readyForTemplate ? 'template-complete' : 'still blocked'}</span></p>
        <small>{preview.limitations.join(' ')}</small>
      </div>
    </section>
  );
}

function AssemblyMetadataBatchPreviewPanel({ preview }: { preview: NonNullable<PendingEditPreview['visual']['assemblyMetadataBatch']> }) {
  return (
    <section className="es-geometry-preview" aria-label="Atomic Assembly Fix Queue proposal">
      <div className="es-geometry-deltas">
        <p><strong>Assembly Fix Queue · not applied</strong><span>{preview.counts.updates} parts · {preview.counts.resolvedIssues} blockers resolved · {preview.counts.readyForTemplate} template-complete</span></p>
        {preview.changes.map((change) => <p key={change.sourceComponentId}>
          <strong>{change.ref}</strong>
          <span>{change.requested.footprint ? `footprint ${change.requested.footprint} → ${change.after.footprint}` : ''}{change.requested.footprint && change.requested.lcscPartNumber ? ' · ' : ''}{change.requested.lcscPartNumber ? `LCSC ${change.requested.lcscPartNumber}` : ''}</span>
          <span>resolved {change.resolvedIssues.join(', ')} · remaining {change.remainingIssues.join(', ') || 'none'}</span>
        </p>)}
        <small>{preview.limitations.join(' ')}</small>
      </div>
    </section>
  );
}

function ConnectionPreviewPanel({ preview }: { preview: NonNullable<PendingEditPreview['visual']['connection']> }) {
  return (
    <section className="es-geometry-preview" aria-label="Exact source-level connection proposal">
      <div className="es-geometry-deltas">
        <p><strong>Wire proposal · not applied</strong><span>{preview.from.selector} ↔ {preview.to.selector}</span></p>
        <p><strong>Exact live ports</strong><span>{preview.from.sourcePortId} ↔ {preview.to.sourcePortId}</span></p>
        <p><strong>Evaluated result</strong><span>One proposed source trace · {preview.addedConnectivityKey ?? 'connectivity key not supplied'}</span></p>
        <small>{preview.limitation}</small>
      </div>
    </section>
  );
}

function ProjectTemplatePreviewPanel({
  preview,
}: {
  preview: NonNullable<PendingEditPreview['visual']['projectTemplate']>;
}) {
  const requirements = preview.requirements;
  return (
    <section className="es-template-preview" aria-label="Project template requirements and limitations">
      <strong>{preview.templateId}</strong>
      <p>Fixed board: {preview.board.widthMm} × {preview.board.heightMm} mm · {preview.board.layers} layers · refs: {preview.expectedRefs.join(', ')}</p>
      <dl>
        <div><dt>Power</dt><dd>{requirements.powerSource}</dd></div>
        <div><dt>Interface</dt><dd>{requirements.interface}</dd></div>
        <div><dt>Connector</dt><dd>{requirements.connector}</dd></div>
        <div><dt>Environment</dt><dd>{requirements.environment}</dd></div>
        <div><dt>Quantity</dt><dd>{requirements.quantity}</dd></div>
        <div><dt>Assembly</dt><dd>{requirements.assembly}</dd></div>
        <div><dt>Target</dt><dd>{requirements.targetFab}</dd></div>
        <div><dt>Maximum</dt><dd>{requirements.maxWidthMm} × {requirements.maxHeightMm} mm</dd></div>
      </dl>
      <p className="es-edit-preview-warning">Limitations: {preview.limitations.join(' ')}</p>
    </section>
  );
}

function formatDelta(value: number, unit = 'mm'): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(3)} ${unit}`;
}

function GeometryPreviewPanel({ geometry }: { geometry: NonNullable<PendingEditPreview['visual']['geometry']> }) {
  const boards = [geometry.before.board, geometry.after.board];
  const parts = [...geometry.before.parts, ...geometry.after.parts];
  // Use each rotated part's circumradius so proposals outside the current
  // outline remain visible instead of being clipped from the review map.
  const partBounds = parts.flatMap((part) => {
    const radius = Math.hypot(part.width, part.height) / 2;
    return [
      { x: part.x - radius, y: part.y - radius },
      { x: part.x + radius, y: part.y + radius },
    ];
  });
  const minX = Math.min(...boards.map((board) => board.x - board.width / 2), ...partBounds.map((point) => point.x));
  const maxX = Math.max(...boards.map((board) => board.x + board.width / 2), ...partBounds.map((point) => point.x));
  const minY = Math.min(...boards.map((board) => board.y - board.height / 2), ...partBounds.map((point) => point.y));
  const maxY = Math.max(...boards.map((board) => board.y + board.height / 2), ...partBounds.map((point) => point.y));
  const padding = Math.max(maxX - minX, maxY - minY) * 0.08 || 1;
  const viewBox = `${minX - padding} ${-(maxY + padding)} ${maxX - minX + padding * 2} ${maxY - minY + padding * 2}`;
  const rect = (part: typeof geometry.before.parts[number], phase: 'before' | 'after') => (
    <rect key={`${phase}-${part.ref}`} className={`es-geometry-${phase}`}
      x={part.x - part.width / 2} y={-(part.y + part.height / 2)} width={part.width} height={part.height}
      transform={`rotate(${-Number(part.rotation ?? 0)} ${part.x} ${-part.y})`} />
  );
  return (
    <section className="es-geometry-preview" aria-label="Exact PCB geometry changes">
      <div className="es-geometry-map">
        <svg viewBox={viewBox} role="img" aria-label="Before and after evaluated PCB rectangles">
          <rect className="es-geometry-board-before" x={geometry.before.board.x - geometry.before.board.width / 2} y={-(geometry.before.board.y + geometry.before.board.height / 2)} width={geometry.before.board.width} height={geometry.before.board.height} />
          <rect className="es-geometry-board-after" x={geometry.after.board.x - geometry.after.board.width / 2} y={-(geometry.after.board.y + geometry.after.board.height / 2)} width={geometry.after.board.width} height={geometry.after.board.height} />
          {geometry.before.parts.map((part) => rect(part, 'before'))}
          {geometry.after.parts.map((part) => rect(part, 'after'))}
        </svg>
        <small><i className="es-geometry-key-before" />Before <i className="es-geometry-key-after" />After</small>
      </div>
      <div className="es-geometry-deltas">
        {geometry.boardDelta && <p><strong>Board</strong><span>{geometry.boardDelta.before.width} × {geometry.boardDelta.before.height} → {geometry.boardDelta.after.width} × {geometry.boardDelta.after.height} mm</span></p>}
        {geometry.deltas.map((item) => <p key={item.ref}>
          <strong>{item.ref}</strong>
          <span>X {item.before.x.toFixed(3)} → {item.after.x.toFixed(3)} ({formatDelta(item.delta.x)})</span>
          <span>Y {item.before.y.toFixed(3)} → {item.after.y.toFixed(3)} ({formatDelta(item.delta.y)})</span>
          <span>Rotation {item.before.rotation.toFixed(3)}° → {item.after.rotation.toFixed(3)}° ({formatDelta(item.delta.rotation, 'deg')})</span>
        </p>)}
        <small>{geometry.limitation}</small>
      </div>
    </section>
  );
}

function MountingHolePreviewPanel({ preview }: { preview: NonNullable<PendingEditPreview['visual']['mountingHoles']> }) {
  const board = preview.board;
  const padding = Math.max(board.width, board.height) * 0.08 || 1;
  const viewBox = `${board.x - board.width / 2 - padding} ${-(board.y + board.height / 2 + padding)} ${board.width + padding * 2} ${board.height + padding * 2}`;
  return (
    <section className="es-geometry-preview" aria-label="Unplated mounting-hole geometry additions">
      <div className="es-geometry-map">
        <svg viewBox={viewBox} role="img" aria-label="Requested unplated circular holes on the evaluated rectangular board">
          <rect className="es-geometry-board-after" x={board.x - board.width / 2} y={-(board.y + board.height / 2)} width={board.width} height={board.height} />
          {preview.holes.map((hole) => <circle key={hole.name} className="es-geometry-hole-after" cx={hole.pcbX} cy={-hole.pcbY} r={hole.diameter / 2} />)}
        </svg>
        <small><i className="es-geometry-key-after" />Requested unplated circular holes</small>
      </div>
      <div className="es-geometry-deltas">
        <p><strong>Count</strong><span>{preview.beforeCount} → {preview.afterCount} evaluated pcb_hole circles</span></p>
        {preview.holes.map((hole) => <p key={hole.name}>
          <strong>{hole.name}</strong>
          <span>Center X {hole.pcbX.toFixed(3)} mm · Y {hole.pcbY.toFixed(3)} mm</span>
          <span>Diameter {hole.diameter.toFixed(3)} mm</span>
        </p>)}
        <small>{preview.limitation}</small>
      </div>
    </section>
  );
}

function KeepoutPreviewPanel({ preview }: { preview: NonNullable<PendingEditPreview['visual']['keepouts']> }) {
  const board = preview.board;
  const padding = Math.max(board.width, board.height) * 0.08 || 1;
  const viewBox = `${board.x - board.width / 2 - padding} ${-(board.y + board.height / 2 + padding)} ${board.width + padding * 2} ${board.height + padding * 2}`;
  return (
    <section className="es-geometry-preview" aria-label="Exact PCB keep-out geometry additions">
      <div className="es-geometry-map">
        <svg viewBox={viewBox} role="img" aria-label="Requested local keep-out shapes on the evaluated rectangular board">
          <rect className="es-geometry-board-after" x={board.x - board.width / 2} y={-(board.y + board.height / 2)} width={board.width} height={board.height} />
          {preview.keepouts.map((keepout) => keepout.shape === 'circle'
            ? <circle key={keepout.name} className="es-geometry-keepout-after" cx={keepout.pcbX} cy={-keepout.pcbY} r={keepout.radius} />
            : <rect key={keepout.name} className="es-geometry-keepout-after" x={keepout.pcbX - keepout.width / 2} y={-(keepout.pcbY + keepout.height / 2)} width={keepout.width} height={keepout.height} />)}
        </svg>
        <small><i className="es-geometry-key-after" />Requested keep-out shapes · local map</small>
      </div>
      <div className="es-geometry-deltas">
        <p><strong>Count</strong><span>{preview.beforeCount} → {preview.afterCount} evaluated pcb_keepout shapes</span></p>
        {preview.keepouts.map((keepout) => <p key={keepout.name}>
          <strong>{keepout.name}</strong>
          <span>{keepout.shape} center X {keepout.pcbX.toFixed(3)} mm · Y {keepout.pcbY.toFixed(3)} mm</span>
          <span>{keepout.shape === 'circle'
            ? `Radius ${keepout.radius.toFixed(3)} mm`
            : `Width ${keepout.width.toFixed(3)} mm · height ${keepout.height.toFixed(3)} mm`}</span>
          <span>Layers {keepout.layers.join(', ')}</span>
        </p>)}
        <small>{preview.limitation}</small>
      </div>
    </section>
  );
}

function AgentChangeRevealCard({
  reveal,
  canUndo,
  onUndo,
  onViewDiff,
  onClose,
}: {
  reveal: AgentChangeReveal;
  canUndo: boolean;
  onUndo: () => void;
  onViewDiff: () => void;
  onClose: () => void;
}) {
  const refs = [
    reveal.addedComponents.length > 0 ? `Added ${reveal.addedComponents.join(', ')}` : '',
    reveal.removedComponents.length > 0 ? `Removed ${reveal.removedComponents.join(', ')}` : '',
  ].filter(Boolean);
  const endpointText = (endpoints: string[], count: number): string => [
    endpoints.join(', '),
    count > endpoints.length ? `+${count - endpoints.length} more` : '',
  ].filter(Boolean).join(', ') || 'no endpoints';
  return (
    <section className={`es-agent-change es-agent-change-${reveal.phase}`} aria-live="polite" aria-label="Applied agent change">
      <div className="es-agent-change-head">
        <span className="es-agent-change-mark">{reveal.phase === 'reevaluating' ? '…' : reveal.phase === 'ready' ? '✓' : '!'}</span>
        <div>
          <small>{reveal.phase === 'reevaluating' ? 'Applying agent change' : reveal.phase === 'ready' ? 'Agent change applied' : 'Applied · evaluation failed'}</small>
          <strong>{reveal.label}</strong>
        </div>
        <button className="es-icon-button" onClick={onClose} aria-label="Dismiss applied change">×</button>
      </div>
      {reveal.phase === 'reevaluating' && <p>Waiting for the exact source projection…</p>}
      {reveal.phase === 'failed' && <p>{truncate(reveal.error) || 'The new source could not be evaluated.'}</p>}
      {reveal.phase === 'ready' && (
        <>
          {refs.length > 0 && <p className="es-agent-change-refs">{refs.join(' · ')}</p>}
          {reveal.affectedComponentNames.length > 0 && (
            <p className="es-agent-change-refs">Affected parts {reveal.affectedComponentNames.join(', ')}</p>
          )}
          {reveal.affectedNets.length > 0 && (
            <div className="es-agent-change-nets" aria-label="Affected connections">
              <strong>Affected connections</strong>
              {reveal.affectedNets.map((net, index) => {
                const beforeLabel = net.beforeLabel ?? '';
                const afterLabel = net.afterLabel ?? '';
                const label = beforeLabel && afterLabel && beforeLabel !== afterLabel
                  ? `${beforeLabel} → ${afterLabel}`
                  : afterLabel || beforeLabel;
                return <p key={`${net.change}-${label}-${index}`}>
                  <b>{net.change === 'added' ? 'Added' : net.change === 'removed' ? 'Removed' : 'Changed'} {label}</b>
                  {net.change === 'changed'
                    ? <span>{endpointText(net.beforeEndpoints, net.beforeEndpointCount)} → {endpointText(net.afterEndpoints, net.afterEndpointCount)}</span>
                    : <span>{endpointText(
                      net.change === 'added' ? net.afterEndpoints : net.beforeEndpoints,
                      net.change === 'added' ? net.afterEndpointCount : net.beforeEndpointCount,
                    )}</span>}
                </p>;
              })}
              {reveal.affectedNetCount > reveal.affectedNets.length && (
                <small>+{reveal.affectedNetCount - reveal.affectedNets.length} more affected connections not shown</small>
              )}
            </div>
          )}
          <div className="es-agent-change-counts">
            <span><small>Parts</small><b>{reveal.before.components} → {reveal.after.components}</b></span>
            <span><small>Connections</small><b>{reveal.before.connections} → {reveal.after.connections}</b></span>
            <span><small>PCB</small><b>{reveal.before.pcbComponents} → {reveal.after.pcbComponents}</b></span>
            <span><small>Board geometry</small><b>{reveal.before.boardGeometry} → {reveal.after.boardGeometry}</b></span>
          </div>
          {reveal.readiness && (
            <p className="es-agent-change-readiness">
              Readiness <b>{reveal.readiness.before} → {reveal.readiness.after}</b>
            </p>
          )}
        </>
      )}
      {reveal.phase !== 'reevaluating' && (
        <footer>
          {canUndo && <button onClick={onUndo}>↶ Undo</button>}
          <button onClick={onViewDiff}>View diff</button>
        </footer>
      )}
    </section>
  );
}

function assertEditable(kind: DocKind, operation: string): void {
  if (kind !== 'tsx') throw new Error(`${operation} requires a .circuit.tsx file (Circuit JSON is render-only).`);
}

function exactDiagnosticRefs(circuitJson: AnyCircuitElement[], diagnostic: AnyCircuitElement): string[] | undefined {
  const sourceIds = new Set<string>();
  if (typeof diagnostic.source_component_id === 'string') sourceIds.add(diagnostic.source_component_id);
  if (Array.isArray(diagnostic.source_component_ids)) {
    for (const id of diagnostic.source_component_ids) if (typeof id === 'string') sourceIds.add(id);
  }
  const pcbIds = new Set<string>();
  if (typeof diagnostic.pcb_component_id === 'string') pcbIds.add(diagnostic.pcb_component_id);
  if (Array.isArray(diagnostic.pcb_component_ids)) {
    for (const id of diagnostic.pcb_component_ids) if (typeof id === 'string') pcbIds.add(id);
  }
  for (const element of circuitJson) {
    if (element.type === 'pcb_component' && typeof element.pcb_component_id === 'string'
      && pcbIds.has(element.pcb_component_id) && typeof element.source_component_id === 'string') {
      sourceIds.add(element.source_component_id);
    }
  }
  const refs = circuitJson.flatMap((element) => (
    element.type === 'source_component'
    && typeof element.source_component_id === 'string'
    && sourceIds.has(element.source_component_id)
    && typeof element.name === 'string'
      ? [element.name]
      : []
  ));
  return refs.length > 0 ? [...new Set(refs)].sort() : undefined;
}

/** In-app quick-start: the design loop and the prompts that drive it. */
function HelpOverlay({
  kind,
  openExternal,
  onClose,
}: {
  kind: DocKind;
  openExternal?: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  const tscircuitProjectUrl = 'https://github.com/tscircuit/tscircuit';
  const steps: Array<{ icon: string; title: string; body: string }> = [
    { icon: '✎', title: 'Design', body: 'Drag parts and functional blocks from the left palette, or ask the agent to place and wire them. The Code tab is the tscircuit source of truth.' },
    { icon: '◇', title: 'Check', body: 'The Advisor gives a live readiness score, lint findings, and next actions. Fix issues before you export.' },
    { icon: '▶', title: 'Simulate & test', body: 'Run the logical, analog (SPICE), or MCU-firmware engines, then assert on behaviour to confirm the board does what you intended.' },
    { icon: '⤓', title: 'Export', body: 'Produce a BOM, design images, a SPICE netlist, a full fab bundle (Gerber/drill/BOM/CPL), an editable KiCad project, or an enclosure — all next to your file.' },
  ];
  const prompts = [
    '"Build a firmware-simulatable Arduino blink circuit and confirm the LED toggles at 1 Hz."',
    '"Add an ESP32 with decoupling caps and an I²C sensor port, then run readiness."',
    '"The LED has no current-limit resistor — fix it and re-lint."',
    '"Export a JLCPCB BOM and a schematic SVG for the README."',
  ];
  return (
    <div className="es-help-backdrop" role="dialog" aria-modal="true" aria-label="Electronics Studio help" onClick={onClose}>
      <div className="es-help-card" onClick={(e) => e.stopPropagation()}>
        <div className="es-help-head">
          <div>
            <strong>Electronics Studio</strong>
            <small>design → simulate → test → manufacture-export, driven by you or the agent</small>
          </div>
          <button className="es-help-close" onClick={onClose} aria-label="Close help">✕</button>
        </div>
        {kind !== 'tsx' && (
          <p className="es-help-note">
            This is a read-only Circuit JSON view. Open a <code>.circuit.tsx</code> file to edit, wire, and let the agent drive the design.
          </p>
        )}
        <div className="es-help-tscircuit">
          <div>
            <small>Open-source foundation</small>
            <strong>Built on tscircuit</strong>
            <p>Electronics Studio uses tscircuit&apos;s code-first circuit model and Circuit JSON ecosystem to turn TypeScript designs into connected electronics views.</p>
          </div>
          <a
            href={tscircuitProjectUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!openExternal) return;
              event.preventDefault();
              void openExternal(tscircuitProjectUrl);
            }}
          >
            View tscircuit project ↗
          </a>
        </div>
        <div className="es-help-steps">
          {steps.map((s) => (
            <div className="es-help-step" key={s.title}>
              <span className="es-help-step-icon">{s.icon}</span>
              <div>
                <b>{s.title}</b>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="es-help-prompts">
          <b>Try asking the agent</b>
          <ul>
            {prompts.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <div className="es-help-foot">
          Full guides: <code>docs/GETTING_STARTED.md</code>, <code>docs/AI_COOKBOOK.md</code>, and <code>docs/TOOL_REFERENCE.md</code>.
        </div>
      </div>
    </div>
  );
}

function truncate(value?: string): string {
  if (!value) return 'evaluation error';
  return value.length > 90 ? `${value.slice(0, 90)}…` : value;
}
