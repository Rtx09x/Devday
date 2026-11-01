# Cutu Circuits runtime

The local Express broker owns native project files, engineering identities, shared selection and hardware operations. It binds to `127.0.0.1:4310` by default and serves `apps/web/dist` when built.

Run `npm start` from the repository. `CUTUCIRCUITS_DATA_DIR` selects persistent storage (default `.cutucircuits-data` at the repository root); `PORT` and `HOST` override the listener. An empty store starts with independent copies of the Makada and sensor examples. Project source is trusted local code; engine subprocesses and hardware programs are bounded by their respective packages, not an operating-system sandbox.

Opening a project with a CAD asset automatically compiles its saved source. Only open projects whose code you trust: compilation can access local files and the network. Engineering subprocesses omit the configured Cerebras, Exa and OpenAI provider-key environment variables, but that is not a security sandbox and does not isolate other credentials or files. On Windows, arbitrary hardware programs can leave detached descendants after their parent exits; use trusted programs and verify their processes have stopped.

Successful CAD compile results are cached in runtime memory by project, path, saved source hash and parameter values (up to eight results and 64 MiB serialized). This cache survives a browser reload and is cleared when the runtime restarts. Each request rereads the saved source. For models that intentionally depend on time, randomness or external state, refresh the assembly or send `force: true` with the compile request to recompute it; those dependencies are not tracked in the cache key.

- `store.ts` implements atomic replacement, observed SHA-256 writes, revision-guarded graph updates, reference validation, persisted selection and serialized per-project mutations. All native file paths reject traversal and symlink components. Polling detects terminal changes to source files and project manifests and announces them over SSE.
- `server.ts` exposes the API in `docs/contracts.md`, enforces loopback host and same-origin mutation requests, and serves the workspace. The local development workspace at port 5173 is allowed.
- `events.ts` owns project event subscriptions; disconnects and shutdown remove subscriptions.
- `editor-bridge.ts` dispatches tools to an actual mounted native editor through SSE. Registrations and pending calls are bounded. Calls expire after 30 seconds. Editor writes require the source SHA-256 returned by the catalog or file API. SSE connections use `?sessionId=...` to cancel pending editor calls when the editor disconnects.

`createRuntime(options)` returns `{app, store, runner, listen, close}` for embedding and tests. Use `port: 0`, temporary storage, `seed: false`, injected engines/runner and `pollIntervalMs: 0` for deterministic integration tests. Call `close()` to stop watchers, SSE connections, editor RPC and running operations. `createApp(options)` is a convenience for Express consumers; lifecycle-managed callers should use `createRuntime`.

Run `npm test -w @cutucircuits/runtime`. Tests exercise restarts, independent template copies, CAS conflicts, revision conflicts, graph reference validation, traversal and symlink rejection, terminal edits, HTTP endpoints, SSE and native-editor RPC using temporary directories and safe injected engine/hardware implementations. They never connect to physical hardware.
