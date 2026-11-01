import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import {
  createCerebrasClient, createCerebrasClientFromEnv, imageFromBytes, collectStream,
  parseToolArguments, assistantHistory, validateStrictSchema, QWEN_MODEL,
  CerebrasAPIError, CerebrasValidationError, CerebrasProtocolError, CerebrasTimeoutError, CerebrasTransportError,
} from '../src/index.ts';
import type { ChatChunk, ChatCompletion, ChatRequest, ClientOptions, FunctionTool, JsonSchema } from '../src/index.ts';

const key = 'offline-test-key';
const prompt: ChatRequest = { messages: [{ role: 'user', content: 'Hello' }], max_completion_tokens: 128, reasoning_effort: 'none' };
const schema: JsonSchema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false };
const tool: FunctionTool = { type: 'function', function: { name: 'status', parameters: schema, strict: true } };
const result: ChatCompletion = { id: 'test', object: 'chat.completion', created: 0, model: QWEN_MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok', reasoning: 'reason' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { image_tokens: 1, cached_tokens: 1 } } };
const respond = (value: unknown = result) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const mock = (fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch => async (url, init) => fn(String(url), init ?? {});
const client = (fetcher: typeof fetch, options: Partial<ClientOptions> = {}) => createCerebrasClient({ apiKey: key, fetch: fetcher, ...options });
const chunk = (delta: ChatChunk['choices'][number]['delta'], finish_reason: string | null = null): ChatChunk => ({ id: 'stream', object: 'chat.completion.chunk', created: 0, model: QWEN_MODEL, choices: [{ index: 0, delta, finish_reason }] });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function sse(text: string, bytewise = false, cancel?: () => void) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  }, cancel }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('text completion sends exact model, auth and version; returns usage and reasoning', async () => {
  const service = client(mock((url, init) => {
    assert.equal(url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    assert.equal((init.headers as Record<string, string>)['X-Cerebras-Version-Patch'], '2');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { ...prompt, model: QWEN_MODEL, stream: false });
    return respond();
  }));
  assert.deepEqual(await service.complete(prompt), result);
  assert.equal((await service.generateText('Hello', { max_completion_tokens: 128, reasoning_effort: 'none' })).usage?.total_tokens, 3);
});

test('environment injection is explicit, missing keys fail before network, clients are isolated', async () => {
  assert.throws(() => createCerebrasClientFromEnv({}), CerebrasValidationError);
  assert.throws(() => createCerebrasClient({ apiKey: '\nsecret' }), CerebrasValidationError);
  const seen: string[] = [];
  const fetcher = mock((_url, init) => { seen.push((init.headers as Record<string, string>).Authorization!); return respond(); });
  await createCerebrasClientFromEnv({ CEREBRAS_API_KEY: 'first' }, { fetch: fetcher }).complete(prompt);
  await client(fetcher).complete(prompt);
  assert.deepEqual(seen, ['Bearer first', `Bearer ${key}`]);
});

test('untrusted redirect and endpoint configuration cannot change credential destination', () => {
  for (const baseURL of ['http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?x=1', 'https://example.com/v1#x', 'https://example.com/other']) assert.throws(() => createCerebrasClient({ apiKey: key, baseURL }), CerebrasValidationError);
});

test('sampling, logprobs, reasoning modes and prompt cache parameters pass through', async () => {
  const parameters: ChatRequest = { ...prompt, temperature: 0.7, top_p: 0.95, seed: 3, stop: ['END'], frequency_penalty: 0.2, presence_penalty: -0.2, logit_bias: { '42': -100 }, logprobs: true, top_logprobs: 3, reasoning_effort: 'high', reasoning_format: 'raw', clear_thinking: true, prompt_cache_key: 'workflow-1', min_completion_tokens: 0, n: 1 };
  await client(mock((_url, init) => { assert.deepEqual(JSON.parse(String(init.body)), { ...parameters, model: QWEN_MODEL, stream: false }); return respond(); })).complete(parameters);
});

