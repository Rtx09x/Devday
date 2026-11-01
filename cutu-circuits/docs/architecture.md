# Cutu Circuits architecture

## One project and one runtime

Every project contains `cutucircuits.project.json` plus native design/program files. The graph maps stable entities to circuit references, named CAD shapes, device channels, source assets and engineering relationships. Circuit TSX and Replicad TypeScript remain authoritative for their respective engines; the graph records their relationships without replacing those formats.

The browser and Codex plugin call the same local runtime. The runtime owns disk writes, source hashes, project revisions, selection and operation lifecycle. Server-sent events announce changes to manual and agent-driven work. Terminal edits affect these same files and are detected by a poller.

## Packages and responsibilities

| Package | Responsibility |
| --- | --- |
| `core` | JSON-serializable contracts shared across UI, runtime, engines and programs |
| `ui` | Actual Myui primitives, styles, palettes and composed surfaces under Cutu Circuits names |
| `web` | Minimal workspace, assembly navigation, source editing, operations and lazy native editors |
| `editor-host` | File lifecycle, revision guards, native menus, local Monaco, rich selection and editor-tool RPC |
| `electronics-editor` | Incorporated circuit editor, original canvases, simulations, validations and 67 declared tool handlers |
| `cad-editor` | Incorporated Replicad editor, original kernel worker, parameter controls, measurements and six tool handlers |
| `engines` | Headless adapters over existing compiler/export helpers and the CAD worker protocol |
| `runtime` | Persistent project service, HTTP API, event delivery and native-editor dispatch |
| `hardware` | Editable project programs, validated inputs, JSONL controls, output and cancellation |
| `plugin` | Stdio MCP client, engineering workflows and installable plugin packaging |

## Preserve the engineering implementation

The original source modules are incorporated into product-owned packages with their licenses/notices. Myui names, CSS namespaces and theme identifiers are renamed together while preserving their values. Engineering editor host imports are redirected to a compatibility layer. CAD loads the existing worker, WASM and font locally; the backend bridges that same worker protocol to a disposable Node process. Circuit compilation reuses CircuitRunner and the editor's Circuit JSON, lint, image and BOM helpers.

The electronics viewers retain the source repository's exact patches. `scripts/prepare-upstream.mjs` applies those unified diffs using a cross-platform Node implementation and checks the installed package version. The root lockfile and source-derived overrides pin the tested engineering versions. Explicit host dependencies supply packages that published upstream bundles import but list only as development/peer dependencies, recreating their original flat installation.

React and React DOM are shared singletons at version 19.2.7. Engine-specific Three.js instances stay behind plain mesh/transform boundaries. The application assembly uses millimetres and Z-up; the original CAD editor retains its documented display-frame conversion.

## File and state consistency

Native file writes require an observed SHA-256; new files require `null`. Graph mutations require the observed project revision. The store serializes mutations and uses individual atomic file replacements, guarded manifest hashes, immutable history and a durable recovery journal. Source and manifest are separate commits; interrupted known states can be recovered while unknown terminal changes are retained. Conflicts return HTTP 409 and retain unsaved content. The browser host preserves a dirty editor's original loaded hash even if another tool reads newer disk content.

Selection carries an entity ID, optional asset ID and rich pin/face context. Native selections map by exact entity/reference/shape identity. Selecting an entity from Codex updates the assembly inspector. Existing native editors publish their selections; their current public APIs do not provide generic reverse-selection setters.

Native tool calls use a registered live editor session and bounded RPC over SSE. The runtime catalogs the original schemas, checks session/project ownership and source guards, dispatches the handler in the browser, and receives its result. Closing the editor rejects pending calls. Successful editor-write operations await the original save lifecycle and actual CAS persistence before returning success; conflicts retain edits and return a failure. Native operations retain their existing edit-preview and undo behavior; the host frame adds Save/Cmd-S and registered actions.

## An adaptable hardware environment

Hardware support consists of project-owned programs plus a capability manifest. Codex can inspect the actual working directory, use terminal tools to set up dependencies, edit programs and register capabilities. Each capability declares an executable, argv array, input schema and deadline. The runner passes inputs on stdin and substitutes declared scalar arguments as individual argv entries.

One running program owns a project's device access. A persistent program receives JSON Lines controls through `send_operation`; its own code defines the device protocol. JSONL output becomes operation telemetry, with bounded output and credential redaction. Current commanded channel values can drive the illustrative assembly through declared joint mappings; finished operations stop overriding the manual preview. Cancellation first sends a control record, then terminates the process tree if necessary. Makada's broker serializes status/walk/stop on one authenticated TCP connection and maintains the firmware heartbeat.

Project programs and native models are trusted local code. Process/worker deadlines bound computation and failures; they are not an operating-system security sandbox. The runtime binds to loopback and enforces local host/origin checks.

## Current limits

Native editors must be mounted for renderer-backed tools. Headless compilation supports persisted circuit and CAD source; advanced project/STEP workflows are available through the original editor handlers. Robotics includes editable assembly graphs, commanded servo/gait previews, native URDF inspection and Rapier rigid-body simulation. The standalone robotics package uses SI units and typed link poses; URDFLoader owns the visual hierarchy, with no Three.js objects exchanged with the physics engine. Headless dynamics run in bounded disposable processes; browser playback uses fixed stepping and demand rendering. Real device behavior, geometry and feedback need validation against connected hardware; the included calibration is a last-known record.

[Robot/recovery workflow and boundaries](robotics-and-recovery.md) records URDF support, model assumptions, history semantics and journal recovery cases.
