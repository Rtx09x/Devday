import type { Asset, Project, FileSnapshot } from "@cutucircuits/core";
import type {
  EditorHost,
  ExtensionStorage,
  ExtensionContext,
  ExtensionAITool,
  ProjectFileEdit,
  EditorContextItem,
  EditorMenuItem,
  EditorHostFileSystem,
} from "./types";
export interface EngineEditorProps {
  project: Project;
  asset: Asset;
  onSelection?: (id: string | null) => void;
  baseUrl?: string;
}
export class BrowserHost implements EditorHost {
  readonly filePath: string;
  readonly fileName: string;
  get theme() { return typeof document !== "undefined" && document.documentElement.dataset.colorMode === "dark" ? "dark" : "light"; }
  readonly isActive = true;
  readonly workspaceId: string;
  readonly supportsSourceMode = false;
  readonly storage: ExtensionStorage;
  editorAPI: unknown;
  dirty = false;
  saving = false;
  saveError = "";
  menuItems: EditorMenuItem[] = [];
  private stateListeners = new Set<() => void>();
  private pendingSave?: Promise<void>;
  private saveQueue: Promise<void> = Promise.resolve();
  private toolQueue: Promise<unknown> = Promise.resolve();
  private editVersion = 0;
  private queuedSaves = 0;
  subscribe = (cb: () => void) => {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  };
  private emit() {
    this.stateListeners.forEach((cb) => cb());
  }
  private snapshots = new Map<string, FileSnapshot>();
  private changes = new Set<(paths: string[]) => void>();
  private saves = new Set<() => void>();
  private source?: EventSource;
  readonly fs: EditorHostFileSystem;
  readonly context: ExtensionContext;
  private readonly root: string;
  readonly options: EngineEditorProps;
  constructor(options: EngineEditorProps) {
    this.options = options;
    this.filePath = options.asset.path;
    this.fileName = this.filePath.split("/").pop()!;
    this.workspaceId = options.project.id;
    this.root = `${options.baseUrl ?? "/api"}/projects/${encodeURIComponent(this.workspaceId)}`;
    const get = <T>(key: string, global = false): T | undefined => {
      const s = localStorage.getItem(
        `cutucircuits:${global ? "global" : this.workspaceId}:${key}`,
      );
      return s === null ? undefined : JSON.parse(s);
    };
    const set = async (key: string, v: unknown, global = false) => {
      localStorage.setItem(
        `cutucircuits:${global ? "global" : this.workspaceId}:${key}`,
        JSON.stringify(v),
      );
    };
    const del = async (key: string, global = false) => {
      localStorage.removeItem(
        `cutucircuits:${global ? "global" : this.workspaceId}:${key}`,
      );
    };
    this.storage = {
      get,
      set,
      delete: del,
      getGlobal: (k) => get(k, true),
      setGlobal: (k, v) => set(k, v, true),
      deleteGlobal: (k) => del(k, true),
      getSecret: async () => undefined,
      setSecret: async () => {
        throw new Error(
          "Store credentials in the local broker, not browser storage",
        );
      },
      deleteSecret: async () => {},
    };
    this.fs = {
      read: async (paths: string[]) =>
        Promise.all(
          paths.map(async (path) => {
            try {
              const f = await this.read(path);
              return { ...f, exists: true };
            } catch (e) {
              if ((e as any).status !== 404) throw e;
              return { path, exists: false, content: null, sha256: null };
            }
          }),
        ),
      write: async (edit: ProjectFileEdit) => {
        // Preflight every observed revision before beginning the explicitly non-atomic edit.
        const before = await this.fs.read(edit.changes.map((c) => c.path));
        edit.changes.forEach((c, i) => {
          if (c.expectedSha256 !== before[i].sha256)
            throw new Error(`File revision conflict: ${c.path}`);
          if (c.content === null)
            throw new Error("File deletion is not supported by the broker");
        });
        const files = [];
        for (const c of edit.changes) {
          const f = await this.write(c.path, c.content!, c.expectedSha256);
          files.push({
            path: c.path,
            beforeSha256: c.expectedSha256,
            afterSha256: f.sha256,
          });
        }
        return {
          id: crypto.randomUUID(),
          label: edit.label,
          actor: edit.actor,
          timestamp: Date.now(),
          files,
          atomic: false as const,
        };
      },
      onChanged: (cb: (paths: string[]) => void) => {
        this.changes.add(cb);
        return () => {
          this.changes.delete(cb);
        };
      },
    };
    this.context = {
      manifest: {},
      extensionPath: "",
      subscriptions: [],
      services: {
        filesystem: {
          readFile: async (p) => (await this.read(p)).content,
          writeFile: async (p, c) => {
            let f = this.snapshots.get(this.path(p));
            if (!f) {
              try {
                f = await this.read(p);
              } catch (e) {
                if ((e as any).status !== 404) throw e;
              }
            }
            await this.write(p, c, f?.sha256 ?? null);
          },
          fileExists: async (p) => {
            try {
              await this.read(p);
              return true;
            } catch (e) {
              if ((e as any).status === 404) return false;
              throw e;
            }
          },
          findFiles: async (pattern) => {
            const all = await this.request("/file-list");
            const glob = new RegExp(
              "^" +
                pattern
                  .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                  .replace(/\*\*/g, "§")
                  .replace(/\*/g, "[^/]*")
                  .replace(/§\//g, "(?:.*/)?")
                  .replace(/§/g, ".*") +
                "$",
            );
            return (all as string[]).filter((p) => glob.test(p));
          },
        },
        configuration: {
          get: (k, d) => this.storage.get(k) ?? d!,
          update: (k, v) => this.storage.set(k, v),
          getAll: () => ({}),
        },
        ui: {
          showInfo: (m) => this.notify(m),
          showWarning: (m) => this.notify(m),
          showError: (m) => this.notify(m),
        },
      },
    };
  }
  private path(p: string) {
    const path = p.replace(/^\.\//, "").replace(/^\//, "");
    if (path.split("/").includes(".."))
      throw new Error("Path must stay inside the project");
    return path;
  }
  async request(path: string, init?: RequestInit): Promise<any> {
    const r = await fetch(this.root + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const d = await r.json();
    if (!r.ok)
      throw Object.assign(new Error(d.error?.message ?? r.statusText), {
        status: r.status,
      });
    return d;
  }
  async read(path: string) {
    path = this.path(path);
    const f = (await this.request(
      `/files?path=${encodeURIComponent(path)}`,
    )) as FileSnapshot;
    if (!(this.dirty && path === this.filePath)) this.snapshots.set(path, f);
    return f;
  }
  async write(path: string, content: string, expectedSha256: string | null) {
    path = this.path(path);
    const f = (await this.request("/files", {
      method: "PUT",
      body: JSON.stringify({ path, content, expectedSha256 }),
    })) as FileSnapshot;
    this.snapshots.set(path, f);
    return f;
  }
  async loadContent() {
    return (await this.read(this.filePath)).content;
  }
  async loadBinaryContent() {
    return new TextEncoder().encode(await this.loadContent()).buffer;
  }
  saveContent(content: string | ArrayBuffer): Promise<void> {
    const version = this.editVersion;
    const text =
      typeof content === "string" ? content : new TextDecoder().decode(content);
    this.queuedSaves++;
    this.saving = true;
    this.emit();
    const operation = this.saveQueue.then(async () => {
      this.saving = true;
      this.saveError = "";
      this.emit();
      try {
        const snapshot = this.snapshots.get(this.filePath);
        if (!snapshot)
          throw new Error(
            "Load the file before saving to preserve revision protection",
          );
        await this.write(this.filePath, text, snapshot.sha256);
        if (version === this.editVersion) this.setDirty(false);
      } catch (e) {
        this.saveError = (e as Error).message;
        throw e;
      } finally {
        this.saving = --this.queuedSaves > 0;
        this.emit();
      }
    });
    this.saveQueue = operation.catch(() => {});
    this.pendingSave = operation;
    return operation;
  }

  setDirty(value: boolean) {
    if (value) this.editVersion++;
    this.dirty = value;
    this.emit();
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent("cutucircuits:dirty", {
          detail: {
            dirty: value,
            projectId: this.workspaceId,
            path: this.filePath,
          },
        }),
      );
  }
  onFileChanged(cb: (content: string) => void) {
    return this.fs.onChanged((paths) => {
      if (paths.includes(this.filePath))
        void this.request(`/files?path=${encodeURIComponent(this.filePath)}`)
          .then((snapshot: FileSnapshot) => {
            if (this.dirty) {
              this.notify(
                "The source changed while this editor has unsaved changes. Save will check the original revision.",
              );
              return;
            }
            this.snapshots.set(this.filePath, snapshot);
            cb(snapshot.content);
          })
          .catch((e) => this.notify(e.message));
    });
  }
  onSaveRequested(cb: () => void) {
    this.saves.add(cb);
    return () => {
      this.saves.delete(cb);
    };
  }
  onThemeChanged(cb: (theme: string) => void) {
    const listener = () => cb(this.theme);
    window.addEventListener("cutu-theme-change", listener);
    return () => window.removeEventListener("cutu-theme-change", listener);
  }
  async requestSave(): Promise<void> {
    this.saves.forEach((cb) => cb());
    // Save callbacks may start their asynchronous host save on the next microtask.
    await Promise.resolve();
    const pending = this.pendingSave;
    if (pending) await pending;
    if (this.dirty) {
      this.saveError =
        this.saveError ||
        "The editor did not complete its save. Your edits remain open.";
      this.emit();
      throw new Error(this.saveError);
    }
  }
  executeTool(
    tool: ExtensionAITool,
    params: Record<string, unknown>,
    isActive = () => true,
    expectedSha256?: string,
  ) {
    const execution = this.toolQueue.then(async () => {
      if (!isActive())
        throw new Error("Editor session closed before this tool could run");
      if (expectedSha256 !== undefined) {
        const snapshot = (await this.request(
          `/files?path=${encodeURIComponent(this.filePath)}`,
        )) as FileSnapshot;
        if (snapshot.sha256 !== expectedSha256)
          throw new Error(
            "Native source changed while this tool was waiting. Read the source again before retrying.",
          );
        const baseline = this.snapshots.get(this.filePath);
        if (
          tool.access?.kind === "editor-write" &&
          (this.dirty || baseline?.sha256 !== expectedSha256)
        )
          throw new Error(
            "The editor has changes that differ from the observed source. Finish or reload them before retrying.",
          );
      }
      return this.performTool(tool, params);
    });
    this.toolQueue = execution.catch(() => {});
    return execution;
  }
  private async performTool(
    tool: ExtensionAITool,
    params: Record<string, unknown>,
  ) {
    const result = await tool.handler(params, {
      workspacePath: ".",
      activeFilePath: this.filePath,
      editorAPI: this.editorAPI,
      extensionContext: this.context,
    });
    if (
      tool.access?.kind === "editor-write" &&
      result.success !== false &&
      !result.error &&
      this.dirty
    )
      await this.requestSave();
    return result;
  }
  openHistory() {
    this.notify(
      "File changes are protected by source revisions. Use project history in your version control system.",
    );
  }
  async openExternal(url: string) {
    if (!/^https?:/.test(url)) throw new Error("Only HTTP links can be opened");
    window.open(url, "_blank", "noopener,noreferrer");
  }
  getConfig<T>(key: string, value?: T): T {
    return this.storage.get<T>(key) ?? value!;
  }
  registerMenuItems(items: EditorMenuItem[]) {
    this.menuItems = items;
    this.emit();
  }
  registerEditorAPI(api: unknown) {
    this.editorAPI = api;
  }
  setEditorContext(context: { label: string; description: string } | null) {
    this.setEditorContextItems(
      context ? [{ id: context.label, ...context }] : null,
    );
  }
  setEditorContextItems(items: EditorContextItem[] | null) {
    const id = resolveContextEntity(this.options.project, items);
    this.options.onSelection?.(id);
    void this.request("/selection", {
      method: "PUT",
      body: JSON.stringify({
        entityId: id,
        assetId: this.options.asset.id,
        origin: "workspace",
        context: items ?? [],
      }),
    }).catch((e) => this.notify(e.message));
  }
  private notify(message: string) {
    window.dispatchEvent(
      new CustomEvent("cutucircuits:editor-notice", { detail: { message } }),
    );
    console.info("[Cutu Circuits]", message);
  }
  connect(tools: ExtensionAITool[]) {
    const sessionId = crypto.randomUUID();
    let disposed = false;
    this.source = new EventSource(
      this.root + "/events?sessionId=" + encodeURIComponent(sessionId),
    );
    this.source.onmessage = (event) => {
      const envelope = JSON.parse(event.data);
      const data = envelope.data ?? envelope;
      if (envelope.type === "file.updated") {
        const paths = data.paths ?? [data.path];
        this.changes.forEach((cb) => cb(paths.filter(Boolean)));
      }
      if (
        envelope.type === "editor-tool-request" &&
        data.sessionId === sessionId
      ) {
        const tool = tools.find((t) => t.name === data.name);
        void Promise.resolve()
          .then(() => {
            if (!tool) throw new Error("Unknown editor tool");
            return this.executeTool(
              tool,
              data.params ?? {},
              () => !disposed,
              data.expectedSha256,
            );
          })
          .catch((e) => ({ success: false, error: e.message }))
          .then((result) =>
            this.request(`/editor-sessions/${sessionId}/results`, {
              method: "POST",
              body: JSON.stringify({ requestId: data.requestId, result }),
            }),
          )
          .catch((e) => this.notify(e.message));
      }
    };
    const reconnect = () => {
      if (disposed) return;
      // SSE has no replay log: reconcile the active source after every reconnect.
      this.changes.forEach((cb) => cb([this.filePath]));
      void this.request("/editor-sessions", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          path: this.filePath,
          tools: tools.map(({ handler, ...tool }) => ({
            ...tool,
            inputSchema: tool.inputSchema ??
              tool.parameters ?? { type: "object", properties: {} },
          })),
        }),
      })
        .then(() => {
          if (disposed)
            void this.request(`/editor-sessions/${sessionId}`, {
              method: "DELETE",
            });
        })
        .catch((e) => this.notify(e.message));
    };
    this.source.onopen = reconnect;
    if (typeof window !== "undefined")
      window.addEventListener?.("online", reconnect);
    return () => {
      disposed = true;
      if (typeof window !== "undefined")
        window.removeEventListener?.("online", reconnect);
      this.source?.close();
      void this.request(`/editor-sessions/${sessionId}`, {
        method: "DELETE",
      }).catch(() => {});
    };
  }
}

