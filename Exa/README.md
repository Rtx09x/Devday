# Exa backend search and contents

Standalone Node 24+ TypeScript/ESM package with no runtime dependencies. No key, environment lookup, network call or background task occurs on import. No live API requests were used for development.

From this folder, run `npm ci` then `npm run check`. The check typechecks sources/tests, executes deterministic mocked-fetch tests and builds JavaScript, declarations and source maps into `dist/`. Install this folder as a local dependency with `npm install /absolute/path/to/Cutu/Exa`, or import its built `dist/index.js` directly. Its own lockfile and dependencies make it independent of the UI application's dependencies. The package is private to prevent accidental registry publication.

```ts
import { createExaClientFromEnv } from '@cutucircuits/exa';

// Supply EXA_API_KEY through your backend environment or secret manager.
// The package does not load .env files. Missing credentials fail on construction.
const exa = createExaClientFromEnv(process.env);
const controller = new AbortController();
const found = await exa.search({
  query: 'LM358 input common mode voltage datasheet',
  includeDomains: ['ti.com'],
  numResults: 3,
  type: 'lite',
}, { signal: controller.signal, timeoutMs: 20_000 });

// Only call after the application authorizes these specific source URLs.
const pages = await exa.getContents({
  urls: found.results.map(result => result.url),
  text: { maxCharacters: 8000 },
  highlights: false,
  maxAgeHours: -1,
}, { signal: controller.signal });
// Inspect pages.statuses: HTTP 200 can include individual retrieval failures.
```

`createExaClient({apiKey, fetch?, timeoutMs?})` supports direct injection. `createExaClientFromEnv(env, {fetch?, timeoutMs?})` explicitly reads the supplied environment object. Injected fetch code receives credentials and must be trusted. Browser construction is rejected. Never put this key in a `VITE_` variable or a frontend bundle.

The client sends JSON POST requests only to `https://api.exa.ai/search` and `/contents` with `x-api-key`. Redirects are refused. Returned source URLs are data; the package never fetches them directly, opens a browser, runs tools, reads files or executes returned instructions. Callers own query/resource permission, domain policies (including private-address filtering), cancellation, budget decisions and all prompt injection/citation handling. Source content is untrusted.

Defaults are `type:'lite'`, 3 results, `highlights:{maxCharacters:2000}`, and `text:false`. Limits imposed by this package are 1–10 results/URLs, 4096 query characters, 100 entries per domain filter, 4000 highlight characters and 20000 text characters per URL. Output is also truncated locally to requested content budgets, with a 2 MiB HTTP response cap. Metadata strings are bounded; unused summaries, images, synthesized outputs and nested payloads are discarded.

For search, pass `contents:{text,highlights,maxAgeHours?,livecrawlTimeout?}`; for `getContents`, these fields sit beside `urls`. Text/highlights accept `false` or `{maxCharacters:number}`. Both search and contents default to bounded highlights; pass `highlights:false` when requesting text alone. Explicit text plus highlights can incur both content-type charges.

Supported search modes are `lite`, `auto`, and the legacy `fast`/`instant`. The current docs also publish `deep-lite`, `deep`, and legacy `deep-reasoning`; this package deliberately excludes those research modes, generated summaries, synthesis, Agent API and subpage crawling. Unknown fields fail before networking. Include/exclude filters support hostnames, domain paths and wildcard subdomains. Provider warnings/notices preserve codes and paths so callers can detect relaxed restrictions; they are not proof of authorization, so enforce application source policy on results.

Lite serves indexed content without query-time live fetching, so live-fetch options are rejected for lite. Other modes and `getContents` default to `maxAgeHours:-1` (cache only). Callers may explicitly select `maxAgeHours:0` for fresh content or an integer through 720 for cache freshness, and `livecrawlTimeout` from 1 to 90000 ms. Cache-only calls can return individual missing-content failures. The full request deadline defaults to 20000 ms, may be overridden from 1 to 120000 ms, and includes body consumption. Abort cancels the owned request, leaving the caller's controller intact. There are no retries or implicit follow-up calls.

Responses contain `results` with `url`, optional `id/title/author/publishedDate/text/highlights`, optional `statuses` (`id/status/source/error.tag/error.httpStatusCode`), `requestId`, `costDollars.total`, `searchTime`, `resolvedSearchType`, and warning/notice codes. Missing statuses are not synthesized. Partial failures remain visible to the caller. HTTP errors use `ExaAPIError.status` and a safe header request ID; raw provider bodies/messages, raw fetch causes, prompts and keys are omitted. `ExaValidationError`, `ExaProtocolError`, `ExaTransportError`, `ExaTimeoutError` and standard `AbortError` distinguish failures. The package logs nothing.

Official contracts checked 2026-11-01: [Search](https://exa.ai/docs/reference/search), [Contents](https://exa.ai/docs/reference/get-contents), [OpenAPI](https://exa.ai/docs/exa-spec.yaml), [Pricing](https://exa.ai/docs/admin/pricing). The current published base rates are $4/1000 lite requests and $7/1000 auto requests (up to 10 results); contents is $1/1000 pages per content type. Result count caps limit returned material but do not proportionally reduce the base search fee. Live account prices, credits and permissions remain authoritative; estimated costs are exposed when returned. These references document availability, not a verification of any account's access.
