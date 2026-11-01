# Cutu Circuits

An agent-assisted electronics and robotics workspace. Design circuits and mechanical parts, inspect a robot assembly, and connect the same project to real hardware.

**Makada** is the demonstration robot: a calibrated three-servo walker with a NodeMCU controller, an animated assembly presentation and Wi-Fi gait controls.

## Start on Windows

Requires Node.js 24+, PowerShell and an internet connection for the initial dependency installation. Setup installs user-level Python 3.12 when needed.

```powershell
.\Setup-Workspace.ps1
Copy-Item .env.local.example .env.local
# Add your provider keys to .env.local, then:
.\Start-Workspace.ps1
```

Open **http://127.0.0.1:4310/** and select **Makada Demo → Assembly**. The top-bar button switches between a high-contrast light theme and dark mode.

Keys are optional for the design workspace. Cerebras enables the embedded assistant; Exa enables cited web research. Keep keys in the root `.env.local` file, never in frontend code. Restart the launcher after changing keys.

## Demo

1. Open **Makada Demo → Assembly** and keep that view visible.
2. Ask the connected assistant to **build Makada**, or run the presentation helper in another activated PowerShell terminal:

   ```powershell
   . .\Activate-Workspace.ps1
   node scripts/build-makada.mjs
   ```

   The approximately 37-second show reveals the servo bodies, horns, six legs individually, controller and wiring. It uses the existing geometry and finishes stationary. It sends no hardware commands.
3. Inspect **Circuit**, **CAD** and **Robot** for the engineering representations. The Robot view supports bounded rigid-body simulation; it does not predict real-world walking performance.
4. With separately commissioned and calibrated hardware, use **Real robot · Wi-Fi → Gait cycles → Walk forward**. This is physical motion. Requests of 1–100 cycles are split into queues of at most 20, monitored on one authenticated connection. Stop remains available in the header. A connection failure cancels remaining batches; uncertain RUN commands are never repeated automatically.

A gait cycle is not a measured distance. Physical pose and displacement are not sensor-verified. Board credentials and calibration backups are deliberately absent from this repository; follow the hardware guide before connecting a device.

## Workspace capabilities

- Native circuit and CAD source editing, compilation and manufacturing exports.
- Shared project identities, selections, saved revisions and guarded source writes.
- URDF inspection, joint controls and Rapier rigid-body simulation.
- Streaming Cerebras assistant with Markdown, tool activity and explicit approvals for changes and execution.
- Exa research with cited public sources.
- A local Codex plugin with 27 shared-runtime tools, including the assembly presentation trigger.
- Project-owned device programs, live telemetry, cancellation and calibrated Wi-Fi gait control.

## Code map

| Location | Purpose |
| --- | --- |
| `cutu-circuits/apps/web` | Workspace interface, agent sidebar and 3D presentation |
| `cutu-circuits/packages/runtime` | Project persistence, API, agent orchestration and presentation events |
| `cutu-circuits/packages/hardware` | Device program execution and monitoring |
| `cutu-circuits/packages/plugin` | Codex/MCP tool server |
| `cutu-circuits/examples/spidey` | Makada sources, firmware and Python controller adapter |
| `Cerebras` | Isolated inference and streaming provider package |
| `Exa` | Isolated search provider package |

## Validate

```powershell
.\workspace.ps1 run typecheck
.\workspace.ps1 test
.\workspace.ps1 run build
.\workspace.ps1 run demo:check
```

The latest software check passed 131 tests, with zero failures and one platform-specific skip. Typecheck and the application/plugin build passed. Four presentation, theme and control browser scenarios passed; an additional control check verified Stop remains available after changing views. UI motion tests use a fake device and send no physical commands. Live Wi-Fi walking has also been exercised, but the wireless connection can interrupt longer runs.

Browser tests use an isolated runtime. See the application documentation before running them alongside a demo server. Provider keys are needed only for live inference/search, not the offline test suite.

## Documentation

- [Presentation and physical walking](cutu-circuits/docs/presentation-and-walking.md)
- [Demo runbook](cutu-circuits/docs/demo-runbook.md)
- [Physical board validation](cutu-circuits/docs/physical-board-validation.md)
- [Codex plugin setup](cutu-circuits/plugins/cutucircuits/README.md)
- [Application development](cutu-circuits/README.md)
- [Third-party notices](cutu-circuits/THIRD-PARTY-NOTICES.md)

This submission contains the application and provider sources, dependency lockfiles, tests and setup scripts. Local credentials, device flash backups, installed dependencies, generated caches and private project history are excluded. Third-party notices accompany incorporated components. The workspace builds on the existing [Cutu project](https://github.com/rtx09x/cutu); this repository is a fresh submission snapshot.
