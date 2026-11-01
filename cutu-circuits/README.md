# Cutu Circuits

A local engineering workspace for circuits, mechanical CAD, robot models and device programs, connected to Codex through a shared project runtime.

Native source files remain editable. Circuit, CAD, assembly, URDF and device representations share explicit project identities. The interface uses Myui components and keeps specialized tools contextual.

## Start the demo

Requires Node.js 24 or newer and npm. Install dependencies once while connected to the internet:

```sh
npm ci
npm run demo
```

The launcher builds the application and plugin, opens a local runtime, prepares the Makada assets and prints the workspace URL, normally **http://127.0.0.1:4310**. It uses `.cutucircuits-demo/` for demo projects. If Cutu Circuits is already running on that port, it reuses that runtime and preserves its projects. If another application occupies the port, it selects a free nearby port.

Before presenting, run the isolated software preflight:

```sh
npm run demo:check
```

It checks actual CAD/circuit compilation, all Makada meshes, real rigid-body simulation and the packaged MCP edit/compile/STEP path. It neither connects to a robot nor proves that the presentation laptop's Codex client is installed. The local report is written under `artifacts/demo-validation/`, which is excluded from the source release.

Follow the short [demo guide](docs/demo.md) for the rehearsed route, prepared Codex prompt and fallbacks. Open Circuit, CAD and Robot once in the presentation browser before starting so their lazy modules are ready.

## What works

- Persistent engineering projects with native source files, guarded saves and shared selections.
- Incorporated electronics and Replicad/OpenCascade editors, real circuit/CAD evaluation, and native manufacturing exports.
- Photo-informed Makada assembly, commanded gait preview and an articulated URDF with 40 CAD-derived STL visuals.
- URDF import and inspection, authored joint limits, and Rapier rigid-body physics with gravity, contacts, motors, play/pause, step and reset.
- Project-owned hardware programs with structured inputs, live controls and cancellable execution.
- Local version history, source comparisons, guarded restoration and interrupted-save recovery.
- A portable Codex plugin with 27 shared-runtime tools and the incorporated editors' additional tools while their assets are open.

The examples include Makada, a sensor board, an articulated test arm and a blank workspace. The demo launcher also prepares a Robot lab project.

## Codex setup

With a Codex client supporting local plugin marketplaces:

```sh
codex plugin marketplace add /absolute/path/to/cutu-circuits
codex plugin add cutucircuits@cutucircuits-local
```

Alternatively install **Cutu Circuits** through the repository's local marketplace in the Codex plugin browser. Start a new conversation, call `runtime_status`, then `list_projects` and `project_environment`. Verify the actual client on the presentation laptop before promising a live agent segment.

See [plugin setup](plugins/cutucircuits/README.md). The plugin communicates with the local runtime; the workspace does not simulate an embedded agent conversation.

## Development and regular use

```sh
npm run dev
```

Development UI: `http://127.0.0.1:5173`. Runtime: `http://127.0.0.1:4310`.

```sh
npm run build
npm start
```

The built application is served by the runtime. Regular projects live in `.cutucircuits-data/`; set `CUTUCIRCUITS_DATA_DIR` to choose another location. Keep credentials in private local configuration. Python 3 is required for the example device programs; live serial acquisition also needs `pyserial`. Windows users may need to set a capability's interpreter to `python`, `py`, or a virtual-environment executable.

## Current boundaries

Simulation uses ideal rigid bodies. Makada's masses, friction, joint bounds and pulse-to-angle mapping remain estimates; commanded and simulated positions are distinct from measured hardware feedback. No physical robot was exercised in software verification. Live control needs a separately tested board connection and private credentials.

URDF supports fixed, revolute, continuous and prismatic joints; STL/DAE visuals; and primitive/STL collision geometry. General closed-chain dynamics, calibrated servo torque, deformation and measured closed-loop control are not implemented. CAD edits do not automatically regenerate the separate URDF mesh assets.

Project programs and native models are trusted local code. Recovery journaling improves interrupted saves but does not make multiple files one atomic database transaction. Run one broker per data directory. See [robotics and recovery](docs/robotics-and-recovery.md) for precise limits.

## Checks and clean upload

```sh
npm run typecheck
npm test
npm run build
npm run release:source
```

The release command prepares a separate clean source package and fresh initial Git repository. It excludes working project data, private history, old Git directories, research, past reports, recordings and build caches. Required licenses and provenance remain included. It does not modify the working repository or upload anything. See [release instructions](docs/release.md).

[Architecture](docs/architecture.md) · [API contracts](docs/contracts.md) · [Source provenance](sources.lock.json) · [Third-party notices](THIRD-PARTY-NOTICES.md)
