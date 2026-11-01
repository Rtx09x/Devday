import { ExaValidationError } from './errors.ts';
import type { ExaContentOptions, ExaContentsRequest, ExaSearchRequest } from './types.ts';
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function fail(message: string): never { throw new ExaValidationError(message); }
export function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('Unsupported request shape or field.');
}
export function integer(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}.`);
}
export function httpURL(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
const contentKeys = ['text', 'highlights', 'maxAgeHours', 'livecrawlTimeout'];
export function content(input: ExaContentOptions = {}, lite = false): ExaContentOptions {
  keys(input, contentKeys);
  for (const field of ['text', 'highlights'] as const) {
    const value = input[field];
    if (value !== undefined && value !== false) {
      keys(value, ['maxCharacters']);
      integer(value.maxCharacters, 1, field === 'text' ? 20000 : 4000, `${field}.maxCharacters`);
    }
  }
  if (input.maxAgeHours !== undefined) integer(input.maxAgeHours, -1, 720, 'maxAgeHours');
  if (input.livecrawlTimeout !== undefined) integer(input.livecrawlTimeout, 1, 90000, 'livecrawlTimeout');
  if (lite && (input.maxAgeHours !== undefined || input.livecrawlTimeout !== undefined)) fail('lite does not support live-fetch controls.');
  return {
    text: (input.text ?? false) as ExaContentOptions["text"],
    highlights: (input.highlights ?? { maxCharacters: 2000 }) as ExaContentOptions["highlights"],
    ...(!lite ? { maxAgeHours: input.maxAgeHours ?? -1 } : {}),
    ...(input.livecrawlTimeout !== undefined ? { livecrawlTimeout: input.livecrawlTimeout } : {}),
  };
}
export function searchRequest(input: ExaSearchRequest) {
  keys(input, ['query', 'type', 'numResults', 'includeDomains', 'excludeDomains', 'contents']);
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 4096) fail('query must contain 1–4096 characters.');
  const type = input.type ?? 'lite';
  if (!['lite', 'auto', 'fast', 'instant'].includes(type)) fail('Unsupported search type.');
  const numResults = input.numResults ?? 3;
  integer(numResults, 1, 10, 'numResults');
  for (const name of ['includeDomains', 'excludeDomains'] as const) {
    const list = input[name];
    if (list !== undefined && (!Array.isArray(list) || list.length > 100 || list.some(d => {
      if (typeof d !== 'string' || !d || d.length > 2048 || /[\s?#@\\]/.test(d) || d.includes('://')) return true;
      return !httpURL(`https://${d.replace(/^\*\./, '')}`);
    }))) fail('Domain filters must contain at most 100 hostnames, wildcard subdomains, or domain paths.');
  }
  return { ...input, type, numResults, contents: content(input.contents, type === 'lite') };
}
export function contentsRequest(input: ExaContentsRequest) {
  keys(input, ['urls', ...contentKeys]);
  if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 10 || !input.urls.every(httpURL)) fail('urls must contain 1–10 HTTP(S) URLs without credentials.');
  const { urls, ...options } = input;
  return { urls: [...urls], ...content(options) };
}

