import { setTimeout as delay } from 'node:timers/promises';
import { CerebrasAPIError, CerebrasProtocolError, CerebrasTimeoutError, CerebrasTransportError, CerebrasValidationError } from './errors.ts';
import { QWEN_MODEL } from './model.ts';
import { decodeSSE } from './sse.ts';
import { prepareRequest } from './validation.ts';
import type { CerebrasClient, ChatCompletion, ChatRequest, ClientOptions, ModelInfo, ModelList, RequestOptions } from './types.ts';

function deadline(timeoutMs: number, caller?: AbortSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new CerebrasValidationError('timeoutMs must be positive and at most 2147483647.');
  const controller = new AbortController();
  // Never propagate caller-supplied abort reasons, which can contain secrets.
  const abort = () => controller.abort(new DOMException('Cerebras request aborted.', 'AbortError'));
  if (caller?.aborted) abort();
  else caller?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new CerebrasTimeoutError()), timeoutMs);
  timer.unref();
  return { controller, close() { clearTimeout(timer); caller?.removeEventListener('abort', abort); controller.abort(); } };
}

/** A lightweight factory with no global singleton, connections, tool execution or implicit env loading. */
export function createCerebrasClient(options: ClientOptions): CerebrasClient {
  if (typeof window !== 'undefined') throw new CerebrasValidationError('Cerebras keys and clients belong in the backend.');
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new CerebrasValidationError('A nonempty server-side Cerebras API key is required.');
  const apiKey = options.apiKey;
  let base: URL;
  try { base = new URL(options.baseURL ?? 'https://api.cerebras.ai/v1'); }
  catch { throw new CerebrasValidationError('baseURL must be a valid HTTPS /v1 endpoint.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.replace(/\/$/, '').endsWith('/v1')) throw new CerebrasValidationError('baseURL must be an HTTPS /v1 endpoint without userinfo, query or fragment.');
  const baseURL = base.href.replace(/\/$/, '');
  const fetcher = options.fetch ?? globalThis.fetch;
  const capacity = options.capacity ?? 'free-trial';
  if (!['free-trial', 'paid'].includes(capacity)) throw new CerebrasValidationError('Unknown capacity.');
  const retries = options.maxRetries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new CerebrasValidationError('maxRetries must be an integer from 0 to 5.');
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Validate deadline without allocating resources until an operation begins.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new CerebrasValidationError('Invalid timeoutMs.');

  async function send(path: string, body: string | undefined, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetcher(`${baseURL}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Cerebras-Version-Patch': '2' },
          body, signal, redirect: 'error',
        });
      } catch {
        signal.throwIfAborted();
        // Do not retain fetch errors: third-party fetchers can echo authorization or payloads.
        throw new CerebrasTransportError();
      }
      if (response.ok) return response;
      const retryAfter = response.headers.get('retry-after');
      const rawId = response.headers.get('x-request-id');
      const requestId = rawId && !rawId.includes(apiKey) && /^[\w.-]{1,200}$/.test(rawId) ? rawId : undefined;
      await response.body?.cancel().catch(() => {});
      if (attempt >= retries || ![408, 409, 429, 500, 502, 503, 504].includes(response.status)) throw new CerebrasAPIError(response.status, requestId);
      let waitMs = 250 * 2 ** attempt;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        waitMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (!Number.isFinite(waitMs)) waitMs = 250 * 2 ** attempt;
      }
      // Do not retry before the server's requested delay. The total deadline bounds long waits.
      try { await delay(Math.max(0, Math.min(waitMs, 2_147_483_647)), undefined, { signal }); }
      catch { signal.throwIfAborted(); throw new CerebrasTransportError(); }
    }
  }

  async function json<T>(path: string, body: string | undefined, requestOptions?: RequestOptions): Promise<T> {
    const context = deadline(requestOptions?.timeoutMs ?? timeoutMs, requestOptions?.signal);
    const signal = context.controller.signal;
    try {
      const response = await send(path, body, signal);
      let value: unknown;
      if (!response.body) throw new CerebrasProtocolError('Missing Cerebras response body.');
      const reader = response.body.getReader();
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        let text = '', bytes = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          signal.throwIfAborted();
          bytes += part.value?.byteLength ?? 0;
          if (bytes > 32 * 1024 * 1024) throw new CerebrasProtocolError('Cerebras response exceeds the 32 MiB client safety limit.');
          text += decoder.decode(part.value, { stream: !part.done });
          if (part.done) break;
        }
        value = JSON.parse(text);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CerebrasProtocolError) throw error;
        throw new CerebrasProtocolError('Invalid JSON in Cerebras response.');
      } finally {
        signal.removeEventListener('abort', abort);
        try { await reader.cancel(); } catch { /* Preserve the original error. */ }
        reader.releaseLock();
      }
      signal.throwIfAborted();
      if (!value || typeof value !== 'object' || 'error' in value) throw new CerebrasProtocolError('Invalid Cerebras response object.');
      return value as T;
    } catch (error) { signal.throwIfAborted(); throw error; }
    finally { context.close(); }
  }

  const client: CerebrasClient = {
    async complete(request, requestOptions) {
      const completion = await json<ChatCompletion>('/chat/completions', prepareRequest(request, false, capacity), requestOptions);
      if (completion.object !== 'chat.completion' || !Array.isArray(completion.choices) || !completion.choices.length || completion.choices.some(choice => choice.message?.role !== 'assistant')) throw new CerebrasProtocolError('Invalid Cerebras completion.');
      return completion;
    },
    async *stream(request, requestOptions) {
      const body = prepareRequest(request, true, capacity);
      const context = deadline(requestOptions?.timeoutMs ?? timeoutMs, requestOptions?.signal);
      const signal = context.controller.signal;
      try {
        const response = await send('/chat/completions', body, signal);
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new CerebrasProtocolError('Expected a Cerebras text/event-stream response body.');
        }
        yield* decodeSSE(response.body, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CerebrasAPIError || error instanceof CerebrasProtocolError || error instanceof CerebrasTransportError) throw error;
        throw new CerebrasTransportError();
      } finally { context.close(); }
    },
    generateText(prompt, parameters, requestOptions) {
      return client.complete({ ...parameters, messages: [{ role: 'user', content: prompt }] }, requestOptions);
    },
    async generateJson<T>(request: ChatRequest, validate: (value: unknown) => T, requestOptions?: RequestOptions) {
      if (!request.response_format || request.response_format.type === 'text') throw new CerebrasValidationError('generateJson requires json_object or json_schema response_format.');
      const completion = await client.complete(request, requestOptions);
      const choice = completion.choices[0]!;
      if (choice.finish_reason !== 'stop' || typeof choice.message.content !== 'string') throw new CerebrasProtocolError('JSON completion is incomplete or contains a tool call.');
      let value: unknown;
      try { value = JSON.parse(choice.message.content); } catch { throw new CerebrasProtocolError('Completion did not contain valid JSON.'); }
      // Caller-supplied validation gives runtime type safety without a forced validation dependency.
      return { data: validate(value), completion };
    },
    async listModels(requestOptions) {
      const result = await json<ModelList>('/models', undefined, requestOptions);
      if (!Array.isArray(result.data)) throw new CerebrasProtocolError('Invalid model list.');
      return result;
    },
    async retrieveModel(requestOptions) {
      const result = await json<ModelInfo>(`/models/${QWEN_MODEL}`, undefined, requestOptions);
      if (result.id !== QWEN_MODEL) throw new CerebrasProtocolError('Unexpected model metadata.');
      return result;
    },
  };
  return Object.freeze(client);
}

/** Environment is explicit and injectable, with no dotenv or implicit filesystem access. */
export function createCerebrasClientFromEnv(env: Record<string, string | undefined> = process.env, options: Omit<ClientOptions, 'apiKey'> = {}): CerebrasClient {
  return createCerebrasClient({ ...options, apiKey: env.CEREBRAS_API_KEY ?? '' });
}
