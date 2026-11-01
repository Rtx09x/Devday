# Cutu Circuits local Codex plugin

This repository plugin uses a real stdio MCP server to reach the same HTTP broker as the workspace. It ships portable `plugin.json` + `mcp.json` and a Codex compatibility manifest. It is a local development package, not a published remote service.

1. In the repository root, run `npm install`, then `npm run build -w @cutucircuits/plugin` and `npm run dev` (or `npm start` after building the workspace).
2. Register this repository marketplace with `codex plugin marketplace add /absolute/path/to/cutu-circuits`, or open the repository's local source in the Codex desktop Plugins Directory. Install **Cutu Circuits** and start a new conversation. The repo catalog is `.agents/plugins/marketplace.json`; its source path is relative to the repository marketplace root, as in the official repo example.
3. Call `runtime_status`, then `list_projects`. Open the UI at `http://127.0.0.1:5173` during development. Open native assets there to expose their advanced editor tools.

The host resolves `${PLUGIN_ROOT}` in MCP arguments. `scripts/launch.mjs` prefers the self-contained `dist/server.mjs` built by the plugin build command; copied host caches need only Node 24 and that bundle. If no bundle exists, the development fallback resolves repository paths from its own location, independent of the host working directory. For a copied source-only plugin, set `CUTUCIRCUITS_REPO` to the original repository. Set `CUTUCIRCUITS_URL` to change the default broker `http://127.0.0.1:4310`. Neither startup nor `runtime_status` launches a broker, robot connection or hardware action automatically. The source fallback needs repository dependencies, including tsx. Generated bundle and full third-party licenses live in ignored `dist/`; build before installing or copying the plugin.

The 26 MCP tools cover runtime health, persistent project creation/list/read, actual project environment and file listing, guarded native files, guarded graph updates, shared selection, compilation/export, hardware manifests/operation run/send/list/cancel, and native editor catalog/dispatch. Files are only changed through the runtime. The server writes protocol messages only to stdout and reports errors as MCP error results with structured broker error codes.

`list_editor_tools` exposes the mounted source handlers and exact JSON schemas rather than imitating their operations. Calls may fail if the workspace editor is absent or its session closes. Supply the catalog's session ID and, for source mutations, the SHA from `read_file` as `expectedSha256`. No UI chat controls imply a live Codex session; actual plugin calls drive state.

To run the protocol tests: `npm run test -w @cutucircuits/plugin`. Tests also copy the built plugin into an isolated cache directory with no repository override. They spawn the executable stdio launcher and connect an official SDK Client against a fixture HTTP broker. Physical devices are not exercised.

Robot and recovery tools: `import_urdf`, `inspect_robot`, `simulate_robot`, `list_file_history`, `read_file_version` and `restore_file_version`. Simulation returns SI poses, simulated joint positions, contacts and model diagnostics; it never controls hardware. Restore requires the observed current file SHA and preserves prior versions. See [workflow and limits](../../docs/robotics-and-recovery.md).
