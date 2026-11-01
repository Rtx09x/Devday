import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExaClient, createExaClientFromEnv, ExaAPIError, ExaProtocolError,
  ExaTimeoutError, ExaTransportError, ExaValidationError,
} from '../src/index.ts';
import type { ExaSearchRequest } from '../src/index.ts';
const apiKey = 'test-key-never-live';
function client(fetch: typeof globalThis.fetch) { return createExaClient({ apiKey, fetch }); }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
test('search sends exact trusted origin/auth, bounds defaults and strips unrelated payloads', async () => {
  let calls = 0;
  const exa = client(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.exa.ai/search');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('x-api-key'), apiKey);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query: 'op amp datasheet', type: 'lite', numResults: 3,
      includeDomains: ['ti.com/docs', '*.analog.com'],
      contents: { text: false, highlights: { maxCharacters: 2000 } },
    });
    return json({ results: [{ url: 'https://ti.com/source', title: 'Source', text: 'omit', highlights: ['x'.repeat(2500)], summary: 'omit' }], costDollars: { total: 0.004 }, requestId: 'req_1', notices: [{ code: 'RESTRICTIONS_RELAXED', message: 'omit' }] });
  });
  const result = await exa.search({ query: 'op amp datasheet', includeDomains: ['ti.com/docs', '*.analog.com'] });
  assert.equal(calls, 1);
  assert.equal(result.results[0]?.highlights?.[0]?.length, 2000);
  assert.equal(result.results[0]?.text, undefined);
  assert.deepEqual(result.costDollars, { total: 0.004 });
  assert.deepEqual(result.notices, [{ code: 'RESTRICTIONS_RELAXED', path: undefined }]);
});
test('contents preserves partial per-URL failures and explicitly enables fresh text only on request', async () => {
  const exa = client(async (url, init) => {
    assert.equal(url, 'https://api.exa.ai/contents');
    assert.deepEqual(JSON.parse(String(init?.body)), { urls: ['https://example.com/a', 'https://example.com/b'], text: { maxCharacters: 5 }, highlights: false, maxAgeHours: 0, livecrawlTimeout: 1000 });
    return json({ results: [{ url: 'https://example.com/a', text: '123456789' }], statuses: [
      { id: 'https://example.com/a', status: 'success', source: 'live' },
      { id: 'https://example.com/b', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404, message: 'omit' } },
    ] });
  });
  const result = await exa.getContents({ urls: ['https://example.com/a', 'https://example.com/b'], text: { maxCharacters: 5 }, highlights: false, maxAgeHours: 0, livecrawlTimeout: 1000 });
  assert.equal(result.results[0]?.text, '12345');
  assert.equal(result.statuses?.[1]?.error?.httpStatusCode, 404);
});
test('contents defaults to cache-only, bounded highlights, zero text', async () => {
  await client(async (_, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { urls: ['https://example.com'], text: false, highlights: { maxCharacters: 2000 }, maxAgeHours: -1 });
    return json({ results: [], statuses: [{ id: 'https://example.com', status: 'error' }] });
  }).getContents({ urls: ['https://example.com'] });
});
test('HTTP errors and transport causes do not expose response bodies, key or prompts; no retry', async () => {
  let calls = 0;
  const exa = client(async () => { calls++; return new Response(`${apiKey} sensitive query`, { status: 429, headers: { 'x-request-id': 'safe-id' } }); });
  await assert.rejects(exa.search({ query: 'sensitive query' }), error => {
    assert.ok(error instanceof ExaAPIError);
    assert.equal(error.status, 429);
    assert.equal(error.requestId, 'safe-id');
    assert.ok(!JSON.stringify(error).includes(apiKey));
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(client(async () => { throw new Error(apiKey); }).search({ query: 'test' }), ExaTransportError);
});
test('timeout and cancellation work even for a noncooperating mock fetch', async () => {
  const exa = client(() => new Promise(() => {}));
  await assert.rejects(exa.search({ query: 'test' }, { timeoutMs: 5 }), ExaTimeoutError);
  const controller = new AbortController();
  const pending = exa.search({ query: 'test' }, { signal: controller.signal });
  controller.abort(new Error('secret reason'));
  await assert.rejects(pending, { name: 'AbortError', message: 'Exa request cancelled.' });
  await assert.rejects(exa.search({ query: 'test' }, { signal: controller.signal }), { name: 'AbortError' });
});
test('deadline includes response body consumption', async () => {
  let cancelled = false;
  const exa = client(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await assert.rejects(exa.search({ query: 'test' }, { timeoutMs: 5 }), ExaTimeoutError);
  assert.equal(cancelled, true);
});
test('invalid requests never reach transport', async () => {
  let calls = 0;
  const exa = client(async () => { calls++; return json({ results: [] }); });
  const invalid = [
    { query: '' }, { query: 'ok', numResults: 11 }, { query: 'ok', type: 'deep' },
    { query: 'ok', arbitrary: true }, { query: 'ok', contents: { text: true } },
    { query: 'ok', contents: { highlights: { maxCharacters: 4001 } } },
    { query: 'ok', contents: { maxAgeHours: -1 } },
    { query: 'ok', includeDomains: ['https://example.com'] },
  ];
  for (const request of invalid) await assert.rejects(exa.search(request as ExaSearchRequest), ExaValidationError);
  await assert.rejects(exa.getContents({ urls: ['file:///secret'] }), ExaValidationError);
  await assert.rejects(exa.getContents({ urls: ['https://user:pass@example.com'] }), ExaValidationError);
  await assert.rejects(exa.getContents({ urls: [] }), ExaValidationError);
  assert.equal(calls, 0);
  assert.throws(() => createExaClientFromEnv({}), ExaValidationError);
  assert.throws(() => createExaClient({ apiKey, baseURL: 'https://evil.test' } as never), ExaValidationError);
});
test('malformed, unsafe protocol and oversized responses fail with safe errors', async () => {
  for (const value of [null, { results: [{ url: 'javascript:alert(1)' }] }, { results: [{ url: 'https://example.com', highlights: [3] }] }, { results: Array(4).fill({ url: 'https://example.com' }) }]) {
    await assert.rejects(client(async () => json(value)).search({ query: 'test' }), ExaProtocolError);
  }
  await assert.rejects(client(async () => new Response('{')).search({ query: 'test' }), ExaProtocolError);
  await assert.rejects(client(async () => new Response(' '.repeat(2 * 1024 * 1024 + 1))).search({ query: 'test' }), ExaProtocolError);
});
