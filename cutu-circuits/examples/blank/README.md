# New engineering project

Add native circuit, CAD, firmware, or program files and register them as project assets.
Capabilities launch saved local programs using a command and an argv array. Inputs are
validated with JSON Schema and sent as one JSON stdin line. Each `{{inputName}}`
replacement remains one argument. Programs may emit JSON Lines telemetry. Persistent programs keep stdin open for
project-defined JSON control records sent through the operation send tool. Cancel
sends `{"type":"cancel"}` before terminating the process tree. One program
at a time owns a project's hardware; cancellation terminates its process tree. Trusted
project programs have your OS access. This is an execution environment, not a sandbox.
