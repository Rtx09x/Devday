# Cutu / Makada demo

## Before presenting

Build with `npm run build` from the application folder. Add the two provider keys to root `.env.local`, stop the old runtime, and run `./Start-Workspace.ps1 -SkipBuild` from the workspace root. Open http://127.0.0.1:4310 and select Makada. The launcher warms the native assets. Open Ask Cutu and confirm both provider indicators; missing configuration is not a live connection test.

Use a duplicate project for agent edits. Keep the original demo as a recovery point. Run the prompts below once with the actual keys before presenting; provider availability, account credits and model access have not been verified by offline fixtures.

## Three-minute story

1. **Design to movement (40 seconds).** Select the prepared **Makada Demo** project, close the agent panel for a clear stage, and say **build Makada** to trigger the presentation. Cases, horns, each of the six wire legs, controller and wiring reveal over about 37 seconds, ending fully assembled. Stop building cancels the presentation. Explain that this is a deterministic reveal of precompiled geometry, without physical or illustrative walking; there is no measured servo feedback. The caption disappears when the build is complete.
2. **Understand and research (60 seconds).** Open Ask Cutu. Ask: “Read the saved circuit source. Explain the D5/D6/D7 servo signal mapping and the separate servo power rail. Do not change files.” Then ask: “Find manufacturer documentation for this NodeMCU ESP8266 board and verify the GPIO mapping. Cite your sources and flag anything you cannot confirm.” Expand one tool record and open one returned citation.
3. **Propose, approve, verify (60 seconds).** Ask: “Read README.md and propose a short demo wiring checklist at the end. Include the three signal pins, separate regulated 5 V servo power, and common ground. Ask before saving.” Inspect the proposed content, approve the exact write, and open the saved file/history to prove the change. Reject instead if the proposal is incorrect. Each read, edit and approval should be visible.
4. **Close (20 seconds).** Show that native sources, circuit views, CAD and hardware programs share the project. Open the agent menu to show the Codex connection route for larger tasks. Describe the compiled firmware separately from actual hardware validation.

Optional image moment: attach a wiring photo or screenshot and ask the agent to compare it with the saved circuit. PNG/JPEG only, two images and 3 MiB total. Image input is sent to Cerebras for that turn. Do not attach credentials or private personal material.

## Recovery

If a provider fails, stop the turn and show the working design/circuit/preview plus the offline test evidence. Do not present fixtures as live inference. Refresh only when needed; manual native Refresh deliberately recompiles. If a source edit conflicts, reload the current source and propose again rather than overwriting it.

## Hardware scope

Firmware compiles for `nodemcuv2`; protocol tests use fake TCP devices. The actual NodeMCU was subsequently privately backed up, flashed and authenticated; live calibration and timing matched the backup. Centering was visibly confirmed by the owner and a full 50-cycle queue sequence was verified. Long wireless runs can still time out, so rehearse a short bounded run for a public demo. A physical demonstration still requires verified power/wiring, a clear supported robot and a supervised bounded test. STOP detaches the servo outputs. Keep that as a separate demonstration from the browser preview.

The prepared project contains the updated `SNAPSHOT` firmware and Python adapter. Rebuild intentionally with private credentials before flashing; the validation binary contains dummy credentials and must not be uploaded. Connect through the existing single-session hardware capability. Atomic telemetry defaults to 10 Hz (configurable 1–20); older firmware falls back to non-atomic STATUS/DIAG. The UI follows and smooths fresh commanded pulses, marks stale samples, and stops claiming a live pose when outputs detach. Matching actual forward travel would require measured position feedback; the authored preview travel is not that feedback.

