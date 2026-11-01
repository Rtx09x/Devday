import { ExaProtocolError } from './errors.ts';
import type { ExaContentOptions, ExaResponse, ExaResult, ExaContentStatus } from './types.ts';
import { httpURL, object } from './validation.ts';
function invalid(): never { throw new ExaProtocolError('Invalid Exa response.'); }
function str(v: unknown, max: number): string | undefined { return typeof v === 'string' ? v.slice(0, max) : undefined; }
export function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
export function parseResponse(raw: unknown, limit: number, content: ExaContentOptions): ExaResponse {
  if (!object(raw) || !Array.isArray(raw.results) || raw.results.length > limit) invalid();
  const results: ExaResult[] = raw.results.map(value => {
    if (!object(value) || !httpURL(value.url)) invalid();
    const result: ExaResult = { url: value.url };
    for (const field of ['id', 'title', 'author', 'publishedDate'] as const) {
      const v = str(value[field], field === 'publishedDate' ? 128 : 2048);
      if (v !== undefined) result[field] = v;
    }
    if (content.text && value.text !== undefined) {
      if (typeof value.text !== 'string') invalid();
      result.text = value.text.slice(0, content.text.maxCharacters);
    }
    if (content.highlights && value.highlights !== undefined) {
      if (!Array.isArray(value.highlights) || value.highlights.some(x => typeof x !== 'string')) invalid();
      let remaining = content.highlights.maxCharacters;
      result.highlights = [];
      for (const highlight of value.highlights as string[]) {
        if (remaining <= 0) break;
        result.highlights.push(highlight.slice(0, remaining));
        remaining -= highlight.length;
      }
    }
    return result;
  });
  const response: ExaResponse = { results };
  const requestId = safeId(raw.requestId);
  if (requestId) response.requestId = requestId;
  if (typeof raw.searchTime === 'number' && Number.isFinite(raw.searchTime)) response.searchTime = raw.searchTime;
  if (object(raw.costDollars) && typeof raw.costDollars.total === 'number' && Number.isFinite(raw.costDollars.total)) response.costDollars = { total: raw.costDollars.total };
  if (typeof raw.resolvedSearchType === 'string') response.resolvedSearchType = raw.resolvedSearchType.slice(0, 64);
  if (raw.statuses !== undefined) {
    if (!Array.isArray(raw.statuses) || raw.statuses.length > limit) invalid();
    response.statuses = raw.statuses.map(value => {
      if (!object(value) || typeof value.id !== 'string' || typeof value.status !== 'string') invalid();
      const status: ExaContentStatus = { id: value.id.slice(0, 2048), status: value.status.slice(0, 64) };
      if (typeof value.source === 'string') status.source = value.source.slice(0, 64);
      if (object(value.error)) status.error = {
        ...(typeof value.error.tag === 'string' ? { tag: value.error.tag.slice(0, 128) } : {}),
        ...(typeof value.error.httpStatusCode === 'number' ? { httpStatusCode: value.error.httpStatusCode } : {}),
      };
      return status;
    });
  }
  for (const field of ['warnings', 'notices'] as const) {
    if (Array.isArray(raw[field])) response[field] = raw[field].slice(0, 20).filter(object).map(v => ({ code: str(v.code, 128), path: str(v.path, 256) }));
  }
  return response;
}
