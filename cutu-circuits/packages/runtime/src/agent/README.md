# Workspace agent backend

The HTTP runtime owns one in-memory conversation and at most one active turn per exact project ID. Closing the runtime erases conversations. `DELETE /api/projects/:id/agent/history` clears an idle conversation. Frontend requests never contain provider keys. Supply `CEREBRAS_API_KEY` and optionally `EXA_API_KEY` in the runtime process environment; no dotenv loading or network request occurs on module import.

The embedded agent reuses `packages/plugin/src/registry.ts`, the same 26 schemas and broker handlers as the external Codex MCP plugin. Project creation/listing stay visible but denied in this project-bound agent. Read, selection, and simulation tools run under the current user request. Compile/export execute project-authored code in an unsandboxed local process with runtime permissions and environment access, so they require exact approval after source review. Source/graph writes, restore, URDF import, native editor calls, and every hardware run/send/cancel pause for exact user approval. There is no shell tool. An approval is single use, bound to the active project/turn and the immutable pending parsed arguments (SHA-256 verified again before execution); it expires when the turn ends, disconnects, cancels, or reaches its deadline. Approval never bypasses broker CAS/schema checks. Source writes require observed hashes; graph writes require observed revisions. Changes outside this agent remain subject to the existing store guards.

`GET /api/projects/:id/agent/status` returns key-presence booleans, fixed model ID, active turn ID, visible text history (`{role, content, turnId}`), configured limits, and the full tool catalogue with JSON schemas and `read`, `approval`, or `denied` policies. No credential value is exposed.

`POST /api/projects/:id/agent/turns` with `{message, attachments?}` streams SSE event names and matching `type` fields. Optional attachments are `{name, dataUrl}` objects: at most two PNG/JPEG data URLs, 3 MiB combined decoded size. The runtime checks canonical base64 and MIME magic before starting SSE; it never fetches an attachment URL or reads a supplied filename. Image bytes go to the configured provider only for the current turn and are not retained in history. Names remain as a text annotation; subsequent turns need images attached again. The provider performs final image decoding and pixel/decompression limits.

For local development, put backend keys in the root ignored `.env.local` (`CEREBRAS_API_KEY=...` and `EXA_API_KEY=...`) and run root `Start-Workspace.ps1` (or `-SkipBuild` after building). The launcher parses only these two assignments as data, does not print values, and restores its prior process environment on exit. Stop the older runtime before starting it so the new runtime inherits the keys. Never paste keys into chat, project source or the browser composer.

Events:

- `start`: `{turnId, model}`
- `text_delta`: `{turnId, delta, provisional:true}`; provisional until `complete`
- `text_reset`: `{turnId, reason}`; discard the provisional answer on failed/cancelled turns
- `tool_start`: `{turnId, callId, name, args}`
- `tool_result`: `{turnId, callId, name, result}`; structured result or `{error:{code}}`, capped for display/model context
- `approval_required`: `{turnId, approvalId, callId, name, args, argsSha256, expiresAt}`
- `citations`: `{turnId, sources:[{id,url,title}]}`; authoritative server mappings
- `complete`: `{turnId, text}`
- `error`: `{turnId, code, message, discardText:true}`
- `cancelled`: `{turnId, code, discardText:true}`

The client responds through `POST /api/projects/:id/agent/approvals/:approvalId` with `{approved:boolean}`. A stale, consumed, cross-project or expired ID fails. `POST /api/projects/:id/agent/cancel` aborts the current turn. Closing the streaming response also cancels it. Runtime shutdown cancels/waits for active turns before disposing resources.

Each turn allows at most six tool executions, four provider requests with 2048 output tokens each, and a 120-second total deadline. There are no inference retries. Partial/length-truncated/unknown-finish completions cannot execute their tool requests. Model output is untrusted. Tool results and Exa content are labelled untrusted evidence. Search defaults to three low-cost `lite` results and bounded highlights; content reads accept only server-issued source IDs from the same turn, cache only, never arbitrary model URLs or filesystem paths. Citation IDs must exist in that turn's server mapping; the final text uses IDs rather than invented URLs. Search requires an independently configured Exa key. Provider/service injection supports deterministic offline tests; no live paid calls are part of validation.

Agent file privacy boundary: path-based calls reject hidden path components and known credential-bearing names/extensions (including `.env` variants, `.local` files, `secrets.h`, Wi-Fi/credential/token/password files, and private-key containers) before broker dispatch, activity display, or approval. Approval does not bypass this denial. Discovery/history results are filtered before reaching the model or UI. Version reads/restores require a safe path observed through history metadata in the same project and turn. These conservative filename checks are not complete DLP: arbitrary permitted source files can contain inline secrets. Review source before sharing it with the configured inference provider.

`compile` accepts optional `force:true` to bypass the runtime cache; it retains the same exact execution approval requirement.