test('supported PNG/JPEG bytes are encoded without filesystem or URL access', async () => {
  const png = imageFromBytes(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png');
  const jpeg = imageFromBytes(Uint8Array.from([255, 216, 255, 224]), 'image/jpeg');
  await client(mock((_url, init) => {
    const body = JSON.parse(String(init.body)); assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Compare' }, png, jpeg]); return respond();
  })).complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Compare' }, png, jpeg] }] });
  assert.throws(() => imageFromBytes(Uint8Array.of(0), 'image/png'), CerebrasValidationError);
  assert.throws(() => imageFromBytes(new Uint8Array(), 'image/jpeg'), CerebrasValidationError);
});

test('trial/paid image counts and token limits require explicit capacity selection', async () => {
  const image = imageFromBytes(Uint8Array.from([255, 216, 255]), 'image/jpeg');
  const request: ChatRequest = { messages: [{ role: 'user', content: [image, image, image] }], max_completion_tokens: 40_960 };
  const service = client(mock(() => respond()));
  await assert.rejects(service.complete(request), CerebrasValidationError);
  await assert.rejects(service.complete({ ...prompt, max_completion_tokens: 32_769 }), CerebrasValidationError);
  await client(mock(() => respond()), { capacity: 'paid' }).complete(request);
  await assert.rejects(client(mock(() => respond()), { capacity: 'paid' }).complete({ ...prompt, max_completion_tokens: 40_961 }), CerebrasValidationError);
});

test('remote images, images in tool messages, unsupported model controls and oversized payloads fail before fetch', async () => {
  let calls = 0; const service = client(mock(() => { calls++; return respond(); }));
  const invalid: unknown[] = [
    { ...prompt, model: 'qwen-3-32b' }, { ...prompt, reasoning_format: 'hidden' }, { ...prompt, reasoning_effort: 'max' },
    { ...prompt, enable_thinking: true }, { ...prompt, prediction: { type: 'content', content: 'x' } }, { ...prompt, service_tier: 'priority' },
    { ...prompt, max_tokens: 1 }, { ...prompt, temperature: NaN }, { ...prompt, n: 2 }, { ...prompt, stop: ['1', '2', '3', '4', '5'] },
    { ...prompt, top_logprobs: 1 }, { ...prompt, prompt_cache_key: 'x'.repeat(1025) },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] },
    { messages: [{ role: 'user', content: 'x'.repeat(10 * 1024 * 1024) }] },
  ];
  for (const request of invalid) await assert.rejects(service.complete(request as ChatRequest), CerebrasValidationError);
  assert.equal(calls, 0);
});

test('tool definitions, parallel choice and full assistant/tool history are caller owned', async () => {
  const message = { role: 'assistant' as const, content: null, reasoning: 'context', tool_calls: [{ id: 'call1', type: 'function' as const, function: { name: 'status', arguments: '{"ready":true}' } }] };
  const history = assistantHistory(message);
  assert.deepEqual(history, message); assert.notEqual(history.tool_calls, message.tool_calls);
  const request: ChatRequest = { messages: [...prompt.messages, history, { role: 'tool', tool_call_id: 'call1', content: '{"ready":true}' }], tools: [tool], tool_choice: { type: 'function', function: { name: 'status' } }, parallel_tool_calls: true, response_format: { type: 'text' } };
  await client(mock((_url, init) => { assert.deepEqual(JSON.parse(String(init.body)).messages, request.messages); return respond(); })).complete(request);
  const parsed = parseToolArguments(message.tool_calls[0]!, value => { assert.deepEqual(value, { ready: true }); return value; });
  assert.deepEqual(parsed, { ready: true });
  assert.throws(() => parseToolArguments({ ...message.tool_calls[0]!, function: { name: 'status', arguments: 'invalid' } }, x => x), CerebrasProtocolError);
});

