# Spidey firmware protocol

Build/upload this directory. See the [main guide](../README.md) for wiring,
credentials, migration, demo commands and known limits.

## Forward cycle

D5/GPIO14 = joint 1 left sweep; D6/GPIO12 = joint 2 right sweep;
D7/GPIO13 = joint 3 tilt. The current gait has eight phases:

1. D7 center +140 µs, capped at its saved maximum.
2. D6 saved maximum, forward.
3. D7 center.
4. D5 saved maximum, backward.
5. D7 center -160 µs, capped at its saved minimum.
6. D5 saved minimum, forward.
7. D7 center.
8. D6 saved minimum, backward.

One joint changes target per phase while the attached servos retain their signals.
Each transition interpolates from its last commanded position, then pauses.
Only forward is implemented; RUN rejects actions other than left=100/right=100.
Rightward drift is unresolved. Pulse boundaries do not prove mechanical clearance.

## Authenticated TCP

Port 8266, ASCII lines, first `AUTH <private token>`. One client at a time, no TLS.

| Command | Result |
|---|---|
| `STATUS` | Enabled mask, running, queue/action/step/phase and IP |
| `DIAG` | Uptime/reset/Wi-Fi/heap, requested and library-stored pulses |
| `CONFIG` | Three calibration records followed by `OK CONFIG` |
| `PING` | Renew three-second heartbeat |
| `STOP` | Stop motion, detach all signals, drive pins LOW |
| `ENABLE n` / `ENABLE ALL` | Attach at saved center; immediate physical movement possible |
| `DISABLE n` | Detach one servo unless autonomous motion is running |
| `JOG n offset` | Target = saved center + offset, not current angle + offset |
| `TIMING` | Read saved movement and pause milliseconds |
| `TIMING move_ms settle_ms` | Save timing while all signals are detached |
| `LIMIT n low high` | Save pulse boundaries, detached only |
| `TRIM n center` | Change center retaining limits/sign/amplitude, detached only |
| `CAL n center sign amplitude` | Save calibration, detached only |
| `CLEAR` | Clear RAM queue while not running |
| `ADD left right steps speed` | Queue 1–20 cycles at speed 1–100 |
| `RUN` | Execute when all three servos are enabled and signs are configured |

Queue maximum: 16 actions, 30 total cycles. Completion emits unsolicited `DONE`
and stops outputs. The supported Python client drains DONE separately from replies.

Pulse limits must be within 900–2100 µs and contain the center and symmetric
calibration amplitude. Sign is -1/+1. The amplitude/sign fields remain for record
validation; the current gait uses endpoints explicitly. Out-of-range JOG is rejected;
gait targets are clamped. JOG checks the library's stored pulse value after writing.
That is not a measurement of the GPIO waveform, shaft position, current or stall.

Movement time is 20–60000 ms, pause 0–60000 ms. Speed 100 uses the configured
movement time; lower speeds stretch it toward 8000 ms, retaining a duration that
is already longer. Pause stays unchanged. A 20 ms motion loop quantizes timing
upward; 25/25 does not yield an exact 50 ms phase. Phase initialization also takes
an update interval. Physical servos may not reach targets at extreme settings.

## Persistence and stopping

Boot leaves outputs LOW with no pulses. Calibration and timing have separate
EEPROM records and survive normal upload/reboot; queued actions do not.
Signals stop on STOP, completion, detected Wi-Fi loss or three seconds without
an authenticated command. STATUS/PING renew the heartbeat. Closing TCP does not
immediately stop; use the supported runner's cleanup or wait for timeout.
A frozen MCU or electrical fault may defeat software stops. Power cutoff remains
necessary if something jams. Detached servos may relax; re-enable commands center.

Diagnostic values while disabled may retain old library values or initial defaults;
they do not represent measured position. The supplied profile is a last-known chat
record. Prefer a live `setup_robot.py snapshot` before changing calibration.
