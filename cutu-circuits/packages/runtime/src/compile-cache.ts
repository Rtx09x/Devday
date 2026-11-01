/** Per-runtime successful CAD results, bounded by serialized size and entry count. */
export function createCompileCache<T>(maxEntries = 8, maxBytes = 64 * 1024 * 1024) {
  const entries = new Map<string, { promise: Promise<T>; bytes: number }>();
  let total = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) { total -= entry.bytes; entries.delete(key); }
  };
  return {
    async get(key: string, compile: () => Promise<T>, force = false): Promise<T> {
      if (force) remove(key);
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key); entries.set(key, existing);
        return existing.promise;
      }
      const entry = { promise: Promise.resolve().then(compile), bytes: 0 };
      entries.set(key, entry);
      while (entries.size > maxEntries) remove(entries.keys().next().value!);
      try {
        const value = await entry.promise;
        // A force refresh or eviction can have superseded this request.
        if (entries.get(key) === entry) {
          let size: number;
          try { size = Buffer.byteLength(JSON.stringify(value), "utf8"); }
          catch { remove(key); return value; }
          if (size > maxBytes) remove(key);
          else {
            entry.bytes = size; total += size;
            while (total > maxBytes) remove(entries.keys().next().value!);
          }
        }
        return value;
      } catch (error) {
        if (entries.get(key) === entry) remove(key);
        throw error;
      }
    },
  };
}

/** Invalid/unsupported parameter shapes are not cacheable. */
export function cadCacheKey(projectId: string, path: string, sourceSha: string, parameters: unknown): string | undefined {
  if (parameters !== undefined && (!parameters || typeof parameters !== "object" || Array.isArray(parameters))) return undefined;
  const pairs = Object.entries(parameters ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (pairs.some(([, value]) => !(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))) return undefined;
  return JSON.stringify(["cad", projectId, path, sourceSha, pairs]);
}
