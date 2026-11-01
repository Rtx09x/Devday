/**
 * RP2040 firmware emulation (rp2040js)
 *
 * Runs Raspberry Pi Pico / RP2040 firmware (Cortex-M0+) in pure JS. Firmware for
 * the Pico normally ships as UF2; we parse that (or a raw .bin) into the
 * emulator's flash, point the core at the reset vector, and step. UART0 bytes
 * become serial lines and GPIO transitions become digital traces.
 *
 * Note: a faithful Pico boot needs the RP2040 boot ROM, which rp2040js does not
 * bundle. This local-first runner deliberately does not fetch it; instead it
 * boots straight from the flash vector table. That supports suitable bare-metal
 * images but is not a claim of full Pico board or peripheral simulation.
 */

import { GPIOPinState, RP2040 } from 'rp2040js';
import type { SerialLine, SimTrace } from './types';

const FLASH_BASE = 0x10000000;
const WALL_CLOCK_CAP_MS = 4000;
const CLK_HZ = 125_000_000; // default Pico system clock

export interface Rp2040RunResult {
  traces: SimTrace[];
  serial: SerialLine[];
  simulatedMs: number;
  cycles: number;
  hitCap: boolean;
  bootromLoaded: boolean;
}

/** Parse a UF2 file (base64 or binary) into a flat flash image + base offset. */
export function parseUf2(data: Uint8Array): { image: Uint8Array; baseOffset: number } {
  const BLOCK = 512;
  const MAGIC0 = 0x0a324655;
  const MAGIC1 = 0x9e5d5157;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let minAddr = Infinity;
  let maxAddr = 0;
  const chunks: Array<{ addr: number; bytes: Uint8Array }> = [];
  for (let off = 0; off + BLOCK <= data.length; off += BLOCK) {
    if (view.getUint32(off, true) !== MAGIC0 || view.getUint32(off + 4, true) !== MAGIC1) continue;
    const addr = view.getUint32(off + 12, true);
    const payloadSize = view.getUint32(off + 16, true);
    const bytes = data.subarray(off + 32, off + 32 + payloadSize);
    chunks.push({ addr, bytes });
    minAddr = Math.min(minAddr, addr);
    maxAddr = Math.max(maxAddr, addr + payloadSize);
  }
  if (!chunks.length) {
    // Not UF2 -- treat the whole buffer as a raw flash image.
    return { image: data, baseOffset: 0 };
  }
  const image = new Uint8Array(maxAddr - minAddr);
  for (const c of chunks) image.set(c.bytes, c.addr - minAddr);
  return { image, baseOffset: Math.max(0, minAddr - FLASH_BASE) };
}

/** Decode firmware text that may be base64 or already-binary. */
export function decodeFirmware(text: string): Uint8Array {
  const trimmed = text.trim();
  // Base64 heuristic.
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length % 4 < 2) {
    try {
      const bin = atob(trimmed.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      /* fall through */
    }
  }
  const enc = new TextEncoder();
  return enc.encode(text);
}

export async function runRp2040Firmware(firmware: Uint8Array, durationMs: number): Promise<Rp2040RunResult> {
  const mcu = new RP2040();
  const bootromLoaded = false;

  const { image, baseOffset } = parseUf2(firmware);
  mcu.flash.set(image.subarray(0, mcu.flash.length - baseOffset), baseOffset);

  // Boot directly from the flash vector table: [0]=initial SP, [4]=reset vec.
  // This path is deliberately local-only and never attempts a boot-ROM fetch.
  const resetVector = mcu.readUint32(FLASH_BASE + 4);
  mcu.core.SP = mcu.readUint32(FLASH_BASE);
  mcu.core.PC = resetVector & ~1;

  // --- Serial capture (UART0) ---
  const serial: SerialLine[] = [];
  let lineBuf = '';
  if (mcu.uart[0]) {
    mcu.uart[0].onByte = (value: number) => {
      const ch = String.fromCharCode(value);
      const t = mcu.core.cycles / (CLK_HZ / 1000);
      if (ch === '\n') {
        serial.push({ t, text: lineBuf });
        lineBuf = '';
      } else if (ch !== '\r') {
        lineBuf += ch;
      }
    };
  }

  // --- GPIO output capture ---
  // rp2040.gpioValues is the input register, so polling it would miss SIO output
  // activity. GPIOPin listeners expose the emulator's resolved driven state.
  const pinSamples = new Map<number, { t: number[]; v: number[] }>();
  const lastDriven = new Map<number, number>();
  for (let pin = 0; pin < mcu.gpio.length; pin++) {
    mcu.gpio[pin].addListener((state) => {
      if (state !== GPIOPinState.Low && state !== GPIOPinState.High) return;
      const level = state === GPIOPinState.High ? 1 : 0;
      const previous = lastDriven.get(pin);
      lastDriven.set(pin, level);
      if (previous == null || previous === level) return;
      let samples = pinSamples.get(pin);
      if (!samples) {
        samples = { t: [0], v: [previous] };
        pinSamples.set(pin, samples);
      }
      samples.t.push(mcu.core.cycles / CLK_HZ);
      samples.v.push(level);
    });
  }

  // --- Execution loop ---
  const targetCycles = Math.round((durationMs / 1000) * CLK_HZ);
  const wallStart = performance.now();
  let hitCap = false;

  while (mcu.core.cycles < targetCycles) {
    mcu.step();
    if ((mcu.core.cycles & 0x3fff) === 0) {
      if (performance.now() - wallStart > WALL_CLOCK_CAP_MS) {
        hitCap = true;
        break;
      }
    }
  }

  const simulatedMs = mcu.core.cycles / (CLK_HZ / 1000);
  if (lineBuf) serial.push({ t: simulatedMs, text: lineBuf });

  const traces: SimTrace[] = [];
  for (const [pin, s] of pinSamples) {
    const endT = simulatedMs / 1000;
    if (s.t[s.t.length - 1] < endT) {
      s.t.push(endT);
      s.v.push(s.v[s.v.length - 1]);
    }
    traces.push({
      name: `GP${pin}`,
      unit: 'digital',
      t: s.t,
      v: s.v,
      origin: { family: 'rp2040', pin, aliases: [`GP${pin}`, `GPIO${pin}`] },
    });
  }

  return { traces, serial, simulatedMs, cycles: mcu.core.cycles, hitCap, bootromLoaded };
}