test('incomplete, orphan, duplicate and image tool results fail before fetch', async () => {
  const call = { id: 'c', type: 'function' as const, function: { name: 'status', arguments: '{}' } };
  const assistant = { role: 'assistant' as const, tool_calls: [call] };
  const cases: unknown[] = [
    { ...prompt, tool_choice: 'auto' },
    { ...prompt, tools: [tool], tool_choice: { type: 'function', function: { name: 'missing' } } },
    { messages: [assistant] }, { messages: [{ role: 'tool', tool_call_id: 'c', content: 'x' }] },
    { messages: [assistant, { role: 'user', content: 'x' }] },
    { messages: [{ ...assistant, tool_calls: [call, call] }] },
    { messages: [assistant, { role: 'tool', tool_call_id: 'c', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } }] }] },
  ];
  for (const request of cases) await assert.rejects(client(mock(() => respond())).complete(request as ChatRequest), CerebrasValidationError);
});

test('strict schema checks support optional fields, local definitions, tuples and nested unions', () => {
  validateStrictSchema({ ...schema, required: [], properties: { nested: { anyOf: [{ $ref: '#/$defs/item' }, { type: 'null' }] }, tuple: { type: 'array', prefixItems: [{ type: 'string' }], items: false } }, $defs: { item: schema } });
  for (const value of [{ ...schema, additionalProperties: true }, { type: 'array', items: schema }, { ...schema, properties: { v: { type: 'string', minLength: 1 } } }, { ...schema, properties: { v: { $ref: 'https://example.com/schema' } } }, { ...schema, properties: { v: { type: 'array', items: true } } }]) assert.throws(() => validateStrictSchema(value), CerebrasValidationError);
});

test('structured JSON keeps completion metadata and uses caller validation instead of a generic cast', async () => {
  const request: ChatRequest = { ...prompt, response_format: { type: 'json_schema', json_schema: { name: 'ready', schema, strict: true } } };
  const completion = { ...result, choices: [{ ...result.choices[0]!, message: { role: 'assistant', content: '{"ready":true}' } }] };
  const service = client(mock((_url, init) => { assert.deepEqual(JSON.parse(String(init.body)).response_format, request.response_format); return respond(completion); }));
  const parsed = await service.generateJson(request, value => { if (!value || typeof value !== 'object' || !('ready' in value) || typeof value.ready !== 'boolean') throw new Error('invalid'); return value.ready; });
  assert.equal(parsed.data, true); assert.deepEqual(parsed.completion.usage, result.usage);
  await assert.rejects(service.complete({ ...request, tools: [tool] }), CerebrasValidationError);
  await assert.rejects(async () => { for await (const _ of service.stream({ ...prompt, response_format: { type: 'json_object' } })) {} }, CerebrasValidationError);
  await assert.rejects(client(mock(() => respond({ ...completion, choices: [{ ...completion.choices[0], finish_reason: 'length' }] }))).generateJson(request, x => x), CerebrasProtocolError);
});

