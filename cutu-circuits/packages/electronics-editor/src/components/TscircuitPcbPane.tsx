import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { ManualEditEvent } from '@tscircuit/props';
import { hasPcbElements, type AnyCircuitElement } from '../circuit/circuitJson.ts';
import type { ActivePcbGrid } from '../circuit/pcbGrid.ts';
import type { ActivePcbMeasurement } from '../circuit/pcbMeasurement.ts';
import type { ActivePcbRuleLens } from '../circuit/pcbRuleLens.ts';
import type { ActivePcbRouteProposal } from '../circuit/pcbRouteProposal.ts';
import type { ActiveConnectivityEvidence } from '../circuit/connectivityEvidence.ts';
import type { ActivePartTrustSpotlight } from '../circuit/partTrustSpotlight.ts';
import type { ActiveAssemblyHandoffSpotlight } from '../circuit/assemblyHandoffSpotlight.ts';
import type { ResolvedAdvisorAffectedGeometry } from '../circuit/advisorAffectedGeometry.ts';
import type { CanvasFeedback } from '../sim/canvasFeedback.ts';
import type { PcbLayerDefinition } from '../circuit/pcbLayerView.ts';
import { buildPcbLayerInventory, PCB_LAYER_DEFINITIONS } from '../circuit/pcbLayerView.ts';
import { projectPcbDebugGraphics } from '../tscircuit/pcbDebugGraphics.ts';
import { CanvasFeedbackEvidence, PcbOverlayCards } from './CircuitViews.tsx';
import {
  PCBViewer,
  READ_ONLY_VIEWER_CONTRACT,
  TSCIRCUIT_PCB_VIEWER_VERSION,
  inspectPcbViewerContract,
  resolvePcbViewerSelection,
} from '../tscircuit/pcbViewerContract.ts';
import {
  ViewerCanvasControls,
  ViewerContextMenu,
  ViewerPlaceholder,
  type DirectViewerControls,
} from './ViewerCanvasControls.tsx';

export const PCB_DRILL_COLORS = {
  light: { fill: '#202826', stroke: '#7b8783' },
  dark: { fill: '#070b0a', stroke: '#73817c' },
} as const;

class ViewerBoundary extends Component<{ children: ReactNode; onFailure: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ElectronicsStudio] direct tscircuit PCB viewer failed:', error, info);
    this.props.onFailure(error.message || 'The viewer raised an unknown render error.');
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ViewerErrorCard({ reason, onReload }: { reason: string; onReload: () => void }) {
  return (
    <div className="es-viewer-error-card" role="alert">
      <strong>PCB viewer unavailable</strong>
      <p>{reason}</p>
      <button type="button" onClick={onReload}>Reload viewer</button>
    </div>
  );
}

type ViewerLayer = 'top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4' | 'inner5' | 'inner6';

function selectedViewerLayer(hiddenLayers: Set<string>): ViewerLayer {
  if (!hiddenLayers.has('top-copper')) return 'top';
  for (const layer of ['inner1', 'inner2', 'inner3', 'inner4', 'inner5', 'inner6'] as const) {
    if (!hiddenLayers.has(`${layer}-copper`)) return layer;
  }
  return 'bottom';
}

