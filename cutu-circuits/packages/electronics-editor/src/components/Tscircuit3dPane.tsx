import { Component, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { configureTextBuilder } from 'troika-three-text';
import localTroikaFontUrl from 'three/examples/fonts/ttf/kenpixel.ttf?inline';
import type { AnyCircuitElement } from '../circuit/circuitJson';
import {
  TSCIRCUIT_3D_VIEWER_VERSION,
  Tscircuit3dViewer,
  inspectThreeDViewerContract,
} from '../tscircuit/threeDViewerContract';

// The upstream viewer sets troika text fonts to null, which otherwise selects
// troika's remote default. This dependency-owned TTF is inlined into index.js as
// a data URL before the first text request, so orientation labels stay offline.
configureTextBuilder({ defaultFontURL: localTroikaFontUrl });

class ViewerBoundary extends Component<{
  children: ReactNode;
  onFailure: (message: string) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ElectronicsStudio] tscircuit 3D viewer failed:', error, info);
    this.props.onFailure(error.message || 'The viewer raised an unknown render error.');
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ViewerErrorCard({ reason, onReload }: { reason: string; onReload: () => void }) {
  return (
    <div className="es-viewer-error-card" role="alert">
      <strong>3D viewer unavailable</strong>
      <p>{reason}</p>
      <button type="button" onClick={onReload}>Reload viewer</button>
    </div>
  );
}

function resolveOfflineStaticAsset(_url: string): undefined {
  // Refuse every per-part model URL, including STEP and embedded URL variants.
  // Returning undefined makes 0.0.577 use model_jscad/footprinter procedural
  // geometry when present and guarantees this pane never enters a URL loader.
  return undefined;
}

export function Tscircuit3dPane({
  circuitJson,
  loading,
}: {
  circuitJson: AnyCircuitElement[];
  loading: boolean;
}) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [viewerError, setViewerError] = useState<string>();
  const [reloadRevision, setReloadRevision] = useState(0);
  const [viewerSize, setViewerSize] = useState<{ width: number; height: number }>();
  const contract = inspectThreeDViewerContract(Tscircuit3dViewer);
  // The audited 0.0.577 render path filters/maps/finds elements without
  // mutating them. Preserve the shared array identity defensively; a deep copy
  // is unnecessary for this exact version and would add avoidable render cost.
  const viewerCircuitJson = useMemo(() => [...circuitJson], [circuitJson]);

  useLayoutEffect(() => {
    const host = canvasHostRef.current;
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

  const reloadViewer = () => {
    setViewerError(undefined);
    setViewerSize(undefined);
    setReloadRevision((revision) => revision + 1);
  };

  if (loading) return <div className="es-loading"><span className="es-loading-spinner" /><strong className="es-loading-title">Loading 3D board…</strong></div>;
  const unavailableReason = contract.usable ? viewerError : contract.reason ?? 'The pinned viewer contract is unavailable.';

  return (
    <section className="es-tscircuit-pcb es-tscircuit-3d" aria-label="3D board inspection viewer">
      <header>
        <div>
          <small>Upstream viewer · package {TSCIRCUIT_3D_VIEWER_VERSION} · offline JSCAD renderer</small>
          <strong>Read-only 3D board inspection</strong>
        </div>
      </header>
      <p>Drag to orbit and scroll to zoom. External model URLs are blocked; standard footprinter and JSCAD component geometry remains available offline.</p>
      {unavailableReason ? <ViewerErrorCard reason={unavailableReason} onReload={reloadViewer} /> : (
        <div ref={canvasHostRef} className="es-3d-viewer-bridge">
          {viewerSize && <ViewerBoundary key={reloadRevision} onFailure={setViewerError}>
            <div style={{ width: viewerSize.width, height: viewerSize.height }}>
              <Tscircuit3dViewer
                circuitJson={viewerCircuitJson}
                autoRotateDisabled
                clickToInteractEnabled={false}
                resolveStaticAsset={resolveOfflineStaticAsset}
              />
            </div>
          </ViewerBoundary>}
        </div>
      )}
    </section>
  );
}
