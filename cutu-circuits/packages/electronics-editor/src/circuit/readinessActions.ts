import type { ReadinessReport } from './readiness.ts';
import { setBoardSizeInCode } from './tscircuitCode.ts';

export const OUTLINE_READINESS_ACTION_ID = 'outline.make-explicit-from-geometry';

export interface ReadinessActionEdit {
  code: string;
  checkId: 'outline';
  actionId: typeof OUTLINE_READINESS_ACTION_ID;
  dimensions: { widthMm: number; heightMm: number };
}

/** Build an exact source proposal from an action advertised by the current report. */
export function buildReadinessActionEdit(
  code: string,
  report: ReadinessReport,
  requestedActionId: string,
): ReadinessActionEdit {
  const actionId = requestedActionId.trim();
  if (!actionId) throw new Error('An action_id returned by electronics.readiness is required.');

  const check = report.checks.find((candidate) => candidate.automaticAction?.id === actionId);
  if (!check?.automaticAction) {
    if (actionId === OUTLINE_READINESS_ACTION_ID) {
      const outline = report.checks.find((candidate) => candidate.id === 'outline');
      if (!outline) throw new Error('The current readiness report is missing the outline check. Run electronics.readiness again.');
      throw new Error('The outline readiness action is stale or not currently actionable. Run electronics.readiness again and use an advertised action_id.');
    }
    throw new Error(`No current readiness check advertises action "${actionId}".`);
  }
  if (check.id !== 'outline' || actionId !== OUTLINE_READINESS_ACTION_ID) {
    throw new Error(`Readiness action "${actionId}" is not supported.`);
  }

  const { widthMm, heightMm } = check.automaticAction.parameters;
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw new Error('The current outline action does not contain valid inferred dimensions.');
  }
  const result = setBoardSizeInCode(code, { width: `${widthMm}mm`, height: `${heightMm}mm` });
  if (!result.changed) throw new Error('The outline readiness action no longer changes the circuit. Run electronics.readiness again.');
  return {
    code: result.code,
    checkId: 'outline',
    actionId: OUTLINE_READINESS_ACTION_ID,
    dimensions: { widthMm, heightMm },
  };
}
