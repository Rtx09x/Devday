/** Searchable navigator for components already placed in the design. */

import { useEffect, useMemo, useState } from 'react';
import Button from '@cutucircuits/ui/button';
import SearchField from '@cutucircuits/ui/search-field';
import type { ComponentSummary } from '../circuit/circuitJson';
import type { PairEvidenceSnapshot, PairSelectionState } from '../circuit/pairSelection';
import type { PinSelectionSnapshot } from '../circuit/pinSelection';
import { evidenceFindingByComponentId, presentPartEvidence, type PartEvidenceFinding, type PartEvidenceReport } from '../circuit/partEvidence';
import { FUNCTIONAL_BLOCKS } from '../circuit/functionalBlocks';
import {
  getProjectTemplate,
  projectTemplateAgentTargetIdentity,
  PROJECT_TEMPLATES,
  type ProjectTemplateId,
} from '../circuit/projectTemplates';
import {
  boundAgentTargetLabel,
  buildPartRequestPresets,
  buildPinRequestPresets,
  PAIR_DEFAULT_REQUEST,
  PART_EXPLAIN_DEFAULT_REQUEST,
  PIN_EXPLAIN_DEFAULT_REQUEST,
  type AgentProvider,
  type AgentProviderPreference,
  type AgentRequestPreset,
  type AgentRequestStatus,
  type AgentSendAvailability,
} from '../agentSession';
import { AgentRequestCard } from './AgentRequestCard';
import { formatElectricalValue } from '../circuit/valueFormatting';

function partGlyph(part: ComponentSummary): string {
  const type = part.ftype ?? '';
  if (type.includes('chip')) return 'IC';
  if (type.includes('resistor')) return 'R';
  if (type.includes('capacitor')) return 'C';
  if (type.includes('inductor')) return 'L';
  if (type.includes('led')) return 'LED';
  if (type.includes('diode')) return 'D';
  if (type.includes('switch') || type.includes('button')) return 'SW';
  if (type.includes('header')) return 'J';
  return '•';
}

function partDescription(part: ComponentSummary): string {
  if (part.value != null) return formatElectricalValue(part.numericValue ?? part.value, part.valueUnit);
  return part.footprint ?? part.ftype?.replace(/^simple_/, '').replace(/_/g, ' ') ?? 'Component';
}

