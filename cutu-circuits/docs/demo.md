# Cutu Circuits · four-minute demo

The strongest story is one real robot across native mechanical, electrical and
robot descriptions, with Codex editing the same saved project as the workspace.
Keep the physical Makada or its supplied photo beside the screen. Its three servos
drive six wire legs; the digital dimensions and physical parameters are estimates.

## Prepare once, then leave the demo alone

Use Node.js 24 or newer. From the repository:

```sh
npm ci
npm run build
node scripts/demo-preflight.mjs --start
```

The preflight starts the built application at `http://127.0.0.1:4310` using a fresh
temporary data directory, creates a separate rehearsal project, runs real engine
and packaged MCP checks, then stops its runtime. It fails if that port is already
occupied. It leaves the isolated files available at the path printed at the end.
It does not touch existing projects or operate hardware. Running preflight creates
the JSON receipt and real SVG/STEP exports in `artifacts/demo-validation/`.

To check an already running production runtime, omit `--start`. This creates a
uniquely named Makada rehearsal copy on that runtime and leaves it running. Set
`CUTUCIRCUITS_URL` if its local port differs. Run the command again after changing
the build; a previous receipt describes the build that was actually checked.

Start the actual demo with a dedicated writable directory. For example, on
macOS/Linux, choose a new directory for this rehearsal:

```sh
CUTUCIRCUITS_DATA_DIR="$PWD/.cutucircuits-demo" npm start
```

Open `http://127.0.0.1:4310`. A new directory seeds Makada and Sensor board. Keep
one runtime per data directory. Using a fresh directory isolates the demo from
development projects; it does not delete or reset any earlier project storage.

Before presenting, open **Assembly**, **Circuit**, **CAD**, and **Robot** once in
Makada. Wait for each native editor to finish loading. Backend preflight runs
disposable workers; the browser's lazy editors still need this separate warmup.
In Robot, open **Physics**, wait for **Play** to enable, then **Reset** and return
to **Inspect**. Return to Assembly, pause the motion preview, and close extra
panels. Leave the browser open at a comfortable desktop size.

Install the local plugin using the [plugin instructions](../plugins/cutucircuits/README.md),
start a fresh Codex conversation, and actually call `runtime_status` and
`list_projects` before the talk. Verify the project ID matches the open demo copy.
The setup panel does not prove that a Codex client is connected. The preflight's
stdio client proves the packaged server works, not that your presentation client
has installed it.

## Run of show

| Time | On screen | Say and do |
| --- | --- | --- |
| 0:00–0:35 | Physical Makada/photo, then Assembly | “This is Makada: three servos, six wire legs, and an ESP8266. Cutu Circuits keeps its design and programs together.” Orbit the model once. “This reconstruction follows the photo; the dimensions are estimates.” |
| 0:35–1:10 | Assembly motion, then Circuit | Press **Play motion preview** for a few seconds, then pause. “These are the firmware's commanded phases, without measured shaft feedback.” Open Circuit and show the three servo connections and shared power/ground. |
| 1:10–2:05 | Robot → Joints → Physics | In **Inspect**, move `left` slightly to show the coupled front/hind pair. Reset. Open **Physics**. For a clear motor demonstration, turn **Gravity** and **Ground plane** off under **Robot settings**, retain **Fixed base**, and wait for initialization. Open **Joints**, set `left` near 0.3 rad, press **Play**, then **Pause**. “This is a real rigid-body solver. Target and simulated position are separate; these masses and inertias are estimates.” |
| 2:05–3:30 | Codex beside CAD | Open **Parameters** and show `legSpan` 246. Return to Assembly, then use the prepared prompt below. Show the wider rebuilt stance and reopen CAD → Parameters to show 280; show the real export location. “Codex and the UI share the same project and guarded saved files.” Allow compilation to finish. |
| 3:30–3:50 | Assembly or edited CAD | “The same workspace brings native circuits, CAD, robot models and device programs into one engineering loop.” Stop while the main model is visible. |

The physics settings above deliberately make the motor response easy to see. The
ground/gravity controls can demonstrate contact separately during questions.
Makada's ideal rigid bodies do not model wire/glue flexibility or establish that
the physical robot will walk stably. Simulation does not connect to its board.