test('SSE splits UTF-8, CRLF, comments, multiline data and sentinel across byte boundaries', async () => {
  const payload = JSON.stringify(chunk({ content: 'Hello 🌍', reasoning: 'Think' }, 'stop')).replace(',"object"', ',\n"object"');
  const text = `: ping\r\nevent: message\r\ndata: ${payload.split('\n').join('\r\ndata: ')}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const completed = await collectStream(client(mock(() => sse(text, true))).stream(prompt));
  assert.equal(completed.choices[0]?.message.content, 'Hello 🌍');
  assert.equal(completed.choices[0]?.message.reasoning, 'Think');
  assert.equal(completed.choices[0]?.finish_reason, 'stop');
});

test('stream collector assembles interleaved multi-index tool fragments with final usage', async () => {
  const chunks = [
    chunk({ tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'second', arguments: '{"b":' } }, { index: 0, id: 'c1', type: 'function', function: { name: 'first', arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }, 'tool_calls'),
    { ...chunk({}), choices: [], usage: result.usage },
  ];
  const completed = await collectStream(client(mock(() => sse(chunks.map(event).join('') + 'data: [DONE]\n\n'))).stream({ ...prompt, tools: [tool] }));
  assert.deepEqual(completed.choices[0]?.message.tool_calls?.map(call => [call.id, call.function.arguments]), [['c1', '{"a":1}'], ['c2', '{"b":2}']]);
  assert.deepEqual(completed.usage, result.usage);
});

test('JSON schema streaming is accepted and complete events in large network chunks remain valid', async () => {
  const text = event(chunk({ content: 'x'.repeat(30_000) })).repeat(75) + event(chunk({}, 'stop')) + 'data: [DONE]\n\n';
  let count = 0;
  for await (const _ of client(mock(() => sse(text))).stream({ ...prompt, response_format: { type: 'json_schema', json_schema: { name: 'ready', schema, strict: true } } })) count++;
  assert.equal(count, 76);
});

test('SSE protocol errors and truncated streams fail without retry or partial success', async () => {
  for (const text of ['data: invalid\n\n', 'event: error\ndata: {"message":"secret"}\n\n', 'data: {"error":{"message":"secret"}}\n\n', event(chunk({ content: 'partial' })), 'data: ' + 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    let calls = 0;
    await assert.rejects(async () => { for await (const _ of client(mock(() => { calls++; return sse(text); }), { maxRetries: 2 }).stream(prompt)) {} }, CerebrasProtocolError);
    assert.equal(calls, 1);
  }
  await assert.rejects(async () => { for await (const _ of client(mock(() => respond())).stream(prompt)) {} }, CerebrasProtocolError);
});

test('breaking streaming iteration cancels the reader and aborts only the owned request', async () => {
  let cancelled = false, signal: AbortSignal | undefined;
  const caller = new AbortController();
  const service = client(mock((_url, init) => {
    signal = init.signal!;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event(chunk({ content: 'one' })))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  }));
  for await (const _ of service.stream(prompt, { signal: caller.signal })) break;
  assert.equal(cancelled, true); assert.equal(signal?.aborted, true); assert.equal(caller.signal.aborted, false);
});

test('caller aborts and total deadlines cancel stalled stream and JSON body reads', async () => {
  for (const stream of [true, false]) {
    let cancelled = false;
    const service = client(mock(() => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } })));
    const pending = stream ? collectStream(service.stream(prompt, { timeoutMs: 15 })) : service.complete(prompt, { timeoutMs: 15 });
    // Keep event loop alive while the client's unref'ed deadline runs.
    await Promise.all([assert.rejects(pending, CerebrasTimeoutError), pause(30)]);
    assert.equal(cancelled, true);
  }
  const caller = new AbortController();
  caller.abort(new Error(key));
  await assert.rejects(client(mock(() => { throw new Error('must not run'); })).complete(prompt, { signal: caller.signal }), error => error instanceof Error && error.name === 'AbortError' && !String(error).includes(key));
});

test('HTTP errors are sanitized, auth errors never retry, opt-in throttling retries preserve deadline', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const service = client(mock(() => { calls++; return new Response(JSON.stringify({ error: { message: key } }), { status, headers: { 'x-request-id': 'req-1' } }); }), { maxRetries: 2 });
    await assert.rejects(service.complete(prompt), error => error instanceof CerebrasAPIError && error.status === status && error.requestId === 'req-1' && !JSON.stringify(error).includes(key));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const service = client(mock(() => ++calls === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': '0' } }) : respond()), { maxRetries: 1 });
  await service.complete(prompt); assert.equal(calls, 2);
  await assert.rejects(client(mock(() => { throw new Error(key); }), { maxRetries: 2 }).complete(prompt), error => error instanceof CerebrasTransportError && !String(error).includes(key));
  const waiting = client(mock(() => new Response('limited', { status: 429, headers: { 'retry-after': '3600' } })), { maxRetries: 1 }).complete(prompt, { timeoutMs: 15 });
  await Promise.all([assert.rejects(waiting, CerebrasTimeoutError), pause(30)]);
});

test('models metadata functions are explicit authenticated read calls', async () => {
  const service = client(mock((url, init) => {
    assert.equal(init.method, 'GET');
    const model = { id: QWEN_MODEL, object: 'model', created: 0, owned_by: 'Cerebras' };
    return respond(url.endsWith('/models') ? { object: 'list', data: [model] } : model);
  }));
  assert.equal((await service.listModels()).data[0]?.id, QWEN_MODEL);
  assert.equal((await service.retrieveModel()).id, QWEN_MODEL);
});
