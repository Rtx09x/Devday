import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  CutuError,
  PROJECT_FILE,
  type Project,
  type Asset,
  type ProjectSummary,
  type FileSnapshot,
  type FileHistoryEntry,
  type FileHistoryVersion,
  type Selection,
} from "@cutucircuits/core";
import { EventHub } from "./events.js";
import {
  PrivateStorage,
  syncDirectory,
  type SaveTransaction,
} from "./persistence.js";
import {
  safeRelative,
  validateProject,
  validateSelectionInput,
} from "./validation.js";
export const sha256 = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export interface StoreOptions {
  dataDir: string;
  templatesDir?: string;
  seed?: boolean;
  pollIntervalMs?: number;
}
export class ProjectStore {
  readonly dataDir: string;
  readonly events = new EventHub();
  private queues = new Map<string, Promise<unknown>>();
  private fingerprints = new Map<string, Map<string, string>>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private closed = false;
  constructor(readonly options: StoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    // Inspect pending journals before reading manifests: an interrupted commit may
    // coexist with a malformed manifest written by a non-cooperating tool.
    for (const entry of await fs.readdir(this.dataDir, { withFileTypes: true }))
      if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
        await this.recover(entry.name);
    if (this.options.seed !== false && !(await this.list()).length) {
      await this.create("Makada", "spidey");
      await this.create("Sensor board", "sensor");
    }
    for (const p of await this.list()) {
      const files = await this.scan(p.id);
      this.fingerprints.set(p.id, files);
      for (const relative of files.keys()) await this.observe(p.id, relative);
    }
    if (this.options.pollIntervalMs !== 0) {
      this.timer = setInterval(() => {
        void this.poll().catch(() => {});
      }, this.options.pollIntervalMs ?? 750);
      this.timer.unref();
    }
    return this;
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.queues.values()]);
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(action);
    this.queues.set(id, task);
    void task
      .finally(() => {
        if (this.queues.get(id) === task) this.queues.delete(id);
      })
      .catch(() => {});
    return task;
  }
  root(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new CutuError("INVALID_PROJECT_ID", "Invalid project ID");
    return path.join(this.dataDir, id);
  }
  async resolveFile(id: string, relative: string, allowMissing = false) {
    safeRelative(relative);
    const root = this.root(id);
    const rootStat = await fs.lstat(root).catch((e) => {
      if (missing(e))
        throw new CutuError("NOT_FOUND", "Project not found", 404);
      throw e;
    });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new CutuError("INVALID_PATH", "Project root must be a directory");
    let current = root;
    for (const [index, part] of relative.split("/").entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((e) => {
        if (allowMissing && missing(e)) return null;
        throw e;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink())
        throw new CutuError("INVALID_PATH", "Symbolic links are not allowed");
      if (index < relative.split("/").length - 1 && !stat.isDirectory())
        throw new CutuError("INVALID_PATH", "Path parent is not a directory");
    }
    return current;
  }
  private storage(id: string) {
    return new PrivateStorage(async () => {
      await this.resolveFile(id, PROJECT_FILE, true);
      return this.root(id);
    });
  }
  private async loadProject(id: string) {
    try {
      const filename = await this.resolveFile(id, PROJECT_FILE);
      const bytes = await fs.readFile(filename);
      const p = validateProject(JSON.parse(bytes.toString("utf8")));
      if (p.id !== id)
        throw new CutuError(
          "INVALID_PROJECT",
          "Project identity does not match directory",
        );
      return { project: p, bytes };
    } catch (e) {
      if (missing(e))
        throw new CutuError("NOT_FOUND", "Project not found", 404);
      throw e;
    }
  }
  async get(id: string): Promise<Project> {
    return (await this.loadProject(id)).project;
  }
  async list(): Promise<ProjectSummary[]> {
    const entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    const projects: Project[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      try {
        projects.push(await this.get(e.name));
      } catch {
        /* Invalid external directories are not exposed as projects. */
      }
    }
    return projects
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        revision: p.revision,
        updatedAt: p.updatedAt,
        entityCount: p.entities.length,
        assetCount: p.assets.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  private async atomic(
    filename: string,
    content: string,
    beforeCommit?: () => Promise<void>,
  ) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temp = path.join(
      path.dirname(filename),
      `.cutucircuits-${randomUUID()}.tmp`,
    );
    try {
      let mode = 0o600;
      try {
        mode = (await fs.stat(filename)).mode & 0o777;
      } catch (e) {
        if (!missing(e)) throw e;
      }
      const handle = await fs.open(temp, "wx", mode);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Check after writing/syncing the temporary file, immediately before replacement.
      // This narrows (but cannot eliminate) races with non-cooperating terminal writers.
      for (let attempt = 0; ; attempt++) {
        await beforeCommit?.();
        try {
          await fs.rename(temp, filename);
          break;
        } catch (error) {
          // Windows scanners/readers can briefly deny replacement of an existing
          // file. Keep the atomic rename and recheck CAS before each bounded retry.
          if (
            process.platform !== "win32" ||
            !["EPERM", "EACCES", "EBUSY"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            ) ||
            attempt >= 5
          ) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
      await syncDirectory(path.dirname(filename));
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async create(name: string, template = "blank") {
    if (typeof name !== "string" || !name.trim() || name.length > 200)
      throw new CutuError("INVALID_INPUT", "A project name is required");
    if (!["blank", "spidey", "sensor", "robot"].includes(template))
      throw new CutuError("INVALID_INPUT", "Unknown template");
    const id = randomUUID();
    const root = this.root(id);
    const templates =
      this.options.templatesDir ??
      path.resolve(import.meta.dirname, "../../../examples");
    const source = path.join(templates, template);
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
      throw new CutuError("INVALID_TEMPLATE", "Invalid template");
    await fs.mkdir(root);
    try {
      await fs.cp(source, root, {
        recursive: true,
        filter: async (src) => {
          if ((await fs.lstat(src)).isSymbolicLink())
            throw new CutuError(
              "INVALID_TEMPLATE",
              "Template contains symbolic links",
            );
          return true;
        },
      });
      const p = JSON.parse(
        await fs.readFile(path.join(root, PROJECT_FILE), "utf8"),
      );
      const now = new Date().toISOString();
      Object.assign(p, {
        id,
        name: name.trim(),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });
      const project = validateProject(p);
      await this.atomic(
        path.join(root, PROJECT_FILE),
        JSON.stringify(project, null, 2) + "\n",
      );
      this.fingerprints.set(id, await this.scan(id));
      return project;
    } catch (e) {
      await fs.rm(root, { recursive: true, force: true });
      throw e;
    }
  }
  async patch(id: string, expectedRevision: unknown, changes: unknown) {
    return this.serial(id, async () => {
      await this.recover(id);
      const { project: p, bytes: manifestBytes } = await this.loadProject(id);
      if (expectedRevision !== p.revision)
        throw new CutuError(
          "REVISION_CONFLICT",
          "Project revision has changed",
          409,
        );
      if (!changes || typeof changes !== "object" || Array.isArray(changes))
        throw new CutuError("INVALID_INPUT", "Changes must be an object");
      for (const key of Object.keys(changes))
        if (
          ["id", "version", "revision", "createdAt", "updatedAt"].includes(key)
        )
          throw new CutuError("IMMUTABLE_FIELD", `Cannot change ${key}`);
      const next = validateProject({
        ...p,
        ...changes,
        revision: p.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      for (const a of next.assets) await this.resolveFile(id, a.path, true);
      const selection = await this.selection(id);
      await this.persist(next, manifestBytes);
      if (
        (selection.entityId &&
          !next.entities.some((e) => e.id === selection.entityId)) ||
        (selection.assetId &&
          !next.assets.some((a) => a.id === selection.assetId))
      ) {
        const cleared: Selection = {
          entityId: null,
          origin: selection.origin,
          updatedAt: new Date().toISOString(),
        };
        await this.atomic(
          path.join(this.root(id), ".cutucircuits-selection.json"),
          JSON.stringify(cleared),
        );
        this.events.publish(id, "selection.updated", cleared);
      }
      return next;
    });
  }
  private async manifestGuard(id: string, expected: Buffer, attempted: string) {
    const filename = await this.resolveFile(id, PROJECT_FILE);
    const current = await fs.readFile(filename);
    if (sha256(current) === sha256(expected)) return;
    const storage = this.storage(id);
    await storage.record(PROJECT_FILE, expected, "external", true);
    await storage.record(PROJECT_FILE, current, "external", true);
    await storage.record(PROJECT_FILE, Buffer.from(attempted), "recovery");
    throw new CutuError(
      "REVISION_CONFLICT",
      "Project manifest changed during save; observed versions were retained in history",
      409,
    );
  }
  private async persist(
    p: Project,
    expected: Buffer,
    sourceGuard?: () => Promise<void>,
  ) {
    const content = JSON.stringify(p, null, 2) + "\n";
    await this.observe(p.id, PROJECT_FILE, expected);
    await this.atomic(
      await this.resolveFile(p.id, PROJECT_FILE),
      content,
      async () => {
        await this.manifestGuard(p.id, expected, content);
        await sourceGuard?.();
      },
    );
    await this.storage(p.id).record(PROJECT_FILE, Buffer.from(content), "save");
    await this.remember(p.id, PROJECT_FILE, sha256(content));
    this.events.publish(p.id, "project.updated", { revision: p.revision });
  }
  async read(id: string, relative: string): Promise<FileSnapshot> {
    await this.get(id);
    try {
      const filename = await this.resolveFile(id, relative);
      const stat = await fs.stat(filename);
      if (!stat.isFile())
        throw new CutuError("INVALID_PATH", "Path is not a file");
      if (stat.size > 8 * 1024 * 1024)
        throw new CutuError("FILE_TOO_LARGE", "File exceeds 8 MiB", 413);
      const bytes = await fs.readFile(filename);
      await this.observe(id, relative, bytes);
      return {
        path: relative,
        content: bytes.toString("utf8"),
        sha256: sha256(bytes),
      };
    } catch (e) {
      if (missing(e)) throw new CutuError("NOT_FOUND", "File not found", 404);
      throw e;
    }
  }
  async write(
    id: string,
    relative: string,
    content: unknown,
    expectedSha256: unknown,
  ) {
    return this.serial(
      id,
      async () =>
        (await this.save(id, relative, content, expectedSha256, "save")).file,
    );
  }
  async importAsset(
    id: string,
    asset: Asset,
    content: unknown,
  ): Promise<{ project: Project; file: FileSnapshot; asset: Asset }> {
    return this.serial(id, async () => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset))
        throw new CutuError("INVALID_INPUT", "An asset definition is required");
      safeRelative(asset.path);
      const { file, project } = await this.save(
        id,
        asset.path,
        content,
        null,
        "save",
        asset,
      );
      return {
        project,
        file,
        asset: project.assets.find((a) => a.id === asset.id)!,
      };
    });
  }
  private async save(
    id: string,
    relative: string,
    content: unknown,
    expectedSha256: unknown,
    reason: "save" | "restore",
    asset?: Asset,
  ) {
    if (relative === PROJECT_FILE)
      throw new CutuError(
        "INVALID_PATH",
        "Use project PATCH to edit the manifest",
      );
    if (typeof content !== "string")
      throw new CutuError("INVALID_INPUT", "File content must be a string");
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      throw new CutuError("FILE_TOO_LARGE", "File exceeds 8 MiB", 413);
    if (
      expectedSha256 !== null &&
      (typeof expectedSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(expectedSha256))
    )
      throw new CutuError(
        "INVALID_INPUT",
        "An observed SHA-256 or null is required",
      );
    await this.recover(id);
    const { project: p, bytes: manifestBytes } = await this.loadProject(id);
    const filename = await this.resolveFile(id, relative, true);
    const observed = await this.optionalBytes(filename);
    const previous = observed === null ? null : sha256(observed);
    if (observed) await this.observe(id, relative, observed);
    if (expectedSha256 !== previous)
      throw new CutuError(
        "HASH_CONFLICT",
        "File has changed; read its current hash before writing",
        409,
      );
    if (
      asset &&
      p.assets.some(
        (existing) => existing.id === asset.id || existing.path === relative,
      )
    )
      throw new CutuError(
        "ASSET_CONFLICT",
        "Asset identity or path is already registered",
        409,
      );
    const next = validateProject({
      ...p,
      ...(asset ? { assets: [...p.assets, asset] } : {}),
      revision: p.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const manifestContent = JSON.stringify(next, null, 2) + "\n";
    const transaction: SaveTransaction = {
      version: 1,
      id: randomUUID(),
      path: relative,
      beforeSourceBase64: observed?.toString("base64") ?? null,
      afterSourceBase64: Buffer.from(content).toString("base64"),
      beforeManifestBase64: manifestBytes.toString("base64"),
      afterManifestBase64: Buffer.from(manifestContent).toString("base64"),
      reason,
    };
    const storage = this.storage(id);
    await storage.put(
      ".cutucircuits-transactions",
      `${transaction.id}.json`,
      transaction,
    );
    let replaced = false;
    try {
      await this.atomic(filename, content, async () => {
        await this.manifestGuard(id, manifestBytes, manifestContent);
        await this.resolveFile(id, relative, true);
        const intervening = await this.optionalBytes(filename);
        if ((intervening === null ? null : sha256(intervening)) === previous)
          return;
        if (intervening) await this.observe(id, relative, intervening);
        await storage.record(relative, Buffer.from(content), "recovery");
        // Keep the original conflict record format for terminal-based recovery.
        await storage.put(".cutucircuits-recovery", `${randomUUID()}.json`, {
          path: relative,
          timestamp: new Date().toISOString(),
          expectedSha256,
          observedBase64: observed?.toString("base64") ?? null,
          interveningBase64: intervening?.toString("base64") ?? null,
          attemptedContent: content,
        });
        throw new CutuError(
          "HASH_CONFLICT",
          "File changed during save; disk content and observed recovery versions were retained",
          409,
        );
      });
      replaced = true;
      await storage.record(relative, Buffer.from(content), reason);
      await this.persist(next, manifestBytes, () =>
        this.sourceGuard(id, relative, Buffer.from(content)),
      );
      await storage.remove(
        ".cutucircuits-transactions",
        `${transaction.id}.json`,
      );
    } catch (error) {
      // Once replacement may have happened the WAL must survive until restart or
      // the next mutation. Even a directory-fsync failure can follow rename.
      if (
        !replaced &&
        error instanceof CutuError &&
        ["HASH_CONFLICT", "REVISION_CONFLICT"].includes(error.code)
      ) {
        await storage.record(relative, Buffer.from(content), "recovery");
        await storage.remove(
          ".cutucircuits-transactions",
          `${transaction.id}.json`,
        );
      }
      throw error;
    }
    const snapshot = { path: relative, content, sha256: sha256(content) };
    await this.remember(id, relative, snapshot.sha256);
    this.events.publish(id, "file.updated", {
      path: relative,
      sha256: snapshot.sha256,
      revision: next.revision,
    });
    return { file: snapshot, project: next };
  }
  async history(
    id: string,
    relative?: string,
    limit = 100,
  ): Promise<FileHistoryEntry[]> {
    await this.get(id);
    if (relative !== undefined) safeRelative(relative);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new CutuError(
        "INVALID_INPUT",
        "History limit must be an integer from 1 to 100",
      );
    return (await this.storage(id).entries(relative)).slice(0, limit);
  }
  async historyVersion(
    id: string,
    versionId: string,
  ): Promise<FileHistoryVersion> {
    await this.get(id);
    if (typeof versionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(versionId))
      throw new CutuError("INVALID_INPUT", "Invalid history version ID");
    try {
      const { entry, bytes } = await this.storage(id).version(versionId);
      return { entry, content: bytes.toString("utf8") };
    } catch (e) {
      if (missing(e))
        throw new CutuError("NOT_FOUND", "History version not found", 404);
      throw e;
    }
  }
  async restoreVersion(
    id: string,
    versionId: string,
    expectedSha256: unknown,
  ): Promise<FileSnapshot> {
    return this.serial(id, async () => {
      const version = await this.historyVersion(id, versionId);
      if (sha256(version.content) !== version.entry.sha256)
        throw new CutuError(
          "INVALID_INPUT",
          "Only UTF-8 source versions can be restored",
        );
      return (
        await this.save(
          id,
          version.entry.path,
          version.content,
          expectedSha256,
          "restore",
        )
      ).file;
    });
  }
  private async sourceGuard(id: string, relative: string, expected: Buffer) {
    const filename = await this.resolveFile(id, relative, true);
    const current = await this.optionalBytes(filename);
    if (current !== null && sha256(current) === sha256(expected)) return;
    if (current) await this.observe(id, relative, current);
    throw new CutuError(
      "HASH_CONFLICT",
      "File changed after source replacement; terminal content was retained and the interrupted save journal was kept",
      409,
    );
  }
  private async optionalBytes(filename: string) {
    try {
      return await fs.readFile(filename);
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }
  private async observe(id: string, relative: string, bytes?: Buffer) {
    const content =
      bytes ?? (await fs.readFile(await this.resolveFile(id, relative)));
    return this.storage(id).record(relative, content, "external", true);
  }
  private async recover(id: string) {
    const storage = this.storage(id);
    for (const name of await storage.names(".cutucircuits-transactions")) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const transaction = (await storage.read(
        ".cutucircuits-transactions",
        name,
      )) as SaveTransaction;
      if (
        transaction.version !== 1 ||
        `${transaction.id}.json` !== name ||
        !["save", "restore"].includes(transaction.reason)
      )
        throw new CutuError("INVALID_RECOVERY", "Invalid save journal");
      safeRelative(transaction.path);
      if (
        transaction.path === PROJECT_FILE ||
        ![
          transaction.afterSourceBase64,
          transaction.beforeManifestBase64,
          transaction.afterManifestBase64,
        ].every((v) => typeof v === "string") ||
        !(
          transaction.beforeSourceBase64 === null ||
          typeof transaction.beforeSourceBase64 === "string"
        )
      )
        throw new CutuError("INVALID_RECOVERY", "Invalid save journal");
      const beforeManifest = Buffer.from(
        transaction.beforeManifestBase64,
        "base64",
      );
      const afterManifest = Buffer.from(
        transaction.afterManifestBase64,
        "base64",
      );
      const next = validateProject(JSON.parse(afterManifest.toString("utf8")));
      if (next.id !== id)
        throw new CutuError(
          "INVALID_RECOVERY",
          "Journal project identity mismatch",
        );
      const filename = await this.resolveFile(id, transaction.path, true);
      const source = await this.optionalBytes(filename);
      const manifest = await this.optionalBytes(
        await this.resolveFile(id, PROJECT_FILE, true),
      );
      const beforeSource =
        transaction.beforeSourceBase64 === null
          ? null
          : Buffer.from(transaction.beforeSourceBase64, "base64");
      const afterSource = Buffer.from(transaction.afterSourceBase64, "base64");
      const same = (a: Buffer | null, b: Buffer | null) =>
        a === null || b === null ? a === b : sha256(a) === sha256(b);
      if (beforeSource) await this.observe(id, transaction.path, beforeSource);
      await storage.record(transaction.path, afterSource, "recovery");
      if (source) await this.observe(id, transaction.path, source);
      if (same(source, afterSource) && same(manifest, beforeManifest)) {
        await this.persist(next, beforeManifest, () =>
          this.sourceGuard(id, transaction.path, afterSource),
        );
      } else if (
        !(same(source, afterSource) && same(manifest, afterManifest)) &&
        !(same(source, beforeSource) && same(manifest, beforeManifest))
      ) {
        // Unknown terminal changes win. Archive the complete immutable intent so
        // neither side of an interrupted save disappears; never roll disk back.
        if (manifest) await this.observe(id, PROJECT_FILE, manifest);
        await storage.record(PROJECT_FILE, beforeManifest, "recovery");
        await storage.record(PROJECT_FILE, afterManifest, "recovery");
        await storage.put(
          ".cutucircuits-transaction-conflicts",
          name,
          transaction,
        );
      }
      await storage.remove(".cutucircuits-transactions", name);
      if (
        same(source, afterSource) &&
        (same(manifest, beforeManifest) || same(manifest, afterManifest))
      ) {
        await this.remember(id, transaction.path, sha256(afterSource));
        await this.remember(id, PROJECT_FILE, sha256(afterManifest));
      }
    }
  }
  async selection(id: string): Promise<Selection> {
    const project = await this.get(id);
    try {
      const filename = path.join(this.root(id), ".cutucircuits-selection.json");
      if ((await fs.lstat(filename)).isSymbolicLink())
        throw new CutuError("INVALID_PATH", "Symbolic links are not allowed");
      const stored = JSON.parse(await fs.readFile(filename, "utf8"));
      const data = validateSelectionInput(stored);
      const updatedAt =
        typeof stored.updatedAt === "string"
          ? stored.updatedAt
          : new Date().toISOString();
      if (
        (data.entityId !== null &&
          !project.entities.some((e) => e.id === data.entityId)) ||
        (data.assetId !== undefined &&
          !project.assets.some((a) => a.id === data.assetId))
      )
        return {
          entityId: null,
          origin: data.origin,
          updatedAt: new Date().toISOString(),
          context: [],
        };
      return { ...data, updatedAt };
    } catch (e) {
      if (missing(e))
        return {
          entityId: null,
          origin: "workspace",
          updatedAt: new Date().toISOString(),
        };
      throw e;
    }
  }
  async select(id: string, input: unknown) {
    return this.serial(id, async () => {
      const p = await this.get(id);
      const data = validateSelectionInput(input);
      if (
        !data ||
        !["workspace", "codex"].includes(data.origin) ||
        (data.entityId !== null &&
          !p.entities.some((e) => e.id === data.entityId)) ||
        (data.assetId !== undefined &&
          !p.assets.some((a) => a.id === data.assetId))
      )
        throw new CutuError(
          "INVALID_SELECTION",
          "Selection must reference current project entities/assets",
        );
      const selection: Selection = {
        entityId: data.entityId,
        ...(data.assetId ? { assetId: data.assetId } : {}),
        origin: data.origin,
        ...(data.context !== undefined ? { context: data.context } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.atomic(
        path.join(this.root(id), ".cutucircuits-selection.json"),
        JSON.stringify(selection),
      );
      this.events.publish(id, "selection.updated", selection);
      return selection;
    });
  }
  async files(id: string) {
    await this.get(id);
    return [...(await this.scan(id)).keys()];
  }
  private async scan(id: string) {
    const files = new Map<string, string>();
    const walk = async (dir: string, prefix = "") => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const relative = prefix + entry.name;
        if (entry.isDirectory())
          await walk(path.join(dir, entry.name), relative + "/");
        else if (entry.isFile()) {
          const filename = await this.resolveFile(id, relative);
          const s = await fs.stat(filename);
          if (s.size <= 8 * 1024 * 1024)
            files.set(relative, sha256(await fs.readFile(filename)));
        }
      }
    };
    await walk(this.root(id));
    return files;
  }
  private async remember(id: string, relative: string, hash: string) {
    let files = this.fingerprints.get(id);
    if (!files) {
      files = new Map();
      this.fingerprints.set(id, files);
    }
    files.set(relative, hash);
  }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      for (const p of await this.list())
        await this.serial(p.id, async () => {
          await this.recover(p.id);
          const current = await this.scan(p.id);
          const previous = this.fingerprints.get(p.id);
          if (!previous) {
            this.fingerprints.set(p.id, current);
            return;
          }
          const changed = [
            ...new Set([...current.keys(), ...previous.keys()]),
          ].filter((f) => current.get(f) !== previous.get(f));
          if (changed.length) {
            const { project, bytes: manifestBytes } = await this.loadProject(
              p.id,
            );
            for (const relative of changed)
              if (current.has(relative)) await this.observe(p.id, relative);
            project.revision++;
            project.updatedAt = new Date().toISOString();
            await this.persist(project, manifestBytes);
            this.fingerprints.set(p.id, current);
            await this.remember(
              p.id,
              PROJECT_FILE,
              sha256(JSON.stringify(project, null, 2) + "\n"),
            );
            for (const file of changed)
              this.events.publish(p.id, "file.updated", {
                path: file,
                sha256: current.get(file) ?? null,
                revision: project.revision,
                external: true,
              });
          }
        });
    } finally {
      this.polling = false;
    }
  }
}
