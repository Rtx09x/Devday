// POSIX-only path helpers. The host normalizes every path it hands us to forward
// slashes, and the kernel worker's virtual FS is POSIX, so we never deal with
// Windows separators here — keeping this module free of Node's `path` lets it run
// unchanged in the worker bundle.
const SEP = '/';

function splitPath(input: string): string[] {
  return input.split('/').filter((segment) => segment.length > 0);
}

export function isAbsolute(input: string): boolean {
  return input.startsWith(SEP);
}

export function normalize(input: string): string {
  if (!input) return '.';
  const absolute = isAbsolute(input);
  const parts: string[] = [];

  for (const segment of splitPath(input)) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!absolute) {
        parts.push('..');
      }
      continue;
    }
    parts.push(segment);
  }

  if (absolute) {
    return parts.length > 0 ? `${SEP}${parts.join(SEP)}` : SEP;
  }
  return parts.length > 0 ? parts.join(SEP) : '.';
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join(SEP));
}

export function dirname(input: string): string {
  const normalized = normalize(input);
  if (normalized === SEP) return SEP;
  const index = normalized.lastIndexOf(SEP);
  if (index <= 0) return index === 0 ? SEP : '.';
  return normalized.slice(0, index);
}

export function basename(input: string, suffix?: string): string {
  const normalized = normalize(input);
  const parts = splitPath(normalized);
  const name = parts[parts.length - 1] ?? normalized;
  if (suffix && name.endsWith(suffix)) {
    return name.slice(0, -suffix.length);
  }
  return name;
}

export function resolve(...parts: string[]): string {
  let current = '.';
  for (const part of parts) {
    if (!part) continue;
    current = isAbsolute(part) ? part : join(current, part);
  }
  return normalize(current);
}

export function relative(from: string, to: string): string {
  const fromParts = splitPath(normalize(from));
  const toParts = splitPath(normalize(to));

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const up = fromParts.map(() => '..');
  return [...up, ...toParts].join(SEP) || '.';
}
