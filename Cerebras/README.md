# Cerebras Qwen 3.8 backend integration

Standalone TypeScript/ESM package for **`qwen-3.8-27b`** on Cerebras Shared Inference. No API key is included. No UI, network call, environment lookup, file access or tool execution happens on import. Node 24+ provides the runtime fetch/streams; there are **no runtime dependencies**.

## Install and verify offline

From the workspace root in PowerShell:

```powershell
. .\Activate-Workspace.ps1
Set-Location .\Cerebras
npm ci
npm run check
```

`check` typechecks the package, examples and tests, runs deterministic mocked-network tests, and builds JavaScript, declarations and source maps into `dist/`. Tests do not need credentials and never contact Cerebras. The package has its own lockfile and dependencies and does not depend on the sibling application's `node_modules`.

For another **backend** Node project, install this folder as a local dependency after building it:

```powershell
npm install /absolute/path/to/Cutu/Cerebras
```

Then import `@cutucircuits/cerebras`. An ESM backend can also import `Cerebras/dist/index.js` using its actual relative or absolute path. This is a standalone folder, so changes do not alter the React app or automatically expose endpoints. All package exports are available through `src/index.ts` and generated `dist/index.d.ts`.

## Create a caller-owned client

```ts
import { createCerebrasClientFromEnv } from '@cutucircuits/cerebras';

// Later, supply CEREBRAS_API_KEY through your backend environment/secret manager.
// Construction fails clearly while the key is missing. Never use VITE_ or ship it to React.
const client = createCerebrasClientFromEnv(process.env);
const controller = new AbortController();
const completion = await client.generateText('Explain an RC filter.', {
  reasoning_effort: 'none', max_completion_tokens: 512,
}, { signal: controller.signal, timeoutMs: 30_000 });
const answer = completion.choices[0]?.message.content;
```

`createCerebrasClient({ apiKey, fetch?, timeoutMs?, maxRetries?, capacity?, baseURL? })` supports direct runtime injection and test transports. Environment loading is explicit: `.env.example` is a blank reference; the package does not load `.env`. Each factory closes over its own key/configuration. Keys are backend-only; browser construction is rejected. A custom HTTPS `/v1` URL is an explicit trust decision: it receives your credentials. Redirects are refused. This package targets the fixed Shared Inference Qwen ID, including when a gateway base URL is supplied; it does not assume a Dedicated endpoint contract.

## Functions ready for reuse

| Function | Purpose |
| --- | --- |
| `client.complete(request, options?)` | Full typed completion, reasoning, tool requests, usage, token logprobs, finish reasons and timing |
| `client.generateText(prompt, parameters?, options?)` | Single-user text convenience call; returns the complete response |
| `client.stream(request, options?)` | Lazy async generator of original chunks, including tool/reasoning deltas and final usage |
| `collectStream(chunks)` | Assemble text, reasoning, interleaved tool argument fragments, usage and finish reasons |
| `client.generateJson(request, validate, options?)` | Parse a completed JSON response and require caller runtime validation |
| `imageFromBytes(bytes, mime)` | PNG/JPEG data URI content part from caller-provided bytes; no file reads/fetches |
| `parseToolArguments(call, validate)` | Parse untrusted tool JSON and validate with caller code |
| `assistantHistory(message)` | Copy assistant content, reasoning and tool calls for a subsequent request |
| `client.listModels(options?)`, `retrieveModel(options?)` | Explicit authenticated availability/metadata lookup |
| `QWEN_CAPABILITIES`, `QWEN_MODEL` | Sourced model metadata, tier limits and exact model ID |
| `validateStrictSchema(schema)` | Common contract checks; authoritative full validation remains on the server |

See [examples/usage.ts](examples/usage.ts) for importable text, streaming, vision, JSON Schema and tool proposal/result functions. These functions never run automatically. Inputs, output storage, cancellation, authorization, function execution, conversation history and client ownership all belong to your application.

```ts
for await (const chunk of client.stream({
  messages: [{ role: 'user', content: 'Explain a voltage divider.' }],
  reasoning_effort: 'low', max_completion_tokens: 2048,
}, { signal: controller.signal })) {
  // Send only chosen fields to an authorized downstream consumer.
  const textDelta = chunk.choices[0]?.delta.content;
  const reasoningDelta = chunk.choices[0]?.delta.reasoning;
  // chunk.choices may be empty on a usage-only chunk.
}
```

