import type { Express } from "express";
import { CutuError } from "@cutucircuits/core";
import type { ProjectStore } from "../store.js";
import { AgentService } from "./service.js";
import { validateAttachments } from "./attachments.js";
export function installAgentRoutes(
  app: Express,
  store: ProjectStore,
  agent: AgentService,
) {
  const prefix = "/api/projects/:id/agent";
  const fail = (e: unknown) => {
    throw new CutuError(
      e instanceof Error ? e.message : "AGENT_ERROR",
      e instanceof Error ? e.message : "Agent request failed",
      e instanceof Error && e.message === "AGENT_BUSY" ? 409 : 400,
    );
  };
  app.get(`${prefix}/status`, async (req, res) => {
    await store.get(req.params.id);
    res.json(agent.status(req.params.id));
  });
  app.delete(`${prefix}/history`, async (req, res) => {
    await store.get(req.params.id);
    try {
      agent.clear(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(e);
    }
  });
  app.post(`${prefix}/cancel`, async (req, res) => {
    await store.get(req.params.id);
    agent.cancel(req.params.id);
    res.json({ ok: true });
  });
  app.post(`${prefix}/approvals/:approvalId`, async (req, res) => {
    await store.get(req.params.id);
    if (typeof req.body.approved !== "boolean")
      throw new CutuError("INVALID_INPUT", "approved must be boolean");
    try {
      agent.approve(req.params.id, req.params.approvalId, req.body.approved);
      res.json({ ok: true });
    } catch (e) {
      fail(e);
    }
  });
  app.post(`${prefix}/turns`, async (req, res) => {
    await store.get(req.params.id);
    if (
      typeof req.body.message !== "string" ||
      !req.body.message.trim() ||
      req.body.message.length > 16000
    )
      throw new CutuError(
        "INVALID_INPUT",
        "A message of 1–16000 characters is required",
      );
    let attachments;
    try {
      attachments = validateAttachments(req.body.attachments);
    } catch {
      throw new CutuError(
        "INVALID_ATTACHMENTS",
        "Attach at most two PNG/JPEG images, up to 3 MiB total. Remote URLs are unsupported.",
      );
    }
    const status = agent.status(req.params.id);
    if (status.activeTurnId)
      throw new CutuError("AGENT_BUSY", "A turn is already running", 409);
    if (!status.configured)
      throw new CutuError(
        "CEREBRAS_NOT_CONFIGURED",
        "Set CEREBRAS_API_KEY in the backend environment to enable the assistant",
        503,
      );
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": heartbeat\n\n");
    }, 15000);
    try {
      await agent.run(
        req.params.id,
        req.body.message,
        (e) => {
          if (!res.destroyed)
            res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        },
        controller.signal,
        attachments,
      );
    } finally {
      clearInterval(heartbeat);
      res.off("close", onClose);
      res.end();
    }
  });
}
