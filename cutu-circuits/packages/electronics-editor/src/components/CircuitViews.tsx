/** Shared direct-viewer evidence cards and PCB layer controls. */

import type { ReactNode } from 'react';
import type { CanvasFeedback } from '../sim/canvasFeedback';
import type { ActivePcbMeasurement } from '../circuit/pcbMeasurement';
import type { ActivePcbGrid } from '../circuit/pcbGrid';
import type { ActivePcbRouteProposal } from '../circuit/pcbRouteProposal';
import type { ActivePcbRuleLens } from '../circuit/pcbRuleLens';
import type { ActivePartTrustSpotlight } from '../circuit/partTrustSpotlight';
import type { ActiveAssemblyHandoffSpotlight } from '../circuit/assemblyHandoffSpotlight';
import type { ActiveConnectivityEvidence } from '../circuit/connectivityEvidence';
import type { PcbLayerDefinition, PcbLayerViewResult } from '../circuit/pcbLayerView';
export type { PcbLayerDefinition } from '../circuit/pcbLayerView';

export function CanvasFeedbackEvidence({
  feedback,
  onSelectFeedback,
}: {
  feedback?: CanvasFeedback | null;
  onSelectFeedback?: (sourceComponentId: string) => void;
}) {
  if (!feedback || feedback.components.length === 0) return null;
  return (
    <button
      type="button"
      className={`es-sim-canvas-evidence es-sim-canvas-evidence-${feedback.components[0].kind}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => onSelectFeedback?.(feedback.components[0].sourceComponentId)}
      title="Select this exact simulation evidence and publish its component to host context"
    >
      <span aria-hidden="true">●</span>
      <strong>{feedback.components[0].kind === 'mcu-activity' ? 'MCU activity' : 'Logical model'}</strong>
      <small>{feedback.components.map((component) => component.label).join(', ')}</small>
      <b>✦ context</b>
    </button>
  );
}

export function PcbOverlayCards({
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
}: {
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
}) {
  if (!grid && !routeProposal && !ruleLens && !measurement && !connectivityEvidence && !partTrustSpotlight && !assemblyHandoffSpotlight) return null;
  return (
    <div className="es-pcb-overlay-stack">
      {connectivityEvidence && <ConnectivityEvidenceCard evidence={connectivityEvidence} onClear={onClearConnectivityEvidence} />}
      {partTrustSpotlight && <PartTrustSpotlightCard active={partTrustSpotlight} onClear={onClearPartTrustSpotlight} />}
      {assemblyHandoffSpotlight && <AssemblyHandoffSpotlightCard active={assemblyHandoffSpotlight} onClear={onClearAssemblyHandoffSpotlight} />}
      {ruleLens && <PcbRuleLensCard active={ruleLens} onClear={onClearRuleLens} />}
      {routeProposal && <PcbRouteProposalCard active={routeProposal} onClear={onClearRouteProposal} />}
      {grid && <PcbGridCard grid={grid} onClear={onClearGrid} />}
      {measurement && <PcbMeasurementCard measurement={measurement} onClear={onClearMeasurement} />}
    </div>
  );
}

export function SchematicOverlayCards({
  connectivityEvidence,
  onClearConnectivityEvidence,
  partTrustSpotlight,
  onClearPartTrustSpotlight,
  assemblyHandoffSpotlight,
  onClearAssemblyHandoffSpotlight,
}: {
  connectivityEvidence?: ActiveConnectivityEvidence;
  onClearConnectivityEvidence?: () => unknown;
  partTrustSpotlight?: ActivePartTrustSpotlight;
  onClearPartTrustSpotlight?: () => unknown;
  assemblyHandoffSpotlight?: ActiveAssemblyHandoffSpotlight;
  onClearAssemblyHandoffSpotlight?: () => unknown;
}) {
  if (!connectivityEvidence && !partTrustSpotlight && !assemblyHandoffSpotlight) return null;
  return (
    <div className="es-schematic-overlay-stack">
      {connectivityEvidence && <ConnectivityEvidenceCard evidence={connectivityEvidence} onClear={onClearConnectivityEvidence} />}
      {partTrustSpotlight && <PartTrustSpotlightCard active={partTrustSpotlight} onClear={onClearPartTrustSpotlight} />}
      {assemblyHandoffSpotlight && <AssemblyHandoffSpotlightCard active={assemblyHandoffSpotlight} onClear={onClearAssemblyHandoffSpotlight} />}
    </div>
  );
}

function PcbRouteProposalCard({ active, onClear }: { active: ActivePcbRouteProposal; onClear?: () => unknown }) {
  const result = active.result;
  const layers = Object.entries(result.layerCounts).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="es-pcb-route-proposal-card" aria-live="polite" aria-label="Active PCB route proposal">
      <header>
        <div><small>Read-only · session-only</small><strong>PCB route proposal</strong></div>
        <button onClick={onClear} aria-label="Clear PCB route proposal">Clear</button>
      </header>
      <div className="es-pcb-route-proposal-values">
        <span><small>Candidate traces</small><b>{result.traceCount}</b></span>
        <span><small>Overlay lines</small><b>{result.overlayLineCount}</b></span>
        <span><small>Solver progress</small><b>{Math.round(result.solverProgress * 100)}%</b></span>
        <span><small>Duration</small><b>{result.durationMs} ms</b></span>
      </div>
      <p>{layers.length > 0 ? layers.map(([layer, count]) => `${layer}: ${count}`).join(' · ') : 'No candidate copper returned.'}</p>
      <footer title={result.limitation}>Projection {result.inputHash.slice(0, 12)} · candidate geometry only · not applied/DRC/DFM</footer>
    </section>
  );
}

function PcbRuleLensCard({ active, onClear }: { active: ActivePcbRuleLens; onClear?: () => unknown }) {
  const { result } = active;
  const minimumTrace = result.observed.minimumTraceWidthMm;
  const minimumVia = result.observed.minimumViaHoleDiameterMm;
  const minimumEdge = [
    result.observed.minimumTraceRoutePointEdgeGapMm,
    result.observed.minimumViaPadEdgeGapMm,
  ].filter((value): value is number => value != null).sort((a, b) => a - b)[0];
  const minimumPadGap = result.observed.minimumPadToPadEdgeGapMm;
  const minimumAnnularRing = result.observed.minimumPlatedHoleAnnularRingMm;
  return (
    <section className={`es-pcb-rule-lens-card es-pcb-rule-lens-${result.status}`} aria-live="polite" aria-label="Active PCB Rule Lens">
      <header>
        <div><small>Read-only · {result.reference.label}</small><strong>✦ PCB Rule Lens · {result.status}</strong></div>
        <button onClick={onClear} aria-label="Clear PCB Rule Lens">×</button>
      </header>
      <div className="es-pcb-rule-lens-values">
        <span><small>Violations</small><b>{result.counts.violations}</b></span>
        <span><small>Indeterminate</small><b>{result.counts.indeterminate}</b></span>
        <span><small>Min trace</small><b>{minimumTrace == null ? '—' : `${minimumTrace.toFixed(3)} mm`}</b></span>
        <span><small>Min via drill</small><b>{minimumVia == null ? '—' : `${minimumVia.toFixed(3)} mm`}</b></span>
        <span><small>Min edge envelope</small><b>{minimumEdge == null ? '—' : `${minimumEdge.toFixed(3)} mm`}</b></span>
        <span><small>Min pad gap</small><b>{minimumPadGap == null ? '—' : `${minimumPadGap.toFixed(3)} mm`}</b></span>
        <span><small>Min PTH ring</small><b>{minimumAnnularRing == null ? '—' : `${minimumAnnularRing.toFixed(3)} mm`}</b></span>
      </div>
      <p>{result.counts.markers} exact marker{result.counts.markers === 1 ? '' : 's'}{result.counts.omittedMarkers ? ` · ${result.counts.omittedMarkers} markers omitted` : ''}{result.counts.omittedFindings ? ` · ${result.counts.omittedFindings} findings omitted` : ''}</p>
      <footer title={result.limitation}>{result.reference.kind === 'loaded-project-guidance'
        ? 'Loaded project minima'
        : result.reference.kind === 'reviewed-fab-profile'
          ? 'Dated reviewed capability profile · explicit assumptions'
          : 'Own declared minima'} · bounded envelopes only · not whole-board clearance/DRC/fab acceptance</footer>
    </section>
  );
}

function PartTrustSpotlightCard({ active, onClear }: { active: ActivePartTrustSpotlight; onClear?: () => unknown }) {
  const { result } = active;
  const refs = result.findings.slice(0, 8).map((finding) => finding.ref);
  const omitted = result.findings.length - refs.length;
  return (
    <section className="es-part-trust-card" aria-live="polite" aria-label="Active Part Trust Spotlight">
      <header><div><small>Local report · session-only</small><strong>✦ Part Trust Spotlight</strong></div><button onClick={onClear} aria-label="Clear Part Trust Spotlight">×</button></header>
      <p>{result.statuses.join(' + ')} · {result.counts.total} part{result.counts.total === 1 ? '' : 's'}</p>
      <div className="es-part-trust-values">
        <span><small>Schematic</small><b>{result.counts.schematicMappedParts}/{result.counts.total}</b></span>
        <span><small>PCB</small><b>{result.counts.pcbMappedParts}/{result.counts.total}</b></span>
        <span><small>Local file</small><b>{result.evidenceFile.state}</b></span>
      </div>
      {refs.length > 0 && <p>{refs.join(', ')}{omitted > 0 ? ` +${omitted} more` : ''}</p>}
      <footer title={result.limitations.join(' ')}>Path presence/local-record agreement only · not verified/electrical/authentic/available/orderable/manufacturing</footer>
    </section>
  );
}

function AssemblyHandoffSpotlightCard({ active, onClear }: { active: ActiveAssemblyHandoffSpotlight; onClear?: () => unknown }) {
  const { result } = active;
  const findings = result.findings.slice(0, 8);
  const omitted = result.findings.length - findings.length;
  return (
    <section className="es-assembly-scout-card" aria-live="polite" aria-label="Active Assembly Scout">
      <header><div><small>Installed template · session-only</small><strong>✦ Assembly Scout</strong></div><button onClick={onClear} aria-label="Clear Assembly Scout">×</button></header>
      <p>{result.mode} · {result.counts.total} selected part{result.counts.total === 1 ? '' : 's'}</p>
      <div className="es-assembly-scout-values">
        <span><small>Blocked</small><b>{result.counts.blocked}</b></span>
        <span><small>Ready</small><b>{result.counts.ready}</b></span>
        <span><small>Schematic</small><b>{result.counts.schematicMappedParts}/{result.counts.total}</b></span>
        <span><small>PCB</small><b>{result.counts.pcbMappedParts}/{result.counts.total}</b></span>
      </div>
      {findings.length > 0 && <ul>{findings.map((finding) => <li key={finding.sourceComponentId}><b>{finding.ref}</b>{finding.issueCodes.length > 0 ? ` · ${finding.issueCodes.join(', ')}` : ' · complete'}</li>)}</ul>}
      {omitted > 0 && <p>+{omitted} more exact part{omitted === 1 ? '' : 's'}</p>}
      <footer title={result.limitations.join(' ')}>Installed text-template completeness only · not portal/stock/orientation/ERC/DRC/DFM/assembly validation</footer>
    </section>
  );
}

function ConnectivityEvidenceCard({ evidence, onClear }: { evidence: ActiveConnectivityEvidence; onClear?: () => unknown }) {
  const result = evidence.result;
  const globalUnrouted = result.unroutedNetAttribution === 'global-zero-pcb-traces';
  return (
    <section className="es-connectivity-card" aria-live="polite" aria-label="Active connectivity evidence">
      <header>
        <div><small>Read-only · current evaluation</small><strong>Connectivity evidence</strong></div>
        <button onClick={onClear} aria-label="Clear connectivity evidence">×</button>
      </header>
      <div className="es-connectivity-values">
        <span><small>Absent ports</small><b>{result.unconnectedPorts.length}</b></span>
        <span><small>Logical nets</small><b>{result.unroutedNets.length}</b></span>
        <span><small>PCB traces</small><b>{result.pcbTraceCount}</b></span>
        <span><small>PCB markers</small><b>{result.pcbMarkerCount}</b></span>
      </div>
      <p>{globalUnrouted
        ? 'Logical-net evidence is shown only because this evaluation contains zero PCB traces globally.'
        : 'Unrouted-net attribution is indeterminate because PCB copper lacks stable source-connectivity identity.'}</p>
      <footer title={result.limitations.join(' ')}>Markers are exact ports, not copper/routing · not ERC/DRC/fab validation</footer>
    </section>
  );
}

function PcbGridCard({ grid, onClear }: { grid: ActivePcbGrid; onClear?: () => unknown }) {
  const result = grid.result;
  return (
    <section className="es-pcb-grid-card" aria-live="polite" aria-label="Active PCB coordinate grid">
      <header>
        <div><small>Read-only · exact board coordinates</small><strong>PCB grid · {result.spacingMm.toFixed(3)} mm</strong></div>
        <button onClick={onClear} aria-label="Clear PCB coordinate grid">×</button>
      </header>
      <p>Major {result.majorSpacingMm.toFixed(3)} mm · every {result.majorEvery} · origin (0,0)</p>
      <footer title={result.limitation}>{result.counts.lines} lines · {result.counts.labels} labels · no snap/drag</footer>
    </section>
  );
}

function PcbMeasurementCard({ measurement, onClear }: { measurement: ActivePcbMeasurement; onClear?: () => unknown }) {
  const result = measurement.result;
  const title = result.mode === 'board'
    ? `${result.from.ref} → board edges`
    : `${result.from.ref} → ${result.to.ref}`;
  return (
    <section className={`es-pcb-measurement es-pcb-measurement-${result.relation}`} aria-live="polite" aria-label="Active PCB measurement">
      <header>
        <div><small>Read-only · {result.mode}</small><strong>{title}</strong></div>
        <button onClick={onClear} aria-label="Clear PCB measurement">×</button>
      </header>
      {result.mode === 'center' && <div className="es-pcb-measurement-values">
        <span><small>Distance</small><b>{result.distanceMm.toFixed(3)} mm</b></span>
        <span><small>ΔX</small><b>{result.dxMm.toFixed(3)} mm</b></span>
        <span><small>ΔY</small><b>{result.dyMm.toFixed(3)} mm</b></span>
      </div>}
      {result.mode === 'edge' && <div className="es-pcb-measurement-values">
        <span><small>Rectangle gap</small><b>{result.distanceMm.toFixed(3)} mm</b></span>
        <span><small>Relation</small><b>{result.relation}</b></span>
      </div>}
      {result.mode === 'board' && <>
        <div className="es-pcb-measurement-values es-pcb-measurement-board-values">
          {(['left', 'right', 'bottom', 'top'] as const).map((side) => <span key={side}>
            <small>{side}</small><b>{result.clearancesMm[side].toFixed(3)} mm</b>
          </span>)}
        </div>
        <p>Minimum: {result.minimum.side} {result.minimum.clearanceMm.toFixed(3)} mm · {result.relation}</p>
      </>}
      <footer title={result.limitation}>Evaluated rectangles · not DRC/clearance</footer>
    </section>
  );
}

export function PcbLayersPanel({
  layers,
  hiddenLayers,
  onHiddenLayersChange,
  agentView,
  onClearAgentView,
  children,
}: {
  layers: PcbLayerDefinition[];
  hiddenLayers: Set<string>;
  onHiddenLayersChange: (hidden: Set<string>) => void;
  agentView?: PcbLayerViewResult;
  onClearAgentView?: () => void;
  children?: ReactNode;
}) {
  const visibleCount = layers.filter((layer) => !hiddenLayers.has(layer.id)).length;
  const toggleLayer = (id: string) => {
    const next = new Set(hiddenLayers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onHiddenLayersChange(next);
  };

  return (
    <aside className="es-palette" aria-label="PCB layers">
      <div className="es-palette-heading es-layer-sidebar-heading">
        <div>
          <div className="es-eyebrow">PCB view</div>
          <div className="es-palette-title">Layers</div>
        </div>
        <span className="es-count-badge">{visibleCount}/{layers.length}</span>
      </div>

      <div className="es-layer-sidebar-actions">
        <span>{visibleCount} visible</span>
        <button
          type="button"
          onClick={() => onHiddenLayersChange(visibleCount === layers.length ? new Set(layers.map((layer) => layer.id)) : new Set())}
        >
          {visibleCount === layers.length ? 'Hide all' : 'Show all'}
        </button>
      </div>

      <div className="es-palette-note es-navigator-note">
        Toggle layer visibility. Display only — the board itself is not modified.
      </div>

      {agentView && (
        <section className="es-layer-lens-card" aria-live="polite" aria-label="Active agent PCB layer view">
          <header><div><small>Agent view · session-only</small><strong>✦ Layer Lens</strong></div><button type="button" onClick={onClearAgentView} aria-label="Clear agent PCB layer view">×</button></header>
          <p>{agentView.mode}{agentView.requestedLayerIds.length ? ` · ${agentView.requestedLayerIds.join(', ')}` : ''}</p>
          <footer>
            {agentView.visibleLayerIds.length}/{agentView.availableLayers.length} rendered groups visible
            {(agentView.unclassifiedRendered.length > 0 || agentView.structuralRendered.length > 0) && ' · uncontrolled renderer elements remain visible'}
            {agentView.suppressedSessionOverlays.length > 0 && ` · canvas-hidden: ${agentView.suppressedSessionOverlays.join(', ')}`}
            {' · visual only, not stackup/DRC/fabrication evidence'}
          </footer>
        </section>
      )}

      <div className="es-palette-scroll es-layer-list">
        {layers.map((layer) => {
          const visible = !hiddenLayers.has(layer.id);
          return (
            <button
              type="button"
              className={visible ? 'es-layer-row' : 'es-layer-row es-layer-hidden'}
              key={layer.id}
              aria-pressed={visible}
              aria-label={`${visible ? 'Hide' : 'Show'} ${layer.label}`}
              onClick={() => toggleLayer(layer.id)}
            >
              <span className="es-layer-swatch" style={{ backgroundColor: layer.color }} />
              <span className="es-layer-label">{layer.label}</span>
              <span className="es-layer-eye" aria-hidden="true" />
            </button>
          );
        })}
        {layers.length === 0 && (
          <div className="es-library-empty">
            <span>◇</span>
            <strong>No PCB layers</strong>
            <small>Layers appear after the PCB view renders.</small>
          </div>
        )}
      </div>
      {children}
    </aside>
  );
}
