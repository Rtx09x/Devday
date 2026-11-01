import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { CutuError } from "@cutucircuits/core";
import type { ProjectStore } from "./store.js";

/** Presentation commands change only the open view, never project source or hardware. */
export function installPresentation(app: Express, store: ProjectStore, timeoutMs = 8000) {
  type Status = "started" | "queued" | "stopped" | "rejected";
  const pending = new Map<string, { projectId: string; action: string; finish: (status: Status) => void; cancel: () => void }>();
  app.post("/api/projects/:id/presentation/build", async (req, res) => {
    const project = await store.get(req.params.id);
    const action = req.body.action ?? "start";
    if (!["start", "stop"].includes(action)) throw new CutuError("INVALID_INPUT", "action must be start or stop");
    if (!project.entities.some(e => e.id === "servo-left") || !project.entities.some(e => e.id === "controller"))
      throw new CutuError("UNSUPPORTED_PRESENTATION", "This project has no Makada assembly", 400);
    if ([...pending.values()].some(p => p.projectId === project.id))
      throw new CutuError("PRESENTATION_BUSY", "A presentation request is awaiting the open view", 409);
    const requestId = randomUUID();
    const status = await new Promise<Status>((resolve, reject) => {
      const clear = () => { clearTimeout(timer); pending.delete(requestId); };
      const timer = setTimeout(() => { clear(); reject(new CutuError("PRESENTATION_VIEW_UNAVAILABLE", "Open this project's Assembly view and try again; no presentation was confirmed", 409)); }, timeoutMs);
      pending.set(requestId, {
        projectId: project.id, action,
        finish: status => { clear(); resolve(status); },
        cancel: () => { clear(); reject(new CutuError("RUNTIME_STOPPING", "Runtime stopped before the presentation was confirmed", 503)); },
      });
      store.events.publish(project.id, "presentation.requested", { requestId, action });
    });
    if (status === "rejected") throw new CutuError("PRESENTATION_REJECTED", "The open view could not start the presentation; finish edits or stop live hardware first", 409);
    res.json({ requestId, projectId: project.id, action, status, presentationOnly: true, hardwareCommandsSent: false });
  });
  app.post("/api/projects/:id/presentation/ack", async (req, res) => {
    await store.get(req.params.id);
    const item = pending.get(req.body.requestId);
    if (!item || item.projectId !== req.params.id) throw new CutuError("NOT_FOUND", "Presentation request not found", 404);
    const status = req.body.status;
    if (!(item.action === "stop" ? ["stopped", "rejected"] : ["started", "queued", "rejected"]).includes(status))
      throw new CutuError("INVALID_INPUT", "Invalid presentation acknowledgment");
    item.finish(status);
    res.json({ ok: true });
  });
  return { close() { for (const item of [...pending.values()]) item.cancel(); } };
}