export function PartsPalette({
  components,
  partEvidence,
  selectedId,
  onSelectPart,
  editable,
  onUpdatePart,
  onRemovePart,
  onAddStarter,
  projectTemplateEligible,
  selectedProjectTemplateId,
  onSelectProjectTemplate,
  projectTemplateAgentAvailability,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  showAgentCard = true,
  onAgentProviderChange,
  onAskAgent,
  selectedPin,
  onAskPin,
  onAskProjectTemplate,
  pairSelection,
  pairEvidence,
  onStartPair,
  onChangePairSecond,
  onClearPair,
  onAskPair,
  pairStartDisabled = false,
}: {
  components: ComponentSummary[];
  partEvidence?: PartEvidenceReport;
  selectedId?: string;
  onSelectPart: (part: ComponentSummary) => void;
  editable: boolean;
  onUpdatePart: (part: ComponentSummary, changes: { value?: string; footprint?: string }) => void;
  onRemovePart: (part: ComponentSummary) => void;
  onAddStarter: (blockKey: string) => void;
  projectTemplateEligible: boolean;
  selectedProjectTemplateId?: ProjectTemplateId;
  onSelectProjectTemplate: (templateId: ProjectTemplateId) => void;
  projectTemplateAgentAvailability: AgentSendAvailability;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  showAgentCard?: boolean;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (part: ComponentSummary, request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
  selectedPin?: PinSelectionSnapshot;
  onAskPin: (request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
  onAskProjectTemplate: (request: string, provider: AgentProvider) => Promise<void>;
  pairSelection: PairSelectionState;
  pairEvidence?: PairEvidenceSnapshot;
  onStartPair: (part?: ComponentSummary) => void;
  onChangePairSecond: () => void;
  onClearPair: () => void;
  onAskPair: (request: string, provider: AgentProvider) => Promise<void>;
  pairStartDisabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(
    () => components.filter((part) => (
      `${part.name} ${part.ftype ?? ''} ${part.value ?? ''} ${part.footprint ?? ''}`.toLowerCase().includes(normalized)
    )),
    [components, normalized],
  );
  const selected = components.find((part) => part.id === selectedId);
  const evidenceById = useMemo(() => evidenceFindingByComponentId(partEvidence), [partEvidence]);

  return (
    <aside className="es-palette" aria-label="Design navigator">
      <div className="es-palette-heading">
        <div>
          <div className="es-eyebrow">Navigate</div>
          <div className="es-palette-title">Placed parts</div>
        </div>
        <span className="es-count-badge">{components.length}</span>
      </div>
      {pairSelection.phase !== 'idle' && (
        <PairSelectionPanel
          selection={pairSelection}
          evidence={pairEvidence}
          agentAvailability={agentAvailability}
          agentProviderPreference={agentProviderPreference}
          agentRequestStatus={agentRequestStatus}
          onChangeSecond={onChangePairSecond}
          onClear={onClearPair}
          onAgentProviderChange={onAgentProviderChange}
          onAskAgent={onAskPair}
        />
      )}

      <SearchField
        className="es-search"
        aria-label="Search placed parts"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Find a ref, value, or footprint"
        trailing={query ? (
          <Button variant="ghost" shape="icon" size="sm" aria-label="Clear search" onClick={() => setQuery('')}>×</Button>
        ) : undefined}
      />

      {!selected && !selectedPin && pairSelection.phase === 'idle' && (
        <div className="es-palette-note es-navigator-note">
          Select a part to highlight it on the canvas and see its exact identity.
        </div>
      )}

      <div className="es-palette-scroll">
        <section className="es-palette-group">
          {filtered.map((part) => (
            <button
              key={part.id || part.name}
              className={selectedId === part.id ? 'es-palette-item es-palette-item-active' : 'es-palette-item'}
              onClick={() => onSelectPart(part)}
              title={`Show ${part.name}`}
              aria-pressed={selectedId === part.id}
            >
              <span className="es-part-glyph">{partGlyph(part)}</span>
              <span className="es-part-copy">
                <strong>{part.name}</strong>
                <small>{partDescription(part)}</small>
              </span>
              {evidenceById.get(part.id) && <EvidenceBadge finding={evidenceById.get(part.id)!} />}
              <span className="es-part-jump" aria-hidden="true">⌖</span>
            </button>
          ))}
        </section>

        {filtered.length === 0 && (
          <div className="es-library-empty">
            <span>⌕</span>
            <strong>{components.length === 0 ? 'No placed parts' : 'No matching parts'}</strong>
            <small>{components.length === 0 ? 'Components will appear here when the design evaluates.' : 'Try a ref, value, type, or footprint.'}</small>
            {components.length === 0 && editable && (
              <div className="es-starter-grid" aria-label="Circuit starters">
                {projectTemplateEligible && PROJECT_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    className={selectedProjectTemplateId === template.id ? 'es-template-choice es-template-choice-selected' : 'es-template-choice'}
                    onClick={() => onSelectProjectTemplate(template.id)}
                    aria-pressed={selectedProjectTemplateId === template.id}
                  >
                    <strong>✦ {template.label}</strong>
                    <small>{template.description}</small>
                    <small className="es-template-prompt">Ask agent: “{template.suggestedPrompt}”</small>
                  </button>
                ))}
                {FUNCTIONAL_BLOCKS.map((block) => (
                  <button key={block.key} onClick={() => onAddStarter(block.key)}>
                    <strong>{block.label}</strong>
                    <small>{block.description}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {selectedProjectTemplateId && (
        <TemplateAgentRequestCard
          templateId={selectedProjectTemplateId}
          agentAvailability={projectTemplateAgentAvailability}
          agentProviderPreference={agentProviderPreference}
          agentRequestStatus={agentRequestStatus}
          onAgentProviderChange={onAgentProviderChange}
          onAskAgent={onAskProjectTemplate}
        />
      )}
      {selected && (
        <PartInspector
          key={selected.id || selected.name}
          part={selected}
          evidence={evidenceById.get(selected.id)}
          editable={editable}
          onUpdate={onUpdatePart}
          onRemove={onRemovePart}
          agentAvailability={agentAvailability}
          agentProviderPreference={agentProviderPreference}
          agentRequestStatus={agentRequestStatus}
          showAgentCard={showAgentCard}
          onAgentProviderChange={onAgentProviderChange}
          onAskAgent={onAskAgent}
          selectedPin={selectedPin}
          onAskPin={onAskPin}
          onStartPair={() => onStartPair(selected)}
          pairStartDisabled={pairStartDisabled}
        />
      )}
    </aside>
  );
}

export function TemplateAgentRequestCard({
  templateId,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onAgentProviderChange,
  onAskAgent,
}: {
  templateId: ProjectTemplateId;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (request: string, provider: AgentProvider) => Promise<void>;
}) {
  const template = getProjectTemplate(templateId);
  return (
    <AgentRequestCard
      targetKey={projectTemplateAgentTargetIdentity(templateId)}
      title={template.cardTitle.replace(/^Ask agent to start the /, 'Template agent · ')}
      description={template.cardDescription}
      defaultRequest={template.defaultRequest}
      agentAvailability={agentAvailability}
      agentProviderPreference={agentProviderPreference}
      agentRequestStatus={agentRequestStatus}
      onAgentProviderChange={onAgentProviderChange}
      onAskAgent={onAskAgent}
    />
  );
}

function PartInspector({
  part,
  evidence,
  editable,
  onUpdate,
  onRemove,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  showAgentCard,
  onAgentProviderChange,
  onAskAgent,
  selectedPin,
  onAskPin,
  onStartPair,
  pairStartDisabled,
}: {
  part: ComponentSummary;
  evidence?: PartEvidenceFinding;
  editable: boolean;
  onUpdate: (part: ComponentSummary, changes: { value?: string; footprint?: string }) => void;
  onRemove: (part: ComponentSummary) => void;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  showAgentCard: boolean;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (part: ComponentSummary, request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
  selectedPin?: PinSelectionSnapshot;
  onAskPin: (request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
  onStartPair: () => void;
  pairStartDisabled: boolean;
}) {
  const [value, setValue] = useState(part.value ?? '');
  const [footprint, setFootprint] = useState(part.footprint ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const changed = value !== (part.value ?? '') || footprint !== (part.footprint ?? '');

  useEffect(() => {
    setValue(part.value ?? '');
    setFootprint(part.footprint ?? '');
    setConfirmRemove(false);
    setError('');
  }, [part]);

  const save = () => {
    setError('');
    try {
      onUpdate(part, {
        value: value !== (part.value ?? '') ? value : undefined,
        footprint: footprint !== (part.footprint ?? '') ? footprint : undefined,
      });
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const remove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setError('');
    try {
      onRemove(part);
    } catch (caught) {
      setError((caught as Error).message);
      setConfirmRemove(false);
    }
  };

  return (
    <section className="es-part-inspector" aria-label={`Selected ${part.name}`}>
      <div className="es-part-inspector-head">
        <span className="es-ref">{part.name}</span>
        <small>{part.ftype?.replace(/^simple_/, '').replace(/_/g, ' ') ?? 'component'}</small>
      </div>
      <button
        className="es-pair-start"
        onClick={onStartPair}
        disabled={pairStartDisabled}
        title={pairStartDisabled ? 'Dismiss the applied-change reveal before starting Pair mode.' : 'Pair this part with another schematic or Advisor part'}
      >Pair with another…</button>
      {showAgentCard && (selectedPin ? (
        <PinAgentRequestCard
          pin={selectedPin}
          agentAvailability={agentAvailability}
          agentProviderPreference={agentProviderPreference}
          agentRequestStatus={agentRequestStatus}
          onAgentProviderChange={onAgentProviderChange}
          onAskAgent={onAskPin}
        />
      ) : (
        <PartAgentRequestCard
          part={part}
          agentAvailability={agentAvailability}
          agentProviderPreference={agentProviderPreference}
          agentRequestStatus={agentRequestStatus}
          onAgentProviderChange={onAgentProviderChange}
          onAskAgent={onAskAgent}
        />
      ))}
      {evidence && (
        <div className={`es-part-evidence-card es-part-evidence-${evidence.status}`} data-evidence-status={evidence.status}>
          <strong>{evidence.status}</strong>
          <p>{presentPartEvidence(evidence).detail}</p>
          {evidence.sources?.map((item) => (
            <small key={item.source} data-source-presence={item.state}>{item.source} [{item.state}]{item.notes ? ` — ${item.notes}` : ''}</small>
          ))}
        </div>
      )}
      {editable ? (
        <details className="es-manual-part-controls">
          <summary>Manual adjustments</summary>
          <div>
            <label>Value<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Part value" /></label>
            <label>Footprint<input value={footprint} onChange={(event) => setFootprint(event.target.value)} placeholder="Footprint" /></label>
            {error && <p className="es-part-inspector-error">{error}</p>}
            <div className="es-part-inspector-actions">
              <button onClick={save} disabled={!changed}>Apply</button>
              <button className={confirmRemove ? 'es-part-remove es-part-remove-confirm' : 'es-part-remove'} onClick={remove}>
                {confirmRemove ? `Confirm remove ${part.name}` : 'Remove'}
              </button>
              {confirmRemove && <button className="es-part-cancel" onClick={() => setConfirmRemove(false)}>Cancel</button>}
            </div>
          </div>
        </details>
      ) : <p>Circuit JSON is inspection-only; the agent can explain it but cannot mutate this source.</p>}
    </section>
  );
}

export function PairSelectionPanel({
  selection,
  evidence,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onChangeSecond,
  onClear,
  onAgentProviderChange,
  onAskAgent,
}: {
  selection: PairSelectionState;
  evidence?: PairEvidenceSnapshot;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onChangeSecond: () => void;
  onClear: () => void;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (request: string, provider: AgentProvider) => Promise<void>;
}) {
  const components = selection.phase === 'idle' ? [] : selection.components;
  return (
    <section className="es-pair-panel" aria-label="Pair parts">
      <div className="es-pair-heading"><strong>Pair &amp; Ask</strong><span>{components.length}/2</span></div>
      <p>{selection.phase === 'collecting'
        ? selection.components.length === 0 ? 'Select the first part on the schematic or in Advisor.' : `${selection.components[0].ref} selected · choose another schematic or Advisor part.`
        : selection.phase === 'ready' ? `${selection.components[0].ref} + ${selection.components[1].ref}` : 'Pair mode is idle.'}</p>
      <small>Explicit source-component identities only. Selection and typing do not send or change the design.</small>
      <div className="es-pair-actions">
        {selection.phase === 'ready' && <button onClick={onChangeSecond}>Change second</button>}
        <button onClick={onClear}>Clear pair</button>
      </div>
      {selection.phase === 'ready' && evidence && (
        <>
          <PairEvidenceSummary evidence={evidence} />
          <PairAgentRequestCard
            evidence={evidence}
            agentAvailability={agentAvailability}
            agentProviderPreference={agentProviderPreference}
            agentRequestStatus={agentRequestStatus}
            onAgentProviderChange={onAgentProviderChange}
            onAskAgent={onAskAgent}
          />
        </>
      )}
      {selection.phase === 'ready' && !evidence && <p className="es-part-inspector-error">Pair evidence is stale or ambiguous. Clear and select both parts again.</p>}
    </section>
  );
}

export function PairEvidenceSummary({ evidence }: { evidence: PairEvidenceSnapshot }) {
  return (
    <div className="es-pair-evidence" aria-label="Exact Pair evidence">
      {evidence.components.map((component, index) => {
        const untracedTotal = component.untraced.length + component.omittedUntraced;
        const tracedTotal = component.traced.length + component.omittedTraced;
        return (
          <section key={component.sourceComponentId}>
            <strong>{index + 1}/2 · {component.ref}</strong>
            <small>sourceComponentId: <code>{component.sourceComponentId}</code></small>
            <small>Untraced canonical ports: {component.untraced.length}/{untracedTotal} shown</small>
            {component.untraced.map((port) => (
              <code key={port.sourcePortId}>{port.selector} · {port.sourcePortId}</code>
            ))}
            <small>Traced participation: {component.traced.length}/{tracedTotal} shown</small>
          </section>
        );
      })}
      <p>“Untraced” means absence from evaluated source_trace membership only; it is not compatibility or need evidence.</p>
    </div>
  );
}

export function PairAgentRequestCard({
  evidence,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onAgentProviderChange,
  onAskAgent,
}: {
  evidence: PairEvidenceSnapshot;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (request: string, provider: AgentProvider) => Promise<void>;
}) {
  return (
    <AgentRequestCard
      key={evidence.targetKey}
      targetKey={evidence.targetKey}
      title={`Ask pair · ${boundAgentTargetLabel(evidence.refs.join(' + '), 'selected pair')}`}
      description="Re-resolves both exact parts and rebuilds bounded evidence at Ask time. At most one connection preview may be staged; approval is never resolved automatically."
      defaultRequest={PAIR_DEFAULT_REQUEST}
      agentAvailability={agentAvailability}
      agentProviderPreference={agentProviderPreference}
      agentRequestStatus={agentRequestStatus}
      onAgentProviderChange={onAgentProviderChange}
      onAskAgent={onAskAgent}
    />
  );
}

export function PartAgentRequestCard({
  part,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onAgentProviderChange,
  onAskAgent,
}: {
  part: ComponentSummary;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (part: ComponentSummary, request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
}) {
  return (
    <AgentRequestCard
      key={part.id}
      targetKey={`part:${part.id}`}
      title={`Ask agent · ${boundAgentTargetLabel(part.name, 'selected part')}`}
      description="Starts only when you click. Explain/custom requests are read-only; Check evidence refreshes local presence; Validate record checks without writing; Create contribution may write one standalone versioned no-clobber draft plus manifest; Wire one port and Fix assembly blocker may each stage one exact preview and stop for approval."
      defaultRequest={PART_EXPLAIN_DEFAULT_REQUEST}
      requestPresets={buildPartRequestPresets()}
      agentAvailability={agentAvailability}
      agentProviderPreference={agentProviderPreference}
      agentRequestStatus={agentRequestStatus}
      onAgentProviderChange={onAgentProviderChange}
      onAskAgent={(request, provider, intentId) => onAskAgent(part, request, provider, intentId)}
    />
  );
}

export function PinAgentRequestCard({
  pin,
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onAgentProviderChange,
  onAskAgent,
}: {
  pin: PinSelectionSnapshot;
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
}) {
  const traces = pin.logicalTraceCount === 0
    ? 'not present in any evaluated source trace'
    : `present in ${pin.logicalTraceCount} evaluated source trace${pin.logicalTraceCount === 1 ? '' : 's'}`;
  return (
    <AgentRequestCard
      targetKey={pin.targetKey}
      title={`Pin Scout · ${pin.ref}.${pin.port}`}
      description="One complete exact trace lights its schematic peer ports and stable-key wire; multi-trace or capped evidence stays selected-pin-only. Selection and typing never send or edit."
      expandedDetail={`${pin.selector} · ${pin.sourcePortId} · ${traces}.`}
      defaultRequest={PIN_EXPLAIN_DEFAULT_REQUEST}
      requestPresets={buildPinRequestPresets(pin.currentlyUntraced)}
      agentAvailability={agentAvailability}
      agentProviderPreference={agentProviderPreference}
      agentRequestStatus={agentRequestStatus}
      onAgentProviderChange={onAgentProviderChange}
      onAskAgent={onAskAgent}
    />
  );
}

function EvidenceBadge({ finding }: { finding: PartEvidenceFinding }) {
  return <span className={`es-evidence-badge es-evidence-${finding.status}`} data-evidence-status={finding.status}>{finding.status}</span>;
}