## Prepared Codex prompt

Replace `PROJECT_ID` with the exact ID from the demo project's context. Send this
only after the presentation client has passed its connection check:

> Use the Cutu Circuits plugin on project PROJECT_ID. Read the project and
> `model.replicad.ts`. Change only the default `legSpan` from 246 to 280 mm,
> preserving the other dimensions. Use the observed source SHA for the save.
> Compile the saved CAD and report its shape count and actual X bounds, confirming the wider stance. Export STEP,
> then use `project_environment` and your terminal to save the exact returned
> artifact content as `exports/spidey-demo.step` in this project's directory.
> Report the actual saved file path. Do not run a hardware operation.

The preflight exercises this exact leg-span edit through the packaged MCP
server, verifies 40 compiled shapes, expanded X bounds and actual STEP syntax, and restores the
rehearsal copy's original source afterward. The live prompt leaves its edit in
place. CAD changes do not automatically regenerate the checked-in URDF STL
visuals; describe those as the baseline articulated model.

Return to Assembly before asking Codex to change the saved CAD defaults. Reopen
CAD afterward to read the new defaults. A mounted native CAD Customizer retains
its current parameter overrides while you work; those can take precedence over
an externally changed default until you reopen that editor.

Do one complete timed practice with the actual laptop, browser and Codex client.
Keep the verified STEP file and a short recording of that practice locally.
If the client cannot write an export file, use the native CAD **Export → STEP**
operation and show its real output; do not announce a saved file without checking.

## Record a real fallback

With the production build ready, install Chromium and Playwright's recorder
binary if they are not already available (`npx playwright install chromium ffmpeg`)
and make FFmpeg available on the command line for trimming. Then run:

```sh
node scripts/demo-record.mjs
```

The recorder owns a fresh temporary project and a runtime on port **4330**. It
warms the actual native editors, records the actual UI, and uses the packaged
stdio MCP client to save the visible 246 → 280 mm leg-span change, compile and
export real STEP content. It cleans up its runtime and browser on exit. It keeps
the temporary project files at the path in its evidence receipt.

Open `artifacts/demo-validation/video/index.html` locally for the offline player,
or use `artifacts/demo-validation/video/cutu-circuits-demo.webm` directly. The
player includes a short description, timecode buttons, actual STEP output and
the numerical evidence receipt. The video is an automated browser rehearsal;
it does not show or imply a connected Codex desktop conversation. Its first
warmup section is trimmed without speeding up or replacing the recorded actions.

The short fallback narration is: “Here is Makada's native assembly and commanded
gait. The same project has a real articulated URDF and Rapier simulation, plus
its circuit and CAD sources. A packaged MCP call changes the saved leg span
from 246 to 280 mm; the actual geometry widens and exports as STEP.”

## Fallbacks that still tell the truth

- If Codex is unavailable, use **Workspace actions → Edit source files** to make
  the same one-parameter edit, save it, open CAD, and export STEP. Say “The plugin
  route was verified in rehearsal; I am making this edit directly here.”
- If a native module stalls, return to the already loaded Assembly view and show
  your recorded rehearsal. Label it as a recording and use the exact build you
  rehearsed. Record it locally before presenting; the source upload contains no
  pre-recorded demo video. Generate one with `node scripts/demo-record.mjs`; the
  actual browser recording and an offline player are written to
  `artifacts/demo-validation/video/`.
- If the board has not been connected and checked on this laptop, keep the
  physical robot as the reference object. Use the offline **Inspect hardware**
  or **Preview gait** capabilities only. Never represent preview pulses as
  measured servo positions. Live control needs local private credentials and a
  separately rehearsed physical setup.

## What the preflight proves

It checks built entry/lazy asset delivery; fresh Makada project creation; real
40-shape CAD compilation; real five-component circuit compilation and SVG export;
all 40 binary STL responses against their template bytes; parsed URDF and actual
Rapier joint motion; and packaged stdio MCP discovery, guarded source editing,
recompilation and a real STEP export. It checks no browser rendering, installed
presentation client, physical hardware, Wi-Fi, calibration or measured motion.

Running preflight creates `artifacts/demo-validation/preflight.json` with its
observed results. Browser rehearsal must be performed against the final build.
