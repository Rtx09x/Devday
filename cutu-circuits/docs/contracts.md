# Implementation contracts

Shared types live in `packages/core/src/index.ts`. The local runtime is the authoritative owner of project files and selection. All callers use the same HTTP API; SSE announces state changes. Default runtime port: 4310, workspace dev port: 5173. Production serves the workspace from the runtime. Bind runtime to 127.0.0.1 by default.

## HTTP API

Success responses are direct JSON values. Errors: `{error: {code, message}}` and appropriate HTTP status. Revision/hash conflicts return 409. Project and operation IDs are opaque strings; paths are project-relative. Native source writes require the exact observed SHA-256. New files use `expectedSha256: null`.

- `GET /api/health` → `{name:'Cutu Circuits', version:'0.1.0', status:'ok'}`
- `GET /api/projects` → `ProjectSummary[]`
- `POST /api/projects` body `{name, template?:'spidey'|'sensor'|'blank'|'robot'}` → `Project`
- `GET /api/projects/:id` → `Project`
- `PATCH /api/projects/:id` body `{expectedRevision, changes: Partial<Project>}` → `Project`. Immutable id/version/revision/timestamps cannot be supplied in changes. Validate the resulting graph.
- `GET /api/projects/:id/files?path=...` → `FileSnapshot`
- `PUT /api/projects/:id/files` body `{path,content,expectedSha256:string|null}` → `FileSnapshot`. Source changes update project revision and publish events. Projects may register assets using PATCH.
- `GET /api/projects/:id/selection` → `Selection`
- `PUT /api/projects/:id/selection` body `{entityId:string|null,assetId?,origin:'workspace'|'codex'}` → `Selection`
- `GET /api/projects/:id/events` → SSE, each `data:` is `WorkspaceEvent` JSON. Client refetches relevant state.
- `POST /api/projects/:id/compile` body `CompileInput` → `EngineResult`. Backend loads source and calls engines; compile is bounded.
- `POST /api/projects/:id/export` body `{path,format:'step'|'stl'|'obj'|'svg'|'bom',parameters?}` → `ArtifactResult`.
- `GET /api/projects/:id/operations` → `Operation[]`
- `POST /api/projects/:id/operations` body `{capabilityId,inputs:Record<string,unknown>}` → running `Operation` (202).
- `POST /api/projects/:id/operations/:operationId/cancel` → `Operation`.
- `POST /api/projects/:id/operations/:operationId/send` body `{message:Record<string,unknown>}` → `Operation`. JSON Lines control for a running persistent program; device programs define their own action protocol.
- `POST /api/projects/:id/editor-sessions` body `{sessionId,path,tools:[{name,description,inputSchema,access}]}` registers an open native editor and its existing tools; `DELETE /editor-sessions/:sessionId` unregisters.
- `GET /api/projects/:id/editor-tools` lists available live editor tools; `POST /editor-tools/:name` body `{params,sessionId?}` awaits the original editor handler result.
- Runtime sends SSE `WorkspaceEvent` with type `editor-tool-request`, data `{sessionId,requestId,name,params}`. The registered UI posts `{requestId,result}` to `/editor-sessions/:sessionId/results`. Requests time out and must be bound to the correct project/session.

## Runtime service boundaries

`packages/engines` exports `compileCircuit(source:string,path:string):Promise<CircuitResult>`, `compileCad(source:string,path:string,parameters?):Promise<CadResult>`, `exportCircuit(source,path,format:'svg'|'bom'):Promise<ArtifactResult>`, `exportCad(source,path,format:'step'|'stl'|'obj',parameters?):Promise<ArtifactResult>`. Compute occurs in disposable/timeout-bounded workers or child processes so busy-loop model code cannot freeze the broker. Native model authoring supports Replicad default function + defaultParams.

`packages/hardware` exports `HardwareRunner` with constructor options `{onUpdate:(operation:Operation)=>void}`; `run(projectId:string,projectRoot:string,capability:Capability,inputs:Record<string,unknown>):Operation`; `cancel(operationId:string):Promise<Operation>`; `list(projectId:string):Operation[]`; `dispose():Promise<void>`. Runtime validates capability IDs from the current project manifest. No arbitrary shell string interpolation. Capability arguments can use `{{inputName}}`; each replacement stays one argv item. The runner receives inputs as JSON stdin as well. Project-owned programs are trusted local code, bounded by timeouts and cancellation, and run in the project directory. This is an execution environment, not an OS security sandbox. JSON Lines stdout can report telemetry records. Never put credentials into API results or manifests.

Examples are directories under `examples/spidey`, `examples/sensor`, `examples/blank` with `cutucircuits.project.json` and real native source files. Runtime copies a template to a new UUID project directory and replaces id/timestamps/revision. A source example ID may be a slug. Initial run can seed a Makada and sensor project when the data directory is empty. `CUTUCIRCUITS_DATA_DIR` chooses storage; runtime keeps the data directory out of source control.

## UI and plugin

UI uses actual renamed Myui source under `packages/ui`, exported as `@cutucircuits/ui`; all former `catalyst` CSS namespaces become `cutucircuits`, `supernova` becomes `cutucircuits`. Preserve values and geometry. Root dataset `data-ui='cutucircuits'`. Material dark default. UI should lazily fetch compile results and retain native source editing, real downloads, shared selection, saved changes, motion preview and capability execution. No simulated agent conversation. Plugin panel explains actual Codex tools/connection.

`packages/plugin/src/main.ts` is a stdio MCP client of the local HTTP broker. It must never write native source behind the runtime. Use current official MCP SDK. A bundled launcher resolves installation paths robustly; do not assume Codex starts it in this repository. API calls carry source hash/revision guards. Provide real tools for projects, files, graph, selection, engines, hardware capabilities/operations and runtime status. Descriptions distinguish commanded and observed hardware state.


## Robot and history APIs

`GET /api/projects/:id/history?path=...&limit=100` returns `FileHistoryEntry[]`; optional path filters a file, maximum limit100. `GET /history/:versionId` returns `{entry,content}`. `POST /history/:versionId/restore` takes `{expectedSha256:string|null}` and returns a new guarded `FileSnapshot`. Restoring the project manifest or binary history through this UTF-8 endpoint is unsupported.

`POST /api/projects/:id/robotics/import` takes `{path,content,name?}` and returns `{project,asset,file}` (201). It validates new URDF/XML and journals file creation and URDF asset registration together. Existing files/assets are not overwritten. `Asset.kind` includes `urdf`; template `robot` provides a two-axis arm.

`GET /api/projects/:id/assets/raw?path=...` serves confined native robot resources up to16MiB with no-store/no-sniff headers. Registered and companion files are supported; private records, symlinks and unsupported rendering extensions are refused.

`POST /api/projects/:id/robotics/inspect` takes `{path}` and returns `{path,sourceSha256,model}`. `POST /robotics/simulate` takes `{path,durationSeconds?:0..10,fixedBase?:boolean,ground?:boolean,gravity?:Vec3,position?:Vec3,jointTargets?:Record<string,number>}`. It returns `{path,sourceSha256,source:"simulated",units:"m-kg-s-rad",robot,timestep,steps,fixedBase,initial,final,maxContacts,diagnostics}`. Snapshots contain time, world link poses (position and XYZW quaternion), simulated joint position/target and contact count. It uses a separate process with10-second deadline; maximum two concurrent headless jobs. Defaults: fixed base, ground enabled, gravity −Z, timestep1/120s, duration2s. No device or operation is started.
