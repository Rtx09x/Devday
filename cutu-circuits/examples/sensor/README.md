# Light sensor enclosure

A general hardware project: a 3.3 V microcontroller reads a photoresistor divider
on A0 and drives LED1 through R2 on D2. Native circuit and Replicad files are editable.
Geometry is illustrative, not a component fit or manufacturing verification.

`Inspect design` reads saved files offline. `Read serial device` opens the explicit
local serial port and consumes actual JSON objects emitted by your board. Install
`pyserial` in your local Python environment first. No synthetic sensor readings are
reported. Adjust programs/controller.py for your board's protocol, or add another
saved program and capability with its own JSON Schema. Stop cancels the process.
