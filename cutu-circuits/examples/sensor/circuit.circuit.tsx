import React from 'react';
// Stable reference designators map to entity.metadata.circuitRef.
export default () => <board width="44mm" height="30mm">
  <chip name="U1" footprint="pinrow6" pinLabels={{pin1:'VCC',pin2:'GND',pin3:'A0',pin4:'D2',pin5:'TX',pin6:'RX'}} schX={-3} pcbX={-13} />
  <resistor name="LDR1" resistance="10k" footprint="0603" schX={2} schY={2} pcbX={8} pcbY={8} />
  <resistor name="R1" resistance="10k" footprint="0603" schX={2} schY={-2} pcbX={8} pcbY={3} />
  <resistor name="R2" resistance="330" footprint="0603" schX={5} pcbX={8} pcbY={-4} />
  <led name="LED1" footprint="0603" schX={8} pcbX={14} pcbY={-4} />
  <trace from=".U1 > .VCC" to=".LDR1 > .pin1" />
  <trace from=".LDR1 > .pin2" to=".R1 > .pin1" />
  <trace from=".U1 > .A0" to=".R1 > .pin1" />
  <trace from=".U1 > .GND" to=".R1 > .pin2" />
  <trace from=".U1 > .D2" to=".R2 > .pin1" />
  <trace from=".R2 > .pin2" to=".LED1 > .anode" />
  <trace from=".LED1 > .cathode" to=".U1 > .GND" />
</board>;
