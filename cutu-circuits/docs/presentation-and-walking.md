# Presentation and real robot controls

## Build Makada

Open **Makada Demo → Assembly**, then ask the assistant **build Makada**. The registered `build_makada` tool starts the show through the open view. The view acknowledges the request before the tool reports it started; if geometry is still loading it reports queued. An unopened view cannot silently report success.

The roughly 37-second sequence reveals servo cases, horns, each of six leg-and-foot pairs, the NodeMCU and wiring. Fades, settling and camera moves are presentation effects on existing geometry; source is neither changed nor recompiled. The final robot stays still. **Stop building** cancels the presentation. Changing projects/views cancels it, and hiding the window pauses the show clock. Running hardware sessions and unsaved edits block the show.

There is no idle Replay assembly or simulated walking button. Physical movement is a separate explicit control. Switch between the white presentation theme and the original dark theme using the top-bar button; the browser remembers the choice.

## Walk forward — actual hardware

1. Keep the workspace server and its private 2.4 GHz hotspot running. Power the controller and regulated servo supply correctly, with common ground. Use the saved calibrated assembly and a clear path.
2. In **Assembly**, find **Real robot · Wi-Fi**. Choose **Gait cycles** (1–100 for updated Makada projects) and click **Walk forward**. This click commands the physical robot, including sequential movement to saved centers before the gait starts.
3. Watch the observed cycle count. **Stop** cancels the owned session and sends STOP. Servo outputs detach and the legs may relax; support the robot when appropriate. A Stop robot button also stays in the header while walking, including in other views. Stop the run before switching projects. The settings button opens connection/action details and advanced limits.

A cycle is one repetition of the firmware gait, not a measured step length or distance. The control uses the board's saved movement/settling timing at full configured pace, with a three-minute request limit and a 2 Hz monitoring default. Larger requests are automatically split into queues of at most 20 cycles, preserving the MCU limits. Each queue must finish before the next is sent. The same authenticated connection maintains heartbeat and STOP ownership; no timed-out RUN is resent.

If the connection fails, remaining batches are abandoned, STOP is attempted and the UI reports the last observed count. No interface can confirm physical pose, electrical power or distance without the appropriate sensors. After a controller reboot, its DHCP address may change; refresh the private connection configuration before retrying if it cannot reconnect. Do not run an independent control client in parallel.

The private connection lives in the saved project's `.local/wifi.json` and is never returned to the agent or bundled into the source package. The visual robot follows fresh commanded pulse telemetry; it is not measured shaft feedback.

## One-command control

Keep the workspace running, then activate the terminal once with `. .\Activate-Workspace.ps1`.

```powershell
node scripts/makada.mjs walk --steps 5 --speed 100 --timeout 60
node scripts/makada.mjs stop
node scripts/makada.mjs build
node scripts/makada.mjs status
```

Walk sends physical motion immediately. Speed is 1–100 percent of the saved board timing; it does not set milliseconds. Steps accepts 1–100 gait cycles. Stop cancels active project operations. Status checks workspace availability, not electrical power. Commands do not rebuild or restart the workspace. Open http://127.0.0.1:4310/ on the computer running Cutu; localhost on another device refers to that other device.
