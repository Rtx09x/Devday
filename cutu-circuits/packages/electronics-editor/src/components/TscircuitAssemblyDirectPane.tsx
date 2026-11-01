import {
  Component,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { AnyCircuitElement } from '../circuit/circuitJson';
import {
  ASSEMBLY_VIEWER_SELECTION_BRIDGE_VERSION,
  resolveAssemblyComponentLabel,
  resolveAssemblySourceComponent,
} from '../tscircuit/schematicViewerContract';
import {
  TSCIRCUIT_ASSEMBLY_VIEWER_VERSION,
  TscircuitAssemblyViewer,
  inspectAssemblyViewerContract,
} from '../tscircuit/assemblyViewerContract';
import {
  ViewerCanvasControls,
  type DirectViewerControls,
} from './ViewerCanvasControls.tsx';

const ASSEMBLY_SELECTION_GESTURE_PX = 5;

class AssemblyViewerBoundary extends Component<{
  children: ReactNode;
  onFailure: (message: string) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ElectronicsStudio] direct tscircuit assembly viewer failed:', error, info);
    this.props.onFailure(error.message || 'The viewer raised an unknown render error.');
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ViewerErrorCard({ reason, onReload }: { reason: string; onReload: () => void }) {
  return (
    <div className="es-viewer-error-card" role="alert">
      <strong>Assembly viewer unavailable</strong>
      <p>{reason}</p>
      <button type="button" onClick={onReload}>Reload viewer</button>
    </div>
  );
}

type AssemblyHit =
  | { status: 'none' }
  | { status: 'label'; label: string }
  | { status: 'invalid'; reason: string };

function resolveAssemblyLabelAtPoint(root: HTMLElement, clientX: number, clientY: number): AssemblyHit {
  const matches = new Map<SVGGElement, string>();
  for (const label of root.querySelectorAll('.assembly-component-label')) {
    const ref = label.textContent?.trim();
    const group = label.closest('g');
    if (!ref || !(group instanceof SVGGElement)) continue;
    const bounds = group.getBoundingClientRect();
    if (clientX >= bounds.left && clientX <= bounds.right
      && clientY >= bounds.top && clientY <= bounds.bottom) {
      matches.set(group, ref);
    }
  }
  if (matches.size === 0) return { status: 'none' };
  if (matches.size !== 1) {
    return {
      status: 'invalid',
      reason: 'The direct assembly viewer gesture overlaps multiple rendered components.',
    };
  }
  return { status: 'label', label: [...matches.values()][0] };
}

export function TscircuitAssemblyDirectPane({
  circuitJson,
  loading,
  selectedSourceComponentId,
  onSelectSourceComponent,
  onOpenBom,
}: {
  circuitJson: AnyCircuitElement[];
  loading: boolean;
  selectedSourceComponentId?: string;
  onSelectSourceComponent: (sourceComponentId: string) => void;
  onOpenBom: () => void;
}) {
  const bridgeRef = useRef<HTMLDivElement>(null);
  const gestureStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const viewerControlsRef = useRef<DirectViewerControls | null>(null);
  const [viewerError, setViewerError] = useState<string>();
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const [reloadRevision, setReloadRevision] = useState(0);
  const [viewerSize, setViewerSize] = useState<{ width: number; height: number }>();
  const contract = inspectAssemblyViewerContract(TscircuitAssemblyViewer);
  const handleViewerControls = useCallback((controls: DirectViewerControls | null) => {
    viewerControlsRef.current = controls;
  }, []);
  // @tscircuit/assembly-viewer delegates to circuit-to-svg, which sorts its
  // input in place. Never expose the shared Circuit JSON array to that renderer.
  const assemblyCircuitJson = useMemo(() => [...circuitJson], [circuitJson]);
  const selected = useMemo(() => (
    selectedSourceComponentId
      ? resolveAssemblySourceComponent(circuitJson, selectedSourceComponentId)
      : undefined
  ), [circuitJson, selectedSourceComponentId]);

  useLayoutEffect(() => {
    const host = bridgeRef.current;
    if (!host || !contract.usable || viewerError) return;
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
  }, [contract.usable, reloadRevision, viewerError]);

  useLayoutEffect(() => {
    setSelectionNotice(selectedSourceComponentId && selected?.status === 'invalid' ? selected.reason : undefined);
  }, [selected, selectedSourceComponentId]);

  useLayoutEffect(() => {
    const root = bridgeRef.current;
    if (!root) return;
    const syncSelection = () => {
      for (const group of root.querySelectorAll('.es-assembly-linked-selection')) {
        group.classList.remove('es-assembly-linked-selection');
      }
      if (selected?.status !== 'component') return;
      const matches = [...root.querySelectorAll('.assembly-component-label')]
        .filter((label) => label.textContent?.trim() === selected.ref)
        .map((label) => label.closest('g'))
        .filter((group): group is SVGGElement => group instanceof SVGGElement);
      if (matches.length === 1) matches[0].classList.add('es-assembly-linked-selection');
    };
    syncSelection();
    const observer = new MutationObserver(syncSelection);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selected]);

  const beginGesture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('.es-canvas-controls')) {
      gestureStartRef.current = undefined;
      return;
    }
    gestureStartRef.current = event.button === 0
      ? { x: event.clientX, y: event.clientY }
      : undefined;
  };

  const finishGesture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const start = gestureStartRef.current;
    gestureStartRef.current = undefined;
    if (event.target instanceof Element && event.target.closest('.es-canvas-controls')) return;
    if (!start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > ASSEMBLY_SELECTION_GESTURE_PX) return;
    const root = bridgeRef.current;
    if (!root) return;
    const hit = resolveAssemblyLabelAtPoint(root, event.clientX, event.clientY);
    if (hit.status === 'none') return;
    if (hit.status === 'invalid') {
      setSelectionNotice(hit.reason);
      return;
    }
    const selection = resolveAssemblyComponentLabel(circuitJson, hit.label);
    if (selection.status !== 'component') {
      setSelectionNotice(selection.reason);
      return;
    }
    setSelectionNotice(undefined);
    onSelectSourceComponent(selection.sourceComponentId);
  };

  const reloadViewer = () => {
    setViewerError(undefined);
    setSelectionNotice(undefined);
    setViewerSize(undefined);
    viewerControlsRef.current = null;
    setReloadRevision((revision) => revision + 1);
  };

  if (loading) return <div className="es-loading" role="status" aria-live="polite"><span className="es-loading-spinner" aria-hidden="true" /><strong className="es-loading-title">Loading assembly…</strong></div>;
  const unavailableReason = contract.usable ? viewerError : contract.reason;
  return (
    <section className="es-tscircuit-pcb es-tscircuit-assembly" aria-label="Direct tscircuit assembly viewer">
      <header>
        <div>
          <small>Upstream viewer · package {TSCIRCUIT_ASSEMBLY_VIEWER_VERSION} · bridge {ASSEMBLY_VIEWER_SELECTION_BRIDGE_VERSION}</small>
          <strong>Direct tscircuit assembly viewer{selected?.status === 'component' ? ` · ${selected.ref}` : ''}</strong>
        </div>
        {selected?.status === 'component' && <button onClick={onOpenBom}>Show in BOM</button>}
      </header>
      <p>Read-only inspection. Wheel to zoom and drag to pan; only gestures within five pixels select an exact component through the shared assembly identity bridge.</p>
      {selectionNotice && <p className="es-viewer-selection-notice" role="status">Selection could not be resolved. {selectionNotice}</p>}
      {unavailableReason ? <ViewerErrorCard reason={unavailableReason} onReload={reloadViewer} /> : (
        <div
          ref={bridgeRef}
          className="es-assembly-viewer-bridge"
          onMouseDownCapture={beginGesture}
          onMouseUpCapture={finishGesture}
          onDoubleClick={() => viewerControlsRef.current?.fitToView()}
        >
          {viewerSize && <AssemblyViewerBoundary key={reloadRevision} onFailure={setViewerError}>
            <TscircuitAssemblyViewer
              circuitJson={assemblyCircuitJson}
              editingEnabled={false}
              containerStyle={{ width: viewerSize.width, height: viewerSize.height, minHeight: 0 }}
              onViewerControlsReady={handleViewerControls}
            />
          </AssemblyViewerBoundary>}
          <ViewerCanvasControls controlsRef={viewerControlsRef} />
        </div>
      )}
    </section>
  );
}