Break a `for await` loop or abort its signal to cancel. The iterator releases its reader and aborts its own request, never the caller's controller or injected fetch resources. A created but unconsumed generator makes no request. If manually using `.next()`, always call `.return()` in `finally`. The total timeout (60 seconds by default) includes retries, response body reads and full stream consumption, even while the consumer is paused. No background workers, global client or `close()` lifecycle is required.

## Limits and supported controls

The default capacity is **`free-trial`**: 65,536 context tokens, 32,768 maximum output tokens and 2 images per request. Explicit **`capacity: 'paid'`** selects documented limits of 131,072 context tokens, 40,960 output tokens and 10 images; it does not upgrade the account or infer paid access from promotional credits. Actual account quotas remain authoritative. The package checks maximum output, image count and the 10 MiB serialized request size. It does not guess text/image token counts or decode images; context, image integrity/dimension/decompression and full schema limits are verified by Cerebras. Set an explicit completion budget in application calls; reasoning tokens consume that budget too.

Supported controls include `reasoning_effort` (`none`, `low`, `medium`, `high`), `reasoning_format` (`parsed`, `raw`, `none`), `clear_thinking`, temperature/top-p, seed, stop strings, frequency/presence penalties, logit bias, logprobs/top-logprobs, maximum/minimum completion tokens, `n: 1`, tool choice/parallel calls, response formats and prompt cache routing keys. API version 2 is pinned explicitly. Unknown top-level parameters fail before networking. Canonical completion-token names are used instead of duplicate `max_tokens`/`min_tokens` aliases.

The [verified model contract](docs/model-contract.md) explains preview status, tier distinctions, strict schema requirements and unsupported features. Research sources were checked **2026-11-01**; limits/capabilities can change, and a real key is required to confirm the account's access.

## Tools, JSON and errors

Tools are **schemas and returned proposals**, never executable callbacks. Validate arguments and authorize the named function/resource before running it. Send the full returned assistant message followed immediately by exactly one tool result for each tool-call ID. Tool results are untrusted text. Qwen Shared Inference does not accept images in tool messages. No conversation or automatic agent loop is retained by this package.

Structured output uses `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`; it can stream. Legacy `json_object` requires JSON instructions in the conversation and cannot stream. Use a separate request after tool use for structured formatting: a combined `tools` + JSON response-format contract is not documented for this model and is rejected locally. Explicit `{type: 'text'}` with tools is accepted. JSON parsing never grants a type assertion: `generateJson` requires a validator and rejects incomplete (`length`) outputs. `collectStream` preserves `length`; your application must inspect it before using an assembled answer.

Strict schemas require an object root/properties, `additionalProperties: false` at every object and valid array item schemas. Optional properties are supported. Local nonrecursive `$ref`/`$defs`, nonroot `anyOf`, tuples and numeric constraints are supported. The local checker catches common unsupported keywords; it is deliberately not a complete schema validator (reference resolution, recursion through `$ref`, aggregate schema budgets and all types are still validated remotely). Full rules and limits are linked in [docs/model-contract.md](docs/model-contract.md).

`CerebrasAPIError` exposes HTTP `status` and a safe `requestId`; raw server error bodies/messages are omitted to avoid accidentally retaining prompts or secrets. `CerebrasValidationError`, `CerebrasProtocolError`, `CerebrasTransportError`, `CerebrasTimeoutError` and standard `AbortError` distinguish local validation, malformed/truncated responses, connectivity, deadlines and caller cancellation. Errors do not retain the API key, raw fetch cause or request payload. The library logs nothing; applications decide what to show or log. Treat successful model outputs as untrusted too.

Retries default to **0** because repeating inference can duplicate billable work. Opt in with `maxRetries` (0–5) for explicit HTTP 408/409/429/500/502/503/504 responses only; `Retry-After` and exponential backoff are bounded by the total deadline. Network failures and streams that have started are never retried. SSE supports UTF-8 and newline boundaries, comments and multiline data, rejects error events and missing `[DONE]`, and bounds individual buffered events at 2 MiB. JSON responses are bounded at 32 MiB. For large outputs consume chunks directly; `collectStream` accumulates output in caller memory.

No paid/live inference was used for development or validation. The package is marked `private` to prevent accidental registry publication; local installation and package builds work normally.
