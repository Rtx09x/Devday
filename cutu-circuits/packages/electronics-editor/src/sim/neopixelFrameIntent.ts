import type { PeripheralEvent, SimResult } from './types.ts';

export const AVR_NEOPIXEL_FRAME_EXPECTED_GRB = [0x20, 0x10, 0x40] as const;
export const AVR_NEOPIXEL_FRAME_EXPECTED_START_CYCLE = 10;
export const AVR_NEOPIXEL_FRAME_EXPECTED_END_CYCLE = 351;
export const AVR_NEOPIXEL_ZERO_HIGH_CYCLES = 3;
export const AVR_NEOPIXEL_ONE_HIGH_CYCLES = 6;

export type NeoPixelFrameIntentEvent = Extract<PeripheralEvent, { kind: 'neopixel-frame-intent' }>;

export function canonicalNeoPixelFrameBytes(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Decode only the exact bundled fixture's deterministic D6 pulse sequence.
 * This is modeled-cycle byte intent, not a general WS2812 decoder or waveform.
 */
export function deriveNeoPixelFrameIntentEvent(result: SimResult | null | undefined): NeoPixelFrameIntentEvent | undefined {
  if (!result?.ok || result.engine !== 'avr8js' || result.firmwareFixture?.id !== 'avr-neopixel-frame-intent') return undefined;
  const traces = result.traces.filter((trace) => trace.name === 'D6');
  if (traces.length !== 1) return undefined;
  const trace = traces[0];
  const cycles = trace.timing?.domain === 'emulator-cycles' ? trace.timing.sampleCycles : undefined;
  if (trace.unit !== 'digital' || !cycles || cycles.length !== trace.v.length
    || trace.v.some((level) => level !== 0 && level !== 1)
    || cycles.some((cycle, index) => !Number.isSafeInteger(cycle) || cycle < 0
      || (index > 0 && cycle <= cycles[index - 1]))) return undefined;

  const transitions: Array<{ cycle: number; level: 0 | 1 }> = [];
  trace.v.forEach((rawLevel, index) => {
    if (index > 0 && rawLevel === trace.v[index - 1]) return;
    transitions.push({ cycle: cycles[index], level: rawLevel as 0 | 1 });
  });
  if (transitions.length !== 50
    || transitions[0].cycle !== 0 || transitions[0].level !== 1
    || transitions[1].cycle !== 1 || transitions[1].level !== 0) return undefined;

  const pulses = transitions.slice(2);
  const highCycles: number[] = [];
  for (let index = 0; index < pulses.length; index += 2) {
    const rise = pulses[index];
    const fall = pulses[index + 1];
    if (!rise || !fall || rise.level !== 1 || fall.level !== 0 || fall.cycle <= rise.cycle) return undefined;
    const width = fall.cycle - rise.cycle;
    if (width !== AVR_NEOPIXEL_ZERO_HIGH_CYCLES && width !== AVR_NEOPIXEL_ONE_HIGH_CYCLES) return undefined;
    highCycles.push(width);
  }
  if (highCycles.length !== 24) return undefined;
  const bytes = [0, 0, 0] as [number, number, number];
  highCycles.forEach((width, index) => {
    bytes[Math.floor(index / 8)] = (bytes[Math.floor(index / 8)] << 1)
      | (width === AVR_NEOPIXEL_ONE_HIGH_CYCLES ? 1 : 0);
  });
  if (bytes.some((byte, index) => byte !== AVR_NEOPIXEL_FRAME_EXPECTED_GRB[index])) return undefined;
  const frameStartCycle = pulses[0].cycle;
  const frameEndCycle = pulses[pulses.length - 1].cycle;
  if (frameStartCycle !== AVR_NEOPIXEL_FRAME_EXPECTED_START_CYCLE
    || frameEndCycle !== AVR_NEOPIXEL_FRAME_EXPECTED_END_CYCLE) return undefined;
  return {
    kind: 'neopixel-frame-intent', controller: 'GPIOD6', colorOrder: 'GRB', bytes,
    bitCount: 24, frameStartCycle, frameEndCycle,
    zeroHighCycles: AVR_NEOPIXEL_ZERO_HIGH_CYCLES,
    oneHighCycles: AVR_NEOPIXEL_ONE_HIGH_CYCLES,
    highCycles,
    decode: 'fixture-exact-modeled-high-cycles',
  };
}
