import { useEffect, useReducer } from 'react';
import {
  AGENT_PROVIDERS,
  MAX_AGENT_REQUEST_LENGTH,
  type AgentProvider,
  type AgentProviderPreference,
  type AgentRequestStatus,
  type AgentSendAvailability,
} from '../agentSession';
import type { AgentRequestPreset } from '../agentSession';
import {
  agentRequestCardDraftBoundaryKey,
  createAgentRequestCardLocalState,
  reduceAgentRequestCardLocalState,
} from '../agentRequestCardState';

/** Presentation-only explicit-send form. Concurrency and terminal state stay editor-owned. */
export function AgentRequestCard({
  targetKey,
  title,
  description,
  expandedDetail,
  defaultRequest,
  requestPresets = [],
  agentAvailability,
  agentProviderPreference,
  agentRequestStatus,
  onAgentProviderChange,
  onAskAgent,
}: {
  targetKey: string;
  title: string;
  description: string;
  expandedDetail?: string;
  defaultRequest: string;
  requestPresets?: AgentRequestPreset[];
  agentAvailability: AgentSendAvailability;
  agentProviderPreference: AgentProviderPreference;
  agentRequestStatus?: AgentRequestStatus;
  onAgentProviderChange: (provider: AgentProvider) => void;
  onAskAgent: (request: string, provider: AgentProvider, intentId?: AgentRequestPreset['id']) => Promise<void>;
}) {
  const draftBoundaryKey = agentRequestCardDraftBoundaryKey(targetKey, defaultRequest, requestPresets);
  const [local, dispatchLocal] = useReducer(
    reduceAgentRequestCardLocalState,
    createAgentRequestCardLocalState(draftBoundaryKey, defaultRequest),
  );
  const agentRequest = local.draft;
  const refusal = local.refusal;
  const pending = agentRequestStatus?.phase === 'pending';
  const provider = agentProviderPreference.provider;
  const showCharacterCount = agentRequest.length > MAX_AGENT_REQUEST_LENGTH * 0.8;
  const providerPersistenceInfo = agentProviderPreference.persistence === 'persisted'
    ? 'Provider preference persisted in host storage.'
    : agentProviderPreference.persistence === 'saving'
      ? 'Saving provider preference…'
      : agentProviderPreference.warning ?? 'Provider choice is session-only until host storage succeeds.';
  const providerTooltip = `The configured provider may use the network and is not inherited from the current chat. ${providerPersistenceInfo}`;

  // Parent keys normally remount the card. This also makes the target boundary
  // explicit if a future caller reuses one component instance across targets.
  useEffect(() => {
    dispatchLocal({ type: 'target', targetKey: draftBoundaryKey, defaultRequest });
  }, [defaultRequest, draftBoundaryKey]);

  const askAgent = async () => {
    dispatchLocal({ type: 'refusal' });
    if (!agentAvailability.allowed) {
      dispatchLocal({ type: 'refusal', message: agentAvailability.reason ?? 'The agent request is unavailable. No request was sent.' });
      return;
    }
    if (!agentRequest.trim()) {
      dispatchLocal({ type: 'refusal', message: 'Enter a request for the selected target.' });
      return;
    }
    if (agentRequest.length > MAX_AGENT_REQUEST_LENGTH) {
      dispatchLocal({ type: 'refusal', message: `The request exceeds the ${MAX_AGENT_REQUEST_LENGTH}-character limit. Shorten it before sending.` });
      return;
    }
    try {
      await onAskAgent(agentRequest, provider, local.presetId);
    } catch (caught) {
      dispatchLocal({ type: 'refusal', message: (caught as Error).message || 'The host could not start the agent session. No request was sent.' });
    }
  };

  return (
    <div className="es-agent-selection-card" data-agent-target-key={targetKey}>
      <div className="es-agent-selection-header">
        <button
          type="button"
          className="es-agent-selection-toggle"
          aria-expanded={local.expanded}
          onClick={() => dispatchLocal({ type: 'toggle-expanded' })}
        >
          <span className="es-agent-selection-spark" aria-hidden="true">✦</span>
          <strong>{title}</strong>
          <span className="es-agent-selection-chevron" aria-hidden="true">›</span>
        </button>
        <span className="es-agent-selection-info" role="img" aria-label={description} title={description}>i</span>
      </div>
      {!agentAvailability.allowed && agentAvailability.reason && <p className="es-agent-request-error" role="status">{agentAvailability.reason}</p>}
      {refusal && <p className="es-agent-request-error" role="status" aria-live="polite">{refusal}</p>}
      {agentRequestStatus && (
        <p className={`es-agent-request-status es-agent-request-${agentRequestStatus.phase}`} role="status" aria-live="polite">
          {agentRequestStatus.target.identity === targetKey
            ? agentRequestStatus.message
            : `${agentRequestStatus.target.label}: ${agentRequestStatus.message}`}
        </p>
      )}
      {agentProviderPreference.persistence !== 'persisted' && (
        <small className={agentProviderPreference.persistence === 'session-only' ? 'es-agent-provider-warning' : undefined}>
          {providerPersistenceInfo}
        </small>
      )}
      {local.expanded && (
        <div className="es-agent-selection-content">
          {requestPresets.length > 0 && (
            <div className="es-agent-intents" aria-label="Request intent">
              {requestPresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={pending}
                  aria-pressed={local.presetId === preset.id && agentRequest === preset.request}
                  onClick={() => dispatchLocal({ type: 'preset', presetId: preset.id, draft: preset.request })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
          <textarea
            aria-label={title}
            value={agentRequest}
            onChange={(event) => {
              dispatchLocal({ type: 'draft', draft: event.target.value, clearRefusal: !pending });
            }}
            maxLength={MAX_AGENT_REQUEST_LENGTH}
            rows={2}
            disabled={pending}
          />
          <div className="es-agent-request-actions">
            <select
              aria-label="Agent provider"
              title={providerTooltip}
              value={provider}
              disabled={pending || agentProviderPreference.persistence === 'saving'}
              onChange={(event) => onAgentProviderChange(event.target.value as AgentProvider)}
            >
              {AGENT_PROVIDERS.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
            {showCharacterCount && (
              <small className="es-agent-character-count">{agentRequest.length}/{MAX_AGENT_REQUEST_LENGTH}</small>
            )}
            <button onClick={() => void askAgent()} disabled={!agentAvailability.allowed || !agentRequest.trim() || pending}>
              {pending ? 'Waiting…' : 'Ask agent'}
            </button>
          </div>
          {expandedDetail && <small className="es-agent-expanded-detail">{expandedDetail}</small>}
        </div>
      )}
    </div>
  );
}
