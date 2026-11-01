import {
  Component,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  buildCircuitIndex,
  hasSchematicElements,
  type AnyCircuitElement,
  type HoverContent,
} from '../circuit/circuitJson.ts';
import type { ActiveConnectivityEvidence } from '../circuit/connectivityEvidence.ts';
import type { ActivePartTrustSpotlight } from '../circuit/partTrustSpotlight.ts';
import type { ActiveAssemblyHandoffSpotlight } from '../circuit/assemblyHandoffSpotlight.ts';
import type { ResolvedAdvisorAffectedGeometry } from '../circuit/advisorAffectedGeometry.ts';
import type { CanvasFeedback } from '../sim/canvasFeedback.ts';
import { projectSchematicOverlays } from '../tscircuit/schematicOverlayProjection.ts';
import { CanvasFeedbackEvidence, SchematicOverlayCards } from './CircuitViews.tsx';
import {
  SchematicViewer,
  TSCIRCUIT_SCHEMATIC_VIEWER_VERSION,
  inspectSchematicViewerContract,
  prepareSchematicViewerCircuitJson,
  resolveSchematicComponentClick,
  resolveSchematicPortClick,
} from '../tscircuit/schematicViewerContract.ts';
import {
  ViewerCanvasControls,
  ViewerContextMenu,
  ViewerHoverTooltip,
  ViewerPlaceholder,
  type DirectViewerControls,
  type ViewerHover,
} from './ViewerCanvasControls.tsx';

const SCHEMATIC_LIGHT_COLORS = {
  schematic: {
    background: 'var(--es-canvas, #f7faf9)',
    component_body: 'var(--es-panel, #ffffff)',
    wire_crossing: 'var(--es-canvas, #f7faf9)',
  },
};

const SCHEMATIC_DARK_COLORS = {
  schematic: {
    background: 'var(--es-panel-2, #1b2220)',
    component_body: 'var(--es-panel-2, #252a30)',
    component_outline: 'var(--es-symbol, #dfe6ea)',
    pin: 'var(--es-symbol, #dfe6ea)',
    pin_number: 'var(--es-symbol-muted, rgba(223, 230, 234, 0.58))',
    reference: 'var(--es-blue, #8ed8ff)',
    value: 'var(--cutucircuits-success, #b9f2a1)',
    label_global: 'var(--es-blue, #8ed8ff)',
    label_local: 'var(--es-blue, #8ed8ff)',
    net_name: 'var(--cutucircuits-success, #b9f2a1)',
    sheet_label: 'var(--es-symbol-muted, rgba(223, 230, 234, 0.58))',
    wire: 'var(--cutucircuits-success, #74d680)',
    wire_crossing: 'var(--es-panel-2, #1b2220)',
    junction: 'var(--cutucircuits-success, #74d680)',
    no_connect: 'var(--es-red, #ff8a8a)',
    erc_error: 'var(--es-red, #ff6b6b)',
    erc_warning: 'var(--es-amber, #ffd166)',
  },
};

const SCHEMATIC_DARK_CSS = `
  .tscircuit-schematic.es-schematic-svg-dark .schematic-boundary { stroke: rgba(255, 255, 255, 0.28); }
  .tscircuit-schematic.es-schematic-svg-dark .sch-text { fill: var(--es-symbol-muted, rgba(223, 230, 234, 0.58)); }
  .tscircuit-schematic.es-schematic-svg-dark .trace:hover,
  .tscircuit-schematic.es-schematic-svg-dark .trace:hover .trace-junction { filter: brightness(1.35); }
`;

class SchematicViewerBoundary extends Component<{ children: ReactNode; onFailure: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ElectronicsStudio] direct tscircuit schematic viewer failed:', error, info);
    this.props.onFailure(error.message || 'The viewer raised an unknown render error.');
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ViewerErrorCard({ reason, onReload }: { reason: string; onReload: () => void }) {
  return (
    <div className="es-viewer-error-card" role="alert">
      <strong>Schematic viewer unavailable</strong>
      <p>{reason}</p>
      <button type="button" onClick={onReload}>Reload viewer</button>
    </div>
  );
}

type PortSelection = { id: string; selector: string };

