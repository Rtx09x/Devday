import type { AnyCircuitElement } from '../circuit/circuitJson';

export const TSCIRCUIT_CHECKS_VERSION = '0.0.138' as const;
export const MAX_UPSTREAM_CHECK_DIAGNOSTICS = 500;

export interface UpstreamCheckDiagnostic {
  type: string;
  message: string;
  element: AnyCircuitElement;
}

export function normalizeUpstreamCheckDiagnostics(value: unknown): UpstreamCheckDiagnostic[] {
  if (!Array.isArray(value)) throw new Error('The upstream check worker returned a non-array result.');
  if (value.length > MAX_UPSTREAM_CHECK_DIAGNOSTICS) {
    throw new Error(`The upstream check worker exceeded ${MAX_UPSTREAM_CHECK_DIAGNOSTICS} diagnostics.`);
  }
  return value.map((element, index) => {
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      throw new Error(`Upstream check diagnostic ${index + 1} is not a Circuit JSON object.`);
    }
    const record = element as AnyCircuitElement;
    if (typeof record.type !== 'string' || typeof record.message !== 'string') {
      throw new Error(`Upstream check diagnostic ${index + 1} has no type/message contract.`);
    }
    return { type: record.type, message: record.message, element: record };
  });
}

