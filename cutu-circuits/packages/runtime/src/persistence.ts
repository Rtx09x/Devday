import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CutuError, type FileHistoryEntry } from "@cutucircuits/core";
import { safeRelative } from "./validation.js";

export const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const isMissing = (e: unknown) =>
  (e as NodeJS.ErrnoException).code === "ENOENT";
export async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
  } catch (e) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "EISDIR"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    )
      return;
    throw e;
  }
  try {
    await handle.sync();
  } catch (e) {
    // Windows and some filesystems cannot fsync a directory. File contents still
    // use fsync; rename durability across power loss depends on that filesystem.
    if (
      !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw e;
  } finally {
    await handle.close();
  }
}

/** Private files never pass through the native file API. IDs are generated here,
 * every existing component is checked, and reads refuse symbolic links. */
export class PrivateStorage {
  constructor(private root: () => Promise<string>) {}
  async directory(name: string, create = false) {
    if (!/^\.cutucircuits-[a-z-]+$/.test(name))
      throw new Error("Invalid private directory");
    const root = await this.root();
    const directory = path.join(root, name);
    if (create) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        await syncDirectory(root);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new CutuError(
        "INVALID_PATH",
        "Private storage must be a directory without symbolic links",
      );
    return directory;
  }
  async names(name: string) {
    try {
      return await fs.readdir(await this.directory(name));
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
  }
  async read(name: string, id: string): Promise<any> {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(id))
      throw new CutuError("INVALID_INPUT", "Invalid private record ID");
    const filename = path.join(await this.directory(name), id);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new CutuError(
        "INVALID_PATH",
        "Private records must be regular files",
      );
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  async put(name: string, id: string, value: unknown) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(id))
      throw new CutuError("INVALID_INPUT", "Invalid private record ID");
    const directory = await this.directory(name, true);
    const temp = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.directory(name);
      // Link publishes without replacing an existing immutable record.
      try {
        await fs.link(temp, path.join(directory, id));
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== "EEXIST" ||
          JSON.stringify(await this.read(name, id)) !== JSON.stringify(value)
        )
          throw e;
      }
      await syncDirectory(directory);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async remove(name: string, id: string) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(id))
      throw new CutuError("INVALID_INPUT", "Invalid private record ID");
    const directory = await this.directory(name);
    await fs.unlink(path.join(directory, id));
    await syncDirectory(directory);
  }
  async version(
    id: string,
  ): Promise<{ entry: FileHistoryEntry; bytes: Buffer }> {
    const stored = await this.read(".cutucircuits-history", `${id}.json`);
    const entry = stored.entry as FileHistoryEntry;
    if (
      !entry ||
      entry.id !== id ||
      !/^[a-zA-Z0-9_-]+$/.test(id) ||
      typeof stored.base64 !== "string"
    )
      throw new CutuError("INVALID_HISTORY", "Invalid history record");
    safeRelative(entry.path);
    const bytes = Buffer.from(stored.base64, "base64");
    if (
      entry.sha256 !== hash(bytes) ||
      entry.sizeBytes !== bytes.length ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      !["baseline", "save", "external", "restore", "recovery"].includes(
        entry.reason,
      )
    )
      throw new CutuError(
        "INVALID_HISTORY",
        "History record failed integrity validation",
      );
    return { entry, bytes };
  }
  async entries(relative?: string): Promise<FileHistoryEntry[]> {
    const entries: FileHistoryEntry[] = [];
    for (const name of await this.names(".cutucircuits-history")) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const { entry } = await this.version(name.slice(0, -5));
      if (relative === undefined || entry.path === relative)
        entries.push(entry);
    }
    return entries.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }
  async record(
    relative: string,
    bytes: Buffer,
    reason: FileHistoryEntry["reason"],
    observed = false,
  ) {
    safeRelative(relative);
    const previous = (await this.entries(relative))[0];
    if (observed && previous?.sha256 === hash(bytes)) return previous;
    const entry: FileHistoryEntry = {
      id: randomUUID(),
      path: relative,
      sha256: hash(bytes),
      createdAt: new Date().toISOString(),
      sizeBytes: bytes.length,
      reason: observed && !previous ? "baseline" : reason,
    };
    // ISO time has millisecond precision. Keep a deterministic newest-first order
    // for successive versions even when several writes finish in one millisecond.
    if (previous && entry.createdAt <= previous.createdAt)
      entry.createdAt = new Date(
        Date.parse(previous.createdAt) + 1,
      ).toISOString();
    await this.put(".cutucircuits-history", `${entry.id}.json`, {
      entry,
      base64: bytes.toString("base64"),
    });
    return entry;
  }
}

export interface SaveTransaction {
  version: 1;
  id: string;
  path: string;
  beforeSourceBase64: string | null;
  afterSourceBase64: string;
  beforeManifestBase64: string;
  afterManifestBase64: string;
  reason: "save" | "restore";
}
