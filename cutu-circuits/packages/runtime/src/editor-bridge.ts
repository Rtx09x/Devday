import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { CutuError } from "@cutucircuits/core";
import { ProjectStore } from "./store.js";
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: string | { kind: string };
}
interface Session {
  sessionId: string;
  projectId: string;
  path: string;
  tools: Tool[];
  lastSeen: number;
}
interface Pending {
  projectId: string;
  sessionId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
export function installEditorBridge(
  app: Express,
  store: ProjectStore,
  timeoutMs = 30000,
) {
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const drop = (key: string) => {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    for (const [id, p] of pending)
      if (
        p.projectId === session.projectId &&
        p.sessionId === session.sessionId
      ) {
        clearTimeout(p.timer);
        p.reject(
          new CutuError(
            "EDITOR_DISCONNECTED",
            "Editor session disconnected",
            409,
          ),
        );
        pending.delete(id);
      }
  };
  const key = (projectId: string, sessionId: string) =>
    `${projectId}:${sessionId}`;
  app.post("/api/projects/:id/editor-sessions", async (req, res) => {
    const { sessionId, path, tools } = req.body;
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 256 ||
      !Array.isArray(tools) ||
      tools.length > 100
    )
      throw new CutuError("INVALID_SESSION", "Invalid editor session");
    await store.read(req.params.id, path);
    for (const tool of tools)
      if (
        !tool ||
        typeof tool.name !== "string" ||
        !/^[-.a-zA-Z0-9_]+$/.test(tool.name) ||
        typeof tool.description !== "string" ||
        !tool.inputSchema ||
        typeof tool.inputSchema !== "object" ||
        !(
          typeof tool.access === "string" ||
          (tool.access && typeof tool.access.kind === "string")
        )
      )
        throw new CutuError("INVALID_TOOL", "Invalid editor tool registration");
    if (new Set(tools.map((t) => t.name)).size !== tools.length)
      throw new CutuError("INVALID_TOOL", "Duplicate tool names");
    const sessionKey = key(req.params.id, sessionId);
    if (!sessions.has(sessionKey) && sessions.size >= 64)
      throw new CutuError("EDITOR_LIMIT", "Too many editor sessions", 429);
    const session = {
      projectId: req.params.id,
      sessionId,
      path,
      tools,
      lastSeen: Date.now(),
    };
    sessions.set(sessionKey, session);
    res.json(session);
  });
  app.delete(
    "/api/projects/:id/editor-sessions/:sessionId",
    async (req, res) => {
      await store.get(req.params.id);
      drop(key(req.params.id, req.params.sessionId));
      res.json({ ok: true });
    },
  );
  app.get("/api/projects/:id/editor-tools", async (req, res) => {
    await store.get(req.params.id);
    const tools = await Promise.all(
      [...sessions.values()]
        .filter((s) => s.projectId === req.params.id)
        .map(async (s) => {
          const file = await store.read(s.projectId, s.path);
          return s.tools.map((t) => ({
            ...t,
            sessionId: s.sessionId,
            path: s.path,
            sha256: file.sha256,
          }));
        }),
    );
    res.json(tools.flat());
  });
  app.post("/api/projects/:id/editor-tools/:name", async (req, res) => {
    const project = await store.get(req.params.id);
    let candidates = [...sessions.values()].filter(
      (s) =>
        s.projectId === req.params.id &&
        s.tools.some((t) => t.name === req.params.name),
    );
    if (req.body.sessionId)
      candidates = candidates.filter((s) => s.sessionId === req.body.sessionId);
    if (req.body.assetId) {
      const asset = project.assets.find((a) => a.id === req.body.assetId);
      candidates = candidates.filter((s) => s.path === asset?.path);
    }
    if (!candidates.length)
      throw new CutuError(
        "EDITOR_UNAVAILABLE",
        "Open this native editor in the workspace before invoking its tools",
        409,
      );
    if (candidates.length > 1)
      throw new CutuError(
        "AMBIGUOUS_EDITOR",
        "Choose a sessionId for this tool",
        409,
      );
    if (pending.size >= 128)
      throw new CutuError(
        "EDITOR_LIMIT",
        "Too many pending editor requests",
        429,
      );
    const session = candidates[0];
    const file = await store.read(project.id, session.path);
    const tool = session.tools.find((t) => t.name === req.params.name)!;
    const access =
      typeof tool.access === "string" ? tool.access : tool.access.kind;
    if (
      access === "editor-write" &&
      typeof req.body.expectedSha256 !== "string"
    )
      throw new CutuError(
        "HASH_REQUIRED",
        "Read native source and supply its observed SHA-256 before invoking an editor-write tool",
      );
    if (
      req.body.expectedSha256 !== undefined &&
      file.sha256 !== req.body.expectedSha256
    )
      throw new CutuError(
        "HASH_CONFLICT",
        "Native source changed before editor dispatch",
        409,
      );
    const requestId = randomUUID();
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new CutuError(
            "EDITOR_TIMEOUT",
            "Native editor did not respond before the deadline",
            504,
          ),
        );
      }, timeoutMs);
      timer.unref();
      pending.set(requestId, {
        projectId: project.id,
        sessionId: session.sessionId,
        resolve,
        reject,
        timer,
      });
      store.events.publish(project.id, "editor-tool-request", {
        sessionId: session.sessionId,
        requestId,
        name: req.params.name,
        expectedSha256: req.body.expectedSha256,
        params: req.body.params ?? req.body.arguments ?? {},
      });
    });
    res.json(result ?? null);
  });
  app.post(
    "/api/projects/:id/editor-sessions/:sessionId/results",
    async (req, res) => {
      await store.get(req.params.id);
      const session = sessions.get(key(req.params.id, req.params.sessionId));
      const p = pending.get(req.body.requestId);
      if (
        !session ||
        !p ||
        p.projectId !== req.params.id ||
        p.sessionId !== req.params.sessionId
      )
        throw new CutuError("NOT_FOUND", "Editor request not found", 404);
      pending.delete(req.body.requestId);
      clearTimeout(p.timer);
      session.lastSeen = Date.now();
      if (req.body.error)
        p.reject(
          new CutuError(
            "EDITOR_TOOL_ERROR",
            typeof req.body.error === "string"
              ? req.body.error
              : JSON.stringify(req.body.error),
            400,
          ),
        );
      else p.resolve(req.body.result);
      res.json({ ok: true });
    },
  );
  return {
    disconnectSession(projectId: string, sessionId: string) {
      drop(key(projectId, sessionId));
    },
    close() {
      for (const id of [...sessions.keys()]) drop(id);
    },
    disconnect(projectId: string) {
      for (const [id, s] of sessions) if (s.projectId === projectId) drop(id);
    },
  };
}
