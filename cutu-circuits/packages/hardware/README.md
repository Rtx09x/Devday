# Local program execution

`HardwareRunner` executes a capability's saved command with an argv array in the
project directory. No shell is involved. `{{inputName}}` placeholders accept scalar
inputs and preserve argument boundaries. Ajv validates the manifest's JSON Schema
before spawn; initial inputs arrive as one JSON stdin line. This is trusted local
code with the user's OS permissions, not an execution sandbox or fixed device list.

One running program owns each project to avoid competing connections. Stdout and
stderr are each bounded to 64 KiB, with the combined saved output retaining its
last 64 KiB. Stdout JSON objects update the operation's latest telemetry. Emit
`source` and clearly distinguish observed values, commanded values and previews.
The runner returns operation snapshots and publishes updates for runtime storage.

Persistent capabilities keep stdin open. `send(operationId, message)` writes a
project-defined JSON control record (max 16 KiB) to the same process. A saved
program defines its own control validation/protocol; the environment imposes no
device-specific command vocabulary. Secret-named string inputs and control values
are redacted from output; secret telemetry fields are also redacted. Keep actual
credentials in private local files/environment and never print them.

Cancel sends `{"type":"cancel"}` to persistent programs, then terminates the
process group after a grace period and escalates to a forced tree kill. POSIX
adapters can also trap SIGTERM; Windows uses the control record before taskkill.
Timeouts use the same cleanup path and mark the operation failed. Device programs
must issue a real protocol stop before exiting. The Makada example does so on its
existing single connection and relies on the MCU heartbeat failsafe during network
loss. No process manager can assert that an unreachable physical device stopped.

Run subprocess tests with `tsx --test packages/hardware/tests/runner.test.ts`.
Run the Makada fake-server protocol tests with
`python3 -m unittest discover -s examples/spidey/tests -v`. They exercise local
processes and TCP sockets, with no physical hardware connection.