/** Structured engine identities take priority over exact display labels. Never scan prose. */
export function resolveContextEntity(
  project: Project,
  items: EditorContextItem[] | null,
): string | null {
  for (const item of items ?? []) {
    const data = (item.data ?? {}) as Record<string, unknown>;
    const entities = project.entities;
    const entityId = data.entityId;
    if (typeof entityId === "string") {
      const entity = entities.find((e) => e.id === entityId);
      if (entity) return entity.id;
    }
    const shape = data.shapeName;
    if (typeof shape === "string") {
      const entity = entities.find((e) => e.geometry?.shapeName === shape);
      if (entity) return entity.id;
    }
    const ref =
      data.ref ??
      data.reference ??
      (typeof data.selector === "string"
        ? data.selector.replace(/^[.#]/, "").split(/[.[]/)[0]
        : undefined);
    if (typeof ref === "string" && ref) {
      const entity = entities.find(
        (e) => e.metadata.ref === ref || e.metadata.reference === ref,
      );
      if (entity) return entity.id;
    }
    const component = data.sourceComponentId;
    if (typeof component === "string") {
      const entity = entities.find(
        (e) => e.metadata.sourceComponentId === component || e.id === component,
      );
      if (entity) return entity.id;
    }
    const entity = entities.find(
      (e) => e.id === item.id || e.name === item.label,
    );
    if (entity) return entity.id;
  }
  return null;
}