export function TscircuitPcbPane({
  circuitJson,
  loading,
  dark,
  onSelectSourceComponent,
  onClearSelection,
  selectedComponentId,
  advisorAffectedGeometry,
  grid,
  onClearGrid,
  routeProposal,
  onClearRouteProposal,
  ruleLens,
  onClearRuleLens,
  measurement,
  onClearMeasurement,
  connectivityEvidence,
  onClearConnectivityEvidence,
  partTrustSpotlight,
  onClearPartTrustSpotlight,
  assemblyHandoffSpotlight,
  onClearAssemblyHandoffSpotlight,
  revealedComponentIds = [],
  revealedConnectivityKeys = [],
  feedback,
  layoutComponentIds = [],
  hiddenLayers,
  onLayersChange,
  editing,
}: {
  circuitJson: AnyCircuitElement[];
  loading: boolean;
  dark: boolean;
  onSelectSourceComponent: (sourceComponentId: string) => void;
  onClearSelection: () => void;
  selectedComponentId?: string;
  advisorAffectedGeometry?: ResolvedAdvisorAffectedGeometry;
  grid?: ActivePcbGrid;
  onClearGrid?: () => unknown;
  routeProposal?: ActivePcbRouteProposal;
  onClearRouteProposal?: () => unknown;
  ruleLens?: ActivePcbRuleLens;
  onClearRuleLens?: () => unknown;
  measurement?: ActivePcbMeasurement;
  onClearMeasurement?: () => unknown;
  connectivityEvidence?: ActiveConnectivityEvidence;
  onClearConnectivityEvidence?: () => unknown;
  partTrustSpotlight?: ActivePartTrustSpotlight;
  onClearPartTrustSpotlight?: () => unknown;
  assemblyHandoffSpotlight?: ActiveAssemblyHandoffSpotlight;
  onClearAssemblyHandoffSpotlight?: () => unknown;
  revealedComponentIds?: string[];
  revealedConnectivityKeys?: string[];
  feedback?: CanvasFeedback | null;
  layoutComponentIds?: string[];
  hiddenLayers: Set<string>;
  onLayersChange: (layers: PcbLayerDefinition[]) => void;
  editing?: {
    enabled: boolean;
    status: 'disabled' | 'ready' | 'saving' | 'conflicted' | 'invalid' | 'unavailable';
    message: string;
    onEnable: () => Promise<void>;
    onCommit: (events: ManualEditEvent[]) => Promise<void>;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => Promise<void>;
    onRedo: () => Promise<void>;
  };
}) {
  const [editEvents, setEditEvents] = useState<ManualEditEvent[]>([]);
  const [gestureError, setGestureError] = useState<string>();
  const [viewerError, setViewerError] = useState<string>();
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const [reloadRevision, setReloadRevision] = useState(0);
  const [viewerSize, setViewerSize] = useState<{ width: number; height: number }>();
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerControlsRef = useRef<DirectViewerControls | null>(null);
  const committingRef = useRef(false);
  const contract = inspectPcbViewerContract(PCBViewer);
  const layerInventory = useMemo(() => buildPcbLayerInventory([
    ...circuitJson,
    ...(grid?.overlayElements ?? []),
    ...(routeProposal?.overlayElements ?? []),
    ...(ruleLens?.overlayElements ?? []),
    ...(measurement?.overlayElements ?? []),
    ...(connectivityEvidence?.overlayElements ?? []),
    ...(advisorAffectedGeometry?.overlayElements ?? []),
  ]), [advisorAffectedGeometry, circuitJson, connectivityEvidence, grid, measurement, routeProposal, ruleLens]);
  const availableLayers = useMemo(() => {
    const ids = new Set(layerInventory.availableLayers.map((layer) => layer.id));
    return PCB_LAYER_DEFINITIONS.filter((layer) => ids.has(layer.id));
  }, [layerInventory]);
  const debugGraphics = useMemo(() => hiddenLayers.has('annotations') ? null : projectPcbDebugGraphics({
    circuitJson,
    grid,
    measurement,
    ruleLens,
    routeProposal,
    connectivityEvidence,
    partTrustSpotlight,
    assemblyHandoffSpotlight,
    advisorAffectedGeometry,
    feedback,
    revealedComponentIds,
    revealedConnectivityKeys,
    layoutComponentIds,
  }), [advisorAffectedGeometry, assemblyHandoffSpotlight, circuitJson, connectivityEvidence, feedback, grid, hiddenLayers, layoutComponentIds, measurement, partTrustSpotlight, revealedComponentIds, revealedConnectivityKeys, routeProposal, ruleLens]);
  const viewerLayer = selectedViewerLayer(hiddenLayers);
  const handleViewerControls = useCallback((controls: DirectViewerControls | null) => {
    viewerControlsRef.current = controls;
  }, []);

  useEffect(() => onLayersChange(availableLayers), [availableLayers, onLayersChange]);
  useLayoutEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const updateSize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.round(bounds.width);
      const height = Math.round(bounds.height);
      if (width <= 0 || height <= 0) return;
      setViewerSize((current) => current?.width === width && current.height === height
        ? current
        : { width, height });
    };
    updateSize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateSize) : undefined;
    observer?.observe(host);
    window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const reloadViewer = () => {
    setViewerError(undefined);
    setGestureError(undefined);
    setSelectionNotice(undefined);
    setEditEvents([]);
    viewerControlsRef.current = null;
    setReloadRevision((revision) => revision + 1);
  };

  if (loading) return <div className="es-loading" role="status" aria-live="polite"><span className="es-loading-spinner" aria-hidden="true" /><strong className="es-loading-title">Loading PCB…</strong></div>;
  if (!hasPcbElements(circuitJson)) return <ViewerPlaceholder title="No PCB layout yet" hint="Parts need footprints to appear here. The default catalog parts all carry footprints." />;
  const unavailableReason = contract.usable ? viewerError : contract.reason ?? 'The pinned viewer contract is unavailable.';
  return (
    <ViewerContextMenu controlsRef={viewerControlsRef} onClearSelection={onClearSelection} trigger={(
    <section className="es-tscircuit-pcb" aria-label="Direct tscircuit PCB viewer">
      <header><div><small>Upstream viewer · package {TSCIRCUIT_PCB_VIEWER_VERSION}</small><strong>Direct tscircuit PCB viewer</strong></div></header>
      <p>{contract.reason} Selection and human drag gestures are passive to agents. {editing?.message ?? 'Manual editing is unavailable in this host.'}</p>
      {selectionNotice && <p className="es-viewer-selection-notice" role="status">Selection could not be resolved. {selectionNotice}</p>}
      {gestureError && <p role="alert">{gestureError}</p>}
      {editing && !editing.enabled && editing.status === 'disabled' && (
        <button
          onClick={() => {
            setGestureError(undefined);
            void editing.onEnable().catch((error) => setGestureError(error instanceof Error ? error.message : String(error)));
          }}
        >Enable upstream manual edits</button>
      )}
      {editing && (editing.enabled || editing.status === 'conflicted') && (
        <div className="es-history-controls" aria-label="Host project transaction history">
          <button disabled={!editing.canUndo || editing.status === 'saving'} onClick={() => void editing.onUndo().catch((error) => setGestureError(error instanceof Error ? error.message : String(error)))}>Undo placement</button>
          <button disabled={!editing.canRedo || editing.status === 'saving'} onClick={() => void editing.onRedo().catch((error) => setGestureError(error instanceof Error ? error.message : String(error)))}>Redo placement</button>
        </div>
      )}
      {unavailableReason ? <ViewerErrorCard reason={unavailableReason} onReload={reloadViewer} /> : (
        <div
          ref={canvasHostRef}
          className="es-tscircuit-pcb-canvas"
          onDoubleClick={() => viewerControlsRef.current?.fitToView()}
        >
          {viewerSize != null && <ViewerBoundary key={`${reloadRevision}:${viewerLayer}`} onFailure={setViewerError}>
            <PCBViewer
              circuitJson={circuitJson as never}
              width={viewerSize.width}
              height={viewerSize.height}
              {...READ_ONLY_VIEWER_CONTRACT}
              initialState={{
                selected_layer: viewerLayer,
                is_showing_solder_mask: true,
                is_showing_silkscreen: true,
                is_showing_courtyards: true,
                is_showing_fabrication_notes: true,
              }}
              hiddenLayerIds={[...hiddenLayers]}
              drillColor={dark ? PCB_DRILL_COLORS.dark.fill : PCB_DRILL_COLORS.light.fill}
              drillStrokeColor={dark ? PCB_DRILL_COLORS.dark.stroke : PCB_DRILL_COLORS.light.stroke}
              onViewerControlsReady={handleViewerControls}
              debugGraphics={debugGraphics}
              allowEditing={editing?.enabled === true}
              editEvents={editEvents}
              onEditEventsChanged={(nextEvents) => {
                setEditEvents(nextEvents);
                if (!editing?.enabled || committingRef.current || nextEvents.length === 0) return;
                if (nextEvents.some((event) => event.in_progress === true)) return;
                committingRef.current = true;
                setGestureError(undefined);
                void editing.onCommit(nextEvents).then(() => {
                  setEditEvents([]);
                }).catch((error) => {
                  setGestureError(error instanceof Error ? error.message : String(error));
                }).finally(() => {
                  committingRef.current = false;
                });
              }}
              selectedSourceComponentId={selectedComponentId}
              onSelectionChange={(selection) => {
                const resolved = resolvePcbViewerSelection(circuitJson, selection);
                if (resolved.status === 'invalid') {
                  setSelectionNotice(resolved.reason);
                  onClearSelection();
                  return;
                }
                setSelectionNotice(undefined);
                if (resolved.status === 'cleared') onClearSelection();
                else onSelectSourceComponent(resolved.sourceComponentId);
              }}
            />
          </ViewerBoundary>}
          <ViewerCanvasControls controlsRef={viewerControlsRef} />
          <CanvasFeedbackEvidence feedback={feedback} onSelectFeedback={onSelectSourceComponent} />
          <PcbOverlayCards
            grid={grid}
            onClearGrid={onClearGrid}
            routeProposal={routeProposal}
            onClearRouteProposal={onClearRouteProposal}
            ruleLens={ruleLens}
            onClearRuleLens={onClearRuleLens}
            measurement={measurement}
            onClearMeasurement={onClearMeasurement}
            connectivityEvidence={connectivityEvidence}
            onClearConnectivityEvidence={onClearConnectivityEvidence}
            partTrustSpotlight={partTrustSpotlight}
            onClearPartTrustSpotlight={onClearPartTrustSpotlight}
            assemblyHandoffSpotlight={assemblyHandoffSpotlight}
            onClearAssemblyHandoffSpotlight={onClearAssemblyHandoffSpotlight}
          />
        </div>
      )}
    </section>
    )} />
  );
}
