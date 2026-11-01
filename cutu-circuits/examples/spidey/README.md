# Makada — three servos, six wire legs

Compact Beetle/Ringo-style assembly. Dimensions, horn alignment and pulse-to-angle
mapping are illustrative and unmeasured. GPIO and gait commands come from the real
ESP8266 firmware. The last-known calibration profile is unverified. Only forward
walking is implemented; rightward drift remains unresolved. There is no measured
shaft position feedback. A preview shows commanded pulses, never actual leg pose.

## Local programs

Inspect hardware and Preview gait run offline. Connect keeps one authenticated TCP
session alive, reports real device status and DIAG commanded pulses, and stops after
the requested duration or cancellation. Status takes a short snapshot. Walk executes
a bounded forward queue with live heartbeat; cancellation sends STOP using that same
connection before closing. Only one capability per project may run at a time. Use the generic live-operation send tool to send JSONL controls to
the existing monitor: `{"type":"status"}`, `{"type":"walk","steps":1,"speed":100,"durationSeconds":30}`,
or `{"type":"stop"}`. These reuse its sole connection; input validation happens
in the saved program. Cancel exits the session and sends STOP. Do not run upstream
CLI tools in parallel.

The standalone Status capability is not passive: its cleanup sends STOP and
detaches servo outputs. Support the robot and authorize this physical operation
before running it. A status message sent to an existing monitor does not itself
send STOP, although ending that monitor does.

Create an untracked `.local/wifi.json` in your project, containing your local board's
`host` and `token` fields (optional `port`, default 8266). Alternatively set the
`SPIDEY_CONFIG` environment variable to a private file. Do not put credentials in the
project manifest, inputs, or source. Python 3 is required; this TCP program uses only
the standard library. Host networking must be on the board's private Wi-Fi network.
No physical device was connected during development.

STOP detaches servos and the robot needs physical support. The firmware also stops
when its 3 second heartbeat expires. A process being killed cannot guarantee an
acknowledged STOP during a network outage: inspect the actual board before use.

## Wiring and firmware

D5/GPIO14 → left servo; D6/GPIO12 → right servo; D7/GPIO13 → tilt servo.
BEC regulated 5 V supplies servo power; its ground MUST connect to NodeMCU ground.
USB powers the NodeMCU. Do not connect servo 5 V to GPIO or the LiPo to the MCU.
`firmware/src/main.cpp` is the actual upstream hexapod firmware. To build, privately
create `firmware/include/secrets.h` from the example and use PlatformIO in firmware/.
Native circuit source describes connectivity; it is not a production PCB layout.

### Command telemetry synchronization

The current firmware adds authenticated `SNAPSHOT`: one response contains a
monotonic sequence, device uptime, action/step/phase, enabled mask, running state
and all three commanded pulse widths. The cooperative main loop captures these
fields together; this reports command state, not measured shaft positions or
measured travel. A request is also the existing firmware heartbeat. Authentication,
calibration gates, three-second timeout and STOP/detachment behavior remain.

The adapter defaults to 2 Hz over its sole owned TCP connection for physical runs.
Use an explicit `telemetryHz: 2` input if an older private configuration saved a
higher rate. Replies have a two-second deadline, below the firmware's three-second
watchdog; timed-out commands are never resent automatically. A timeout ends the
operation and attempts STOP on that same connection. Optional
`telemetryHz` in the private connection configuration (or program input when
invoked directly) accepts 1–20 Hz. It timestamps receipt and supplies a freshness
window of at least 500 ms, enlarged for slower configured rates. Slow replies,
repeated/out-of-order sequence, backward clock, disconnect and shutdown invalidate
the command-pose override. The frontend also expires old snapshots when no further
events arrive. Device uptime wraps normally at 32 bits. Reconnect after a board
restart. The adapter probes once for `SNAPSHOT`; older firmware falls back to
`STATUS` + `DIAG` and labels those samples non-atomic. No extra connection is opened.

### Build validation

The firmware with atomic command snapshots passed a local `pio run` compile/link for `nodemcuv2` with
PlatformIO Core 6.1.18, pinned `espressif8266@4.2.1`, Arduino core 3.1.2 and Xtensa
GCC 10.3.0 on Windows/Python 3.12.10. RAM use was 30,260 / 81,920 bytes (36.9%);
program flash use was 293,435 / 1,044,464 bytes (28.1%). The SDK's Python `elf2bin.py`
emitted two non-fatal invalid-escape `SyntaxWarning`s; the build exited successfully.
Optional build tooling is pinned in `requirements-dev.txt` at the repository root.

Validation used an ignored throwaway copy with clearly dummy Wi-Fi/authentication
macros. No populated private secrets file was read or copied, and no board was
connected, flashed, monitored or actuated. All six fake TCP broker protocol tests
also passed. Compilation verifies toolchain compatibility; real credentials,
intentional flashing, wiring/power checks, supported-robot calibration and a
supervised physical test remain necessary before claiming hardware readiness.

## Provenance

Firmware, portable client, onboarding walk helper, hexapod README and calibration
profile copied from https://github.com/Rtx09x/cutie-circuits-spidey at commit
866e3d69e3a174723bb67af50babb4ab2d388da7. Full relevant native source is included;
upstream files retain their notices. The repository supplied no standalone license;
reuse is under the project owner's authorization, with no new license claim.
`programs/spidey.py` adapts the upstream protocol and heartbeat handling for a local
JSONL operation session. Original clients are retained under upstream/tools/.
The firmware PlatformIO include path is adjusted to this standalone directory.
