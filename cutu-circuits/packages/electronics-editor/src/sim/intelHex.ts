/**
 * Intel HEX loader
 *
 * avr8js and rp2040js execute a flat program image, but compiled firmware ships
 * as Intel HEX (`.hex`). This parses that text format into a byte buffer the
 * emulators can load. Small, dependency-free, and tolerant of the records we
 * care about (data + extended-linear-address + EOF).
 */

export interface HexImage {
  /** Program bytes, base address normalised to 0. */
  bytes: Uint8Array;
  /** Highest written address + 1. */
  size: number;
}

/** Parse Intel HEX text into a contiguous byte image starting at address 0. */
export function parseIntelHex(hex: string, capacity = 0x40000): HexImage {
  const bytes = new Uint8Array(capacity);
  let highest = 0;
  let baseAddress = 0;

  for (const rawLine of hex.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== ':') continue;
    const byteCount = parseInt(line.substr(1, 2), 16);
    const address = parseInt(line.substr(3, 4), 16);
    const recordType = parseInt(line.substr(7, 2), 16);

    if (recordType === 0) {
      // Data record.
      const addr = baseAddress + address;
      for (let i = 0; i < byteCount; i++) {
        const b = parseInt(line.substr(9 + i * 2, 2), 16);
        const target = addr + i;
        if (target < capacity) {
          bytes[target] = b;
          if (target + 1 > highest) highest = target + 1;
        }
      }
    } else if (recordType === 1) {
      // End of file.
      break;
    } else if (recordType === 4) {
      // Extended linear address: upper 16 bits of subsequent addresses.
      baseAddress = parseInt(line.substr(9, 4), 16) << 16;
    } else if (recordType === 2) {
      // Extended segment address.
      baseAddress = parseInt(line.substr(9, 4), 16) << 4;
    }
    // Other record types (3, 5) are start-address hints; ignore.
  }
  return { bytes, size: highest };
}

/** Does this text look like Intel HEX (vs. a file path)? */
export function looksLikeHex(text: string): boolean {
  const t = text.trim();
  return t.startsWith(':') && /^[:0-9a-fA-F\r\n\s]+$/.test(t.slice(0, 200));
}
