import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import path from "node:path";
import {
  CutuError,
  PROJECT_FILE,
  type Operation,
  type Capability,
} from "@cutucircuits/core";
import { ProjectStore, type StoreOptions } from "./store.js";
import { HardwareRunner } from "@cutucircuits/hardware";
import * as engines from "@cutucircuits/engines";
import { installEditorBridge } from "./editor-bridge.js";
import { installRoboticsRoutes } from "./robotics-routes.js";
import { cadCacheKey, createCompileCache } from "./compile-cache.js";
import { AgentService, type AgentOptions } from "./agent/service.js";
import { installAgentRoutes } from "./agent/routes.js";
import { installPresentation } from "./presentation.js";
interface Runner {
  run(
    projectId: string,
    projectRoot: string,
    capability: Capability,
    inputs: Record<string, unknown>,
  ): Operation;
  send?(id: string, message: Record<string, unknown>): Operation;
  cancel(id: string): Promise<Operation>;
  list(projectId: string): Operation[];
  dispose(): Promise<void>;
}
export interface RuntimeOptions extends StoreOptions {
  agent?: AgentOptions;
  host?: string;
  port?: number;
  webDir?: string;
  runner?: Runner;
  engines?: typeof engines;
}
export async function createRuntime(options: RuntimeOptions) {
  const store = await new ProjectStore(options).init();
  const runner =
    options.runner ??
    new HardwareRunner({
      onUpdate: (operation) =>
        store.events.publish(
          operation.projectId,
          "operation.updated",
          operation,
        ),
    });
  const engine = options.engines ?? engines;
  const cadCache = createCompileCache<Awaited<ReturnType<typeof engines.compileCad>>>();
  let agentBaseUrl = `http://127.0.0.1:${options.port ?? 4310}`;
  const agent = new AgentService(options.agent ?? {}, () => agentBaseUrl);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "")) {
      res.status(403).json({
        error: {
          code: "HOST_REJECTED",
          message: "Use the loopback runtime address",
        },
      });
      return;
    }
    const allowed =
      origin === undefined ||
      origin === `http://${req.headers.host}` ||
      /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin);
    if (!allowed) {
      res.status(403).json({
        error: {
          code: "ORIGIN_REJECTED",
          message: "Requests must originate from this local workspace",
        },
      });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
    }
    if (
      req.headers["sec-fetch-site"] === "cross-site" &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !origin
    ) {
      res.status(403).json({
        error: {
          code: "ORIGIN_REJECTED",
          message: "Cross-site mutations are not allowed",
        },
      });
      return;
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "9mb" }));
  app.use("/api", (req, _res, next) => {
    if (
      ["POST", "PUT", "PATCH"].includes(req.method) &&
      (req.body === null ||
        typeof req.body !== "object" ||
        Array.isArray(req.body))
    )
      throw new CutuError("INVALID_INPUT", "A JSON object body is required");
    next();
  });
  // Requiring JSON on mutations also blocks cross-site form submissions without Origin.
  app.use("/api", (req, _res, next) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.method !== "DELETE" &&
      !req.is("application/json")
    )
      throw new CutuError(
        "INVALID_CONTENT_TYPE",
        "Mutation requests require application/json",
        415,
      );
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({ name: "Cutu Circuits", version: "0.1.0", status: "ok" }),
  );
  app.get("/api/projects", async (_req, res) => res.json(await store.list()));
  app.post("/api/projects", async (req, res) =>
    res.status(201).json(await store.create(req.body.name, req.body.template)),
  );
  app.get("/api/projects/:id", async (req, res) =>
    res.json(await store.get(req.params.id)),
  );
  app.patch("/api/projects/:id", async (req, res) =>
    res.json(
      await store.patch(
        req.params.id,
        req.body.expectedRevision,
        req.body.changes,
      ),
    ),
  );
  app.get("/api/projects/:id/environment", async (req, res) => {
    await store.get(req.params.id);
    const projectRoot = store.root(req.params.id);
    res.json({
      projectRoot,
      projectFile: path.join(projectRoot, PROJECT_FILE),
      platform: process.platform,
      nodeVersion: process.version,
    });
  });
  app.get("/api/projects/:id/file-list", async (req, res) =>
    res.json(await store.files(req.params.id)),
  );
  app.get("/api/projects/:id/files", async (req, res) => {
    if (typeof req.query.path !== "string")
      throw new CutuError("INVALID_INPUT", "A file path is required");
    res.json(await store.read(req.params.id, req.query.path));
  });
  app.put("/api/projects/:id/files", async (req, res) =>
    res.json(
      await store.write(
        req.params.id,
        req.body.path,
        req.body.content,
        req.body.expectedSha256,
      ),
    ),
  );
  app.get("/api/projects/:id/history", async (req, res) => {
    if (req.query.path !== undefined && typeof req.query.path !== "string")
      throw new CutuError("INVALID_INPUT", "A single file path is required");
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new CutuError(
        "INVALID_INPUT",
        "History limit must be between 1 and 100",
      );
    res.json(
      await store.history(
        req.params.id,
        req.query.path as string | undefined,
        limit,
      ),
    );
  });
  app.get("/api/projects/:id/history/:versionId", async (req, res) =>
    res.json(await store.historyVersion(req.params.id, req.params.versionId)),
  );
  app.post("/api/projects/:id/history/:versionId/restore", async (req, res) =>
    res.json(
      await store.restoreVersion(
        req.params.id,
        req.params.versionId,
        req.body.expectedSha256,
      ),
    ),
  );
  installRoboticsRoutes(app, store);
  app.get("/api/projects/:id/selection", async (req, res) =>
    res.json(await store.selection(req.params.id)),
  );
  app.put("/api/projects/:id/selection", async (req, res) =>
    res.json(await store.select(req.params.id, req.body)),
  );
  const streams = new Set<() => void>();
  const bridge = installEditorBridge(app, store);
  const presentation = installPresentation(app, store);
  app.get("/api/projects/:id/events", async (req, res) => {
    await store.get(req.params.id);
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    const unsubscribe = store.events.subscribe(req.params.id, (event) =>
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`),
    );
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    heartbeat.unref();
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (typeof req.query.sessionId === "string")
        bridge.disconnectSession(req.params.id, req.query.sessionId);
      streams.delete(close);
      res.end();
    };
    streams.add(close);
    req.on("close", close);
  });
  app.post("/api/projects/:id/compile", async (req, res) => {
    const p = await store.get(req.params.id);
    const file = await store.read(p.id, req.body.path);
    const asset = p.assets.find((a) => a.path === file.path);
    const result =
      asset?.kind === "circuit" || file.path.endsWith(".circuit.tsx")
        ? await engine.compileCircuit(file.content, file.path)
        : asset?.kind === "cad" ||
            file.path.endsWith(".cad.js") ||
            file.path.endsWith(".cad.ts") ||
            file.path.endsWith(".replicad.ts") ||
            file.path.endsWith(".replicad.js")
          ? await (() => {
              const key = cadCacheKey(p.id, file.path, file.sha256, req.body.parameters);
              const compile = () => engine.compileCad(file.content, file.path, req.body.parameters).then((model) => {
                if (model.sourceSha256 !== file.sha256) throw new CutuError("ENGINE_SOURCE_MISMATCH", "Compiled model does not match its source", 409);
                return model;
              });
              return key ? cadCache.get(key, compile, req.body.force === true) : compile();
            })()
          : null;
    if (!result)
      throw new CutuError(
        "INVALID_ASSET",
        "Compile requires a circuit or CAD source",
      );
    store.events.publish(p.id, "engine.updated", {
      path: file.path,
      sourceSha256: file.sha256,
    });
    res.json(result);
  });
  app.post("/api/projects/:id/export", async (req, res) => {
    const file = await store.read(req.params.id, req.body.path);
    const format = req.body.format;
    let result;
    if (format === "svg" || format === "bom")
      result = await engine.exportCircuit(file.content, file.path, format);
    else if (["step", "stl", "obj"].includes(format))
      result = await engine.exportCad(
        file.content,
        file.path,
        format,
        req.body.parameters,
      );
    else throw new CutuError("INVALID_FORMAT", "Unsupported export format");
    res.json(result);
  });
  app.get("/api/projects/:id/operations", async (req, res) => {
    await store.get(req.params.id);
    res.json(runner.list(req.params.id));
  });
  app.post("/api/projects/:id/operations", async (req, res) => {
    const p = await store.get(req.params.id);
    const capability = p.hardware?.capabilities.find(
      (c) => c.id === req.body.capabilityId,
    );
    if (!capability)
      throw new CutuError(
        "INVALID_CAPABILITY",
        "Capability is not registered in this project",
      );
    if (
      !req.body.inputs ||
      typeof req.body.inputs !== "object" ||
      Array.isArray(req.body.inputs)
    )
      throw new CutuError("INVALID_INPUT", "Inputs must be an object");
    res
      .status(202)
      .json(runner.run(p.id, store.root(p.id), capability, req.body.inputs));
  });
  app.post(
    "/api/projects/:id/operations/:operationId/cancel",
    async (req, res) => {
      await store.get(req.params.id);
      if (
        !runner.list(req.params.id).some((o) => o.id === req.params.operationId)
      )
        throw new CutuError("NOT_FOUND", "Operation not found", 404);
      res.json(await runner.cancel(req.params.operationId));
    },
  );
  app.post(
    "/api/projects/:id/operations/:operationId/send",
    async (req, res) => {
      await store.get(req.params.id);
      if (
        !runner.list(req.params.id).some((o) => o.id === req.params.operationId)
      )
        throw new CutuError("NOT_FOUND", "Operation not found", 404);
      if (
        !req.body.message ||
        typeof req.body.message !== "object" ||
        Array.isArray(req.body.message)
      )
        throw new CutuError(
          "INVALID_INPUT",
          "Control message must be an object",
        );
      if (!runner.send)
        throw new CutuError(
          "CONTROL_UNAVAILABLE",
          "Runner does not support persistent control",
          501,
        );
      res.json(runner.send(req.params.operationId, req.body.message));
    },
  );
  installAgentRoutes(app, store, agent);
  const webDir =
    options.webDir ??
    path.resolve(import.meta.dirname, "../../../apps/web/dist");
  app.use(express.static(webDir));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDir, "index.html"), (error) => {
      if (error) next();
    });
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Route not found" } }),
  );
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    const known = error instanceof CutuError;
    const status = known
      ? error.status
      : error.status === 413
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 500;
    // Keep the HTTP response generic, but retain the underlying local I/O
    // failure so startup, filesystem and project-creation issues are diagnosable.
    if (!known && status === 500)
      console.error("Cutu Circuits runtime request failed:", error);
    res.status(status).json({
      error: {
        code: known
          ? error.code
          : status === 400
            ? "INVALID_JSON"
            : status === 413
              ? "BODY_TOO_LARGE"
              : "INTERNAL_ERROR",
        message: known
          ? error.message
          : status === 400
            ? "Invalid JSON request"
            : status === 413
              ? "Request body too large"
              : "Runtime request failed",
      },
    });
  };
  app.use(errorHandler);
  let server: Server | undefined;
  return {
    app,
    store,
    runner,
    agent,
    async listen() {
      if (server) return server;
      server = await new Promise<Server>((resolve, reject) => {
        const candidate = app.listen(
          options.port ?? 4310,
          options.host ?? "127.0.0.1",
          () => resolve(candidate),
        );
        candidate.once("error", reject);
      });
      const address = server.address();
      if (address && typeof address !== "string")
        agentBaseUrl = `http://127.0.0.1:${address.port}`;
      return server;
    },
    async close() {
      await agent.close();
      presentation.close();
      bridge.close();
      for (const close of streams) close();
      await runner.dispose();
      await store.close();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((e) => (e ? reject(e) : resolve())),
        );
    },
  };
}
export async function createApp(options: RuntimeOptions) {
  return (await createRuntime(options)).app;
}
