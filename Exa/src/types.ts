/** Multi-step deep/research modes are intentionally outside this bounded client. */
export type ExaSearchType = 'lite' | 'auto' | 'fast' | 'instant';
export interface ExaContentOptions {
  text?: false | { maxCharacters: number };
  highlights?: false | { maxCharacters: number };
  /** -1 uses cached content only; 0 requests fresh content. Default -1. Not supported by lite. */
  maxAgeHours?: number;
  livecrawlTimeout?: number;
}
export interface ExaSearchRequest {
  query: string;
  type?: ExaSearchType;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  contents?: ExaContentOptions;
}
export interface ExaContentsRequest extends ExaContentOptions { urls: string[] }
export interface ExaCallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ExaClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Explicit transport injection for tests. It receives credentials: supply trusted code only. */
  fetch?: typeof globalThis.fetch;
}
export interface ExaResult {
  url: string;
  id?: string;
  title?: string;
  author?: string;
  publishedDate?: string;
  text?: string;
  highlights?: string[];
}
export interface ExaContentStatus {
  id: string;
  status: string;
  source?: string;
  error?: { tag?: string; httpStatusCode?: number };
}
export interface ExaResponse {
  results: ExaResult[];
  statuses?: ExaContentStatus[];
  requestId?: string;
  costDollars?: { total?: number };
  searchTime?: number;
  resolvedSearchType?: string;
  /** Codes/paths only; provider free-text messages are deliberately omitted. */
  warnings?: { code?: string; path?: string }[];
  notices?: { code?: string; path?: string }[];
}
export interface ExaClient {
  search(request: ExaSearchRequest, options?: ExaCallOptions): Promise<ExaResponse>;
  getContents(request: ExaContentsRequest, options?: ExaCallOptions): Promise<ExaResponse>;
}
