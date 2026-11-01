import { fp, getFootprintSizes } from '@tscircuit/footprinter';

export const TSCIRCUIT_FOOTPRINTER_VERSION = '0.0.357' as const;
export const MAX_FOOTPRINT_TOKEN_BYTES = 256;

type JsonPrimitive = string | number | boolean | null;
export type FootprinterJson = JsonPrimitive | FootprinterJson[] | { [key: string]: FootprinterJson };

export interface FootprintExpansionSummary {
  functionName: string;
  imperialSize?: string;
  metricSize?: string;
  pinCount?: number;
  padCount?: number;
}

export type FootprintValidationResult =
  | {
      valid: true;
      canonical: string;
      parameters: { [key: string]: FootprinterJson };
      summary: FootprintExpansionSummary;
    }
  | { valid: false; reason: string };

export const TscircuitFootprinter = fp;

function candidateMethod(candidate: unknown, name: 'string' | 'getFootprintNames'): unknown {
  if ((typeof candidate !== 'function' && typeof candidate !== 'object') || candidate === null) return undefined;
  return (candidate as Record<string, unknown>)[name];
}

export function inspectFootprinterContract(candidate: unknown): { usable: boolean; reason: string } {
  const parse = candidateMethod(candidate, 'string');
  const listNames = candidateMethod(candidate, 'getFootprintNames');
  if (typeof parse !== 'function' || typeof listNames !== 'function') {
    return {
      usable: false,
      reason: 'The pinned footprinter string parser or footprint-name export is missing.',
    };
  }
  try {
    const names = listNames() as unknown;
    if (!Array.isArray(names) || !['res', 'pinrow', 'soic'].every((name) => names.includes(name))) {
      return {
        usable: false,
        reason: 'The pinned footprinter function registry does not expose the required grammar.',
      };
    }
  } catch {
    return {
      usable: false,
      reason: 'The pinned footprinter function registry could not be inspected.',
    };
  }
  return {
    usable: true,
    reason: 'Pinned pure footprint-token parser and deterministic Circuit JSON expansion are available.',
  };
}

function normalizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized || 'The pinned footprinter rejected the token without a reason.';
}

function jsonRecord(value: unknown): { [key: string]: FootprinterJson } {
  const serialized = JSON.stringify(value);
  if (!serialized) throw new Error('The pinned footprinter returned no parsed parameters.');
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The pinned footprinter returned malformed parsed parameters.');
  }
  return parsed as { [key: string]: FootprinterJson };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Validate and expand one literal token against the exact footprinter version
 * used by the installed tscircuit evaluator. This proves grammar/expansion
 * only; it does not prove part matching, sourcing, or manufacturability.
 */
export function validateFootprintToken(token: unknown): FootprintValidationResult {
  try {
    if (typeof token !== 'string') return { valid: false, reason: 'Footprint token must be a string.' };
    if (!token.length) return { valid: false, reason: 'Footprint token must be non-empty.' };
    if (new TextEncoder().encode(token).byteLength > MAX_FOOTPRINT_TOKEN_BYTES) {
      return { valid: false, reason: `Footprint token exceeds ${MAX_FOOTPRINT_TOKEN_BYTES} UTF-8 bytes.` };
    }
    if (/\s/.test(token)) return { valid: false, reason: 'Footprint token must not contain whitespace.' };
    if (/[^A-Za-z0-9._:+/@(),?-]/.test(token)) {
      return { valid: false, reason: 'Footprint token contains characters outside the literal footprinter-token form.' };
    }

    const contract = inspectFootprinterContract(TscircuitFootprinter);
    if (!contract.usable) return { valid: false, reason: contract.reason };

    const builder = TscircuitFootprinter.string(token);
    const rawParameters = builder.params() as Record<string, unknown>;
    const parameters = jsonRecord(builder.json());
    const circuitJson = builder.circuitJson();
    const canonical = typeof rawParameters.string === 'string' && rawParameters.string
      ? rawParameters.string
      : token;
    const functionName = typeof parameters.fn === 'string' ? parameters.fn : '';
    if (!canonical || !functionName) throw new Error('The pinned footprinter did not return a canonical token and function.');

    let imperialSize = typeof parameters.imperial === 'string' ? parameters.imperial : undefined;
    let metricSize = typeof parameters.metric === 'string' ? parameters.metric : undefined;
    if (imperialSize || metricSize) {
      const size = getFootprintSizes().find((candidate) => (
        (imperialSize && candidate.imperial === imperialSize)
        || (metricSize && candidate.metric === metricSize)
      ));
      imperialSize ??= size?.imperial;
      metricSize ??= size?.metric;
    }

    const padCount = circuitJson.filter((element) => (
      element.type === 'pcb_smtpad' || element.type === 'pcb_plated_hole'
    )).length;
    const pinCount = positiveInteger(parameters.num_pins);
    return {
      valid: true,
      canonical,
      parameters,
      summary: {
        functionName,
        ...(imperialSize ? { imperialSize } : {}),
        ...(metricSize ? { metricSize } : {}),
        ...(pinCount ? { pinCount } : {}),
        ...(padCount ? { padCount } : {}),
      },
    };
  } catch (error) {
    return { valid: false, reason: normalizedError(error) };
  }
}

export function formatFootprintExpansion(result: Extract<FootprintValidationResult, { valid: true }>): string {
  const facts = [result.summary.functionName];
  if (result.summary.imperialSize && result.summary.metricSize) {
    facts.push(`imperial ${result.summary.imperialSize} / metric ${result.summary.metricSize}`);
  } else if (result.summary.imperialSize) {
    facts.push(`imperial ${result.summary.imperialSize}`);
  } else if (result.summary.metricSize) {
    facts.push(`metric ${result.summary.metricSize}`);
  }
  if (result.summary.pinCount) facts.push(`${result.summary.pinCount} pin(s)`);
  if (result.summary.padCount) facts.push(`${result.summary.padCount} pad(s)`);
  return `\"${result.canonical}\" (${facts.join(', ')})`;
}