export function TscircuitSchematicPane({
  circuitJson,
  loading,
  dark,
  onSelectSourceComponent,
  onClearSelection,
  onInspectPort,
  wiring = false,
  activePortId,
  onSelectPort,
  selectedComponentId,
  pairedComponentIds = [],
  advisorAffectedGeometry,
  connectivityEvidence,
  onClearConnectivityEvidence,
  partTrustSpotlight,
  onClearPartTrustSpotlight,
  assemblyHandoffSpotlight,
  onClearAssemblyHandoffSpotlight,
  revealedComponentIds = [],
  revealedConnectivityKeys = [],
  feedback,
  selectedPortId,
  pinTracePortIds = [],
  pinTraceConnectivityKey,
}: {
  circuitJson: AnyCircuitElement[];
  loading: boolean;
  dark: boolean;
  onSelectSourceComponent: (sourceComponentId: string) => void;
  onClearSelection: () => void;
  onInspectPort: (port: PortSelection) => void | Promise<void>;
  wiring?: boolean;
  activePortId?: string;
  onSelectPort?: (port: PortSelection) => void | Promise<void>;
  selectedComponentId?: string;
  pairedComponentIds?: string[];
  advisorAffectedGeometry?: ResolvedAdvisorAffectedGeometry;
  connectivityEvidence?: ActiveConnectivityEvidence;
  onClearConnectivityEvidence?: () => unknown;
  partTrustSpotlight?: ActivePartTrustSpotlight;
  onClearPartTrustSpotlight?: () => unknown;
  assemblyHandoffSpotlight?: ActiveAssemblyHandoffSpotlight;
  onClearAssemblyHandoffSpotlight?: () => unknown;
  revealedComponentIds?: string[];
  revealedConnectivityKeys?: string[];
  feedback?: CanvasFeedback | null;
  selectedPortId?: string;
  pinTracePortIds?: string[];
  pinTraceConnectivityKey?: string;
}) {
  const [viewerError, setViewerError] = useState<string>();
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const [interactionError, setInteractionError] = useState<string>();
  const [reloadRevision, setReloadRevision] = useState(0);
  const [viewerSize, setViewerSize] = useState<{ width: number; height: number }>();
  const [hover, setHover] = useState<ViewerHover>();
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerControlsRef = useRef<DirectViewerControls | null>(null);
  const contract = inspectSchematicViewerContract(SchematicViewer);
  const viewerCircuitJson = useMemo(
    () => prepareSchematicViewerCircuitJson(circuitJson),
    [circuitJson],
  );
  const projection = useMemo(() => projectSchematicOverlays({
    circuitJson: viewerCircuitJson,
    selectedComponentId,
    pairedComponentIds,
    advisorAffectedGeometry,
    connectivityEvidence,
    partTrustSpotlight,
    assemblyHandoffSpotlight,
    revealedComponentIds,
    revealedConnectivityKeys,
    feedback,
    selectedPortId,
    pinTracePortIds,
    pinTraceConnectivityKey,
    activeWirePortId: activePortId,
  }), [
    activePortId,
    advisorAffectedGeometry,
    assemblyHandoffSpotlight,
    connectivityEvidence,
    feedback,
    pairedComponentIds,
    partTrustSpotlight,
    pinTraceConnectivityKey,
    pinTracePortIds,
    revealedComponentIds,
    revealedConnectivityKeys,
    selectedComponentId,
    selectedPortId,
    viewerCircuitJson,
  ]);
  const circuitIndex = useMemo(() => buildCircuitIndex(circuitJson), [circuitJson]);
  const handleViewerControls = useCallback((controls: DirectViewerControls | null) => {
    viewerControlsRef.current = controls;
  }, []);

  const updateHover = (event: { clientX: number; clientY: number; target: EventTarget | null }) => {
    const host = canvasHostRef.current;
    if (!host || !(event.target instanceof Element)) return;
    let content: HoverContent | null = null;
    const port = event.target.closest('[data-schematic-port-id]');
    const component = event.target.closest('[data-schematic-component-id]');
    const trace = event.target.closest('[data-subcircuit-connectivity-map-key]');
    if (port) content = circuitIndex.port(port.getAttribute('data-schematic-port-id') ?? '');
    else if (component) content = circuitIndex.schematicComponent(component.getAttribute('data-schematic-component-id') ?? '');
    else if (trace) content = circuitIndex.net(trace.getAttribute('data-subcircuit-connectivity-map-key') ?? '');
    if (!content) {
      setHover(undefined);
      return;
    }
    const bounds = host.getBoundingClientRect();
    setHover({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, content });
  };

  useLayoutEffect(() => {
    if (loading || !contract.usable || viewerError) return;
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
  }, [contract.usable, loading, reloadRevision, viewerError]);

  const reloadViewer = () => {
    setViewerError(undefined);
    setSelectionNotice(undefined);
    setInteractionError(undefined);
    setHover(undefined);
    setViewerSize(undefined);
    setReloadRevision((revision) => revision + 1);
  };

  const activatePort = (port: PortSelection) => {
    setInteractionError(undefined);
    const action = wiring ? onSelectPort : onInspectPort;
    if (!action) return;
    try {
      const result = action(port);
      if (result && typeof result.then === 'function') {
        void result.catch((error) => setInteractionError(error instanceof Error ? error.message : String(error)));
      }
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    }
  };

  if (loading) return <div className="es-loading" role="status" aria-live="polite"><span className="es-loading-spinner" aria-hidden="true" /><strong className="es-loading-title">Loading schematic…</strong></div>;
  if (!hasSchematicElements(circuitJson)) return <ViewerPlaceholder title="No schematic yet" hint="Add parts from the palette or with the AI, then wire them with traces." />;
  const unavailableReason = contract.usable ? viewerError : contract.reason ?? 'The pinned viewer contract is unavailable.';
  return (
    <ViewerContextMenu controlsRef={viewerControlsRef} onClearSelection={onClearSelection} trigger={(
    <section className="es-tscircuit-pcb" aria-label="Direct tscircuit schematic viewer">
      <header><div><small>Upstream viewer · package {TSCIRCUIT_SCHEMATIC_VIEWER_VERSION}</small><strong>Direct tscircuit schematic viewer</strong></div></header>
      <p>Exact component and port clicks feed passive selection, Pair mode, Pin Scout, and TSX Wire mode. Evidence and agent emphasis are projected into the same upstream canvas.</p>
      {selectionNotice && <p className="es-viewer-selection-notice" role="status">Selection could not be resolved. {selectionNotice}</p>}
      {interactionError && <p role="alert">{interactionError}</p>}
      {unavailableReason ? <ViewerErrorCard reason={unavailableReason} onReload={reloadViewer} /> : (
        <div
          ref={canvasHostRef}
          className={`es-tscircuit-schematic-canvas${wiring ? ' es-direct-wiring' : ''}`}
          onMouseMove={updateHover}
          onMouseLeave={() => setHover(undefined)}
          onDoubleClick={() => viewerControlsRef.current?.fitToView()}
        >
          {viewerSize != null && <SchematicViewerBoundary
            key={reloadRevision}
            onFailure={setViewerError}
          >
            <SchematicViewer
              circuitJson={projection.circuitJson as never}
              editingEnabled={false}
              clickToInteractEnabled={false}
              showSchematicPorts
              containerStyle={{ width: viewerSize.width, height: viewerSize.height }}
              colorOverrides={(dark ? SCHEMATIC_DARK_COLORS : SCHEMATIC_LIGHT_COLORS) as never}
              className={dark ? 'es-schematic-svg-dark' : 'es-schematic-svg-light'}
              css={dark ? SCHEMATIC_DARK_CSS : undefined}
              onViewerControlsReady={handleViewerControls}
              onSchematicComponentClicked={({ schematicComponentId }) => {
                const selection = resolveSchematicComponentClick(circuitJson, schematicComponentId);
                if (selection.status !== 'component') {
                  setSelectionNotice(selection.reason);
                  onClearSelection();
                  return;
                }
                setSelectionNotice(undefined);
                onSelectSourceComponent(selection.sourceComponentId);
              }}
              onSchematicPortClicked={({ schematicPortId }) => {
                const selection = resolveSchematicPortClick(circuitJson, schematicPortId);
                if (selection.status !== 'port') {
                  setSelectionNotice(selection.reason);
                  return;
                }
                setSelectionNotice(undefined);
                activatePort({ id: selection.sourcePortId, selector: selection.selector });
              }}
            />
          </SchematicViewerBoundary>}
          <ViewerCanvasControls controlsRef={viewerControlsRef} />
          {hover && <ViewerHoverTooltip hover={hover} />}
          <CanvasFeedbackEvidence feedback={feedback} onSelectFeedback={onSelectSourceComponent} />
          <SchematicOverlayCards
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
