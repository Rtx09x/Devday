import React from 'react';
// Logical connectivity reference, not a manufactured PCB or physical NodeMCU footprint.
// MCU uses six logical ports here; the assembly models all 30 physical NodeMCU 1.0
// pins. D5=GPIO14 (right header 8), D6=GPIO12 (9), D7=GPIO13 (10),
// antenna-up / USB-down. Servo power comes only from the external regulated BEC.
export default () => <board width="60mm" height="44mm">
  <chip name="MCU" footprint="pinrow6" pinLabels={{pin1:'D5',pin2:'D6',pin3:'D7',pin4:'GND',pin5:'3V3',pin6:'USB5V'}} schX={-4} pcbX={-20} />
  <chip name="BEC" footprint="pinrow2" pinLabels={{pin1:'V5',pin2:'GND'}} schX={0} schY={4} pcbX={0} pcbY={14} />
  <chip name="LEFT" footprint="pinrow3" pinLabels={{pin1:'SIG',pin2:'V5',pin3:'GND'}} schX={4} schY={3} pcbX={18} pcbY={12} />
  <chip name="RIGHT" footprint="pinrow3" pinLabels={{pin1:'SIG',pin2:'V5',pin3:'GND'}} schX={4} schY={0} pcbX={18} pcbY={0} />
  <chip name="TILT" footprint="pinrow3" pinLabels={{pin1:'SIG',pin2:'V5',pin3:'GND'}} schX={4} schY={-3} pcbX={18} pcbY={-12} />
  <trace from=".MCU > .D5" to=".LEFT > .SIG" />
  <trace from=".MCU > .D6" to=".RIGHT > .SIG" />
  <trace from=".MCU > .D7" to=".TILT > .SIG" />
  <trace from=".MCU > .GND" to=".BEC > .GND" />
  <trace from=".BEC > .GND" to=".LEFT > .GND" />
  <trace from=".BEC > .GND" to=".RIGHT > .GND" />
  <trace from=".BEC > .GND" to=".TILT > .GND" />
  <trace from=".BEC > .V5" to=".LEFT > .V5" />
  <trace from=".BEC > .V5" to=".RIGHT > .V5" />
  <trace from=".BEC > .V5" to=".TILT > .V5" />
</board>;
