import { ExaAPIError, ExaProtocolError, ExaTimeoutError, ExaTransportError } from './errors.ts';
import { parseResponse, safeId } from './response.ts';
import { contentsRequest, fail, integer, keys, searchRequest } from './validation.ts';
import type { ExaCallOptions, ExaClient, ExaClientOptions, ExaContentOptions, ExaResponse } from './types.ts';

const API = 'https://api.exa.ai';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export function createExaClient(config: ExaClientOptions): ExaClient {
  keys(config, ['apiKey', 'fetch', 'timeoutMs']);
  if (typeof window !== 'undefined') fail('Exa client requires a backend runtime.');
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || /\s/.test(config.apiKey) || config.apiKey.length > 4096) fail('A backend EXA_API_KEY is required.');
  const apiKey = config.apiKey;
  const transport = config.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') fail('A fetch implementation is required.');
  const defaultTimeout = config.timeoutMs ?? 20000;
  integer(defaultTimeout, 1, 120000, 'timeoutMs');

  async function post(path: string, body: unknown, limit: number, content: ExaContentOptions, options: ExaCallOptions = {}): Promise<ExaResponse> {
    keys(options, ['signal', 'timeoutMs']);
    const timeoutMs = options.timeoutMs ?? defaultTimeout;
    integer(timeoutMs, 1, 120000, 'timeoutMs');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('signal must be an AbortSignal.');
    if (options.signal?.aborted) throw new DOMException('Exa request cancelled.', 'AbortError');
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let rejectStop!: (reason: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const cancel = () => {
      controller.abort();
      rejectStop(new DOMException('Exa request cancelled.', 'AbortError'));
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectStop(new ExaTimeoutError('Exa request timed out.'));
    }, timeoutMs);
    async function run() {
      const response = await transport(`${API}${path}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const requestId = safeId(response.headers.get('x-request-id'));
        throw new ExaAPIError(response.status, requestId?.includes(apiKey) ? undefined : requestId);
      }
      if (!response.body) throw new ExaProtocolError('Empty Exa response.');
      const reader = response.body.getReader();
      activeReader = reader;
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new ExaProtocolError('Exa response exceeds size limit.');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); activeReader = undefined; }
      const all = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
      catch { throw new ExaProtocolError('Invalid Exa JSON response.'); }
      return parseResponse(raw, limit, content);
    }
    try { return await Promise.race([run(), stopped]); }
    catch (error) {
      if (timedOut) throw new ExaTimeoutError('Exa request timed out.');
      if (options.signal?.aborted) throw new DOMException('Exa request cancelled.', 'AbortError');
      if (error instanceof ExaAPIError || error instanceof ExaProtocolError) throw error;
      throw new ExaTransportError('Exa transport failed.');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
      void activeReader?.cancel().catch(() => {});
    }
  }
  return {
    async search(input, options) {
      const request = searchRequest(input);
      return post('/search', request, request.numResults, request.contents, options);
    },
    async getContents(input, options) {
      const request = contentsRequest(input);
      return post('/contents', request, request.urls.length, request, options);
    },
  };
}
export function createExaClientFromEnv(env: Record<string, string | undefined>, options: Omit<ExaClientOptions, 'apiKey'> = {}): ExaClient {
  keys(options, ['fetch', 'timeoutMs']);
  return createExaClient({ ...options, apiKey: env.EXA_API_KEY ?? '' });
}
