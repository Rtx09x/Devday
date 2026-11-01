import type { AgentRequestPreset } from './agentSession.ts';

export interface AgentRequestCardLocalState {
  targetKey: string;
  draft: string;
  expanded: boolean;
  presetId?: AgentRequestPreset['id'];
  refusal?: string;
}

export function agentRequestCardDraftBoundaryKey(
  targetKey: string,
  defaultRequest: string,
  requestPresets: ReadonlyArray<{ label: string; request: string }>,
): string {
  return JSON.stringify([targetKey, defaultRequest, requestPresets]);
}

export type AgentRequestCardLocalAction =
  | { type: 'target'; targetKey: string; defaultRequest: string }
  | { type: 'toggle-expanded' }
  | { type: 'draft'; draft: string; clearRefusal: boolean }
  | { type: 'preset'; presetId: AgentRequestPreset['id']; draft: string }
  | { type: 'refusal'; message?: string };

export function createAgentRequestCardLocalState(
  targetKey: string,
  defaultRequest: string,
): AgentRequestCardLocalState {
  return { targetKey, draft: defaultRequest, expanded: false };
}

/** Local form state only; request concurrency and terminal state remain editor-owned. */
export function reduceAgentRequestCardLocalState(
  state: AgentRequestCardLocalState,
  action: AgentRequestCardLocalAction,
): AgentRequestCardLocalState {
  if (action.type === 'target') {
    if (state.targetKey === action.targetKey && state.draft === action.defaultRequest && !state.refusal) return state;
    return createAgentRequestCardLocalState(action.targetKey, action.defaultRequest);
  }
  if (action.type === 'toggle-expanded') return { ...state, expanded: !state.expanded };
  if (action.type === 'draft') {
    const { presetId: _presetId, ...rest } = state;
    return { ...rest, draft: action.draft, refusal: action.clearRefusal ? undefined : state.refusal };
  }
  if (action.type === 'preset') return { ...state, presetId: action.presetId, draft: action.draft, refusal: undefined };
  return { ...state, refusal: action.message };
}
