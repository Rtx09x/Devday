import type { Express } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CutuError, type Asset } from "@cutucircuits/core";
import { parseUrdf } from "@cutucircuits/robotics";
import type { ProjectStore } from "./store.js";
import { safeRelative } from "./validation.js";
import { runRobotSimulation } from "./robotics-service.js";

const simulationInput = z
  .object({
    path: z.string().min(1),
    durationSeconds: z.number().finite().min(0).max(10).default(2),
    fixedBase: z.boolean().default(true),
    ground: z.boolean().default(true),
    gravity: z
      .tuple([
        z.number().finite().min(-1000).max(1000),
        z.number().finite().min(-1000).max(1000),
        z.number().finite().min(-1000).max(1000),
      ])
      .optional(),
    position: z
      .tuple([
        z.number().finite().min(-1000).max(1000),
        z.number().finite().min(-1000).max(1000),
        z.number().finite().min(-1000).max(1000),
      ])
      .optional(),
    jointTargets: z.record(z.number().finite()).default({}),
  })
  .strict();
const extensions = new Set([
  ".urdf",
  ".xml",
  ".stl",
  ".dae",
  ".obj",
  ".mtl",
  ".gltf",
  ".glb",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".tga",
  ".bmp",
]);
export function installRoboticsRoutes(app: Express, store: ProjectStore) {
  app.get("/api/projects/:id/assets/raw", async (req, res) => {
    if (typeof req.query.path !== "string")
      throw new CutuError("INVALID_INPUT", "A robot asset path is required");
    await store.get(req.params.id);
    const filename = await store
      .resolveFile(req.params.id, req.query.path)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new CutuError("NOT_FOUND", "Robot asset not found", 404);
        throw error;
      });
    if (!extensions.has(path.extname(filename).toLowerCase()))
      throw new CutuError(
        "UNSUPPORTED_ASSET",
        "This file type is not a robot rendering resource",
      );
    const stat = await fs.stat(filename);
    if (!stat.isFile())
      throw new CutuError("INVALID_PATH", "Robot asset must be a file");
    if (stat.size > 16 * 1024 * 1024)
      throw new CutuError("FILE_TOO_LARGE", "Robot asset exceeds 16 MiB", 413);
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    // Project roots normally live under .cutucircuits-data. Express otherwise
    // rejects that hidden ancestor even though the relative resource is safe.
    res.sendFile(filename, { dotfiles: "allow" });
  });
  app.post("/api/projects/:id/robotics/inspect", async (req, res) => {
    if (typeof req.body.path !== "string")
      throw new CutuError("INVALID_INPUT", "A URDF path is required");
    const snapshot = await store.read(req.params.id, req.body.path);
    try {
      res.json({
        path: snapshot.path,
        sourceSha256: snapshot.sha256,
        model: parseUrdf(snapshot.content),
      });
    } catch (error) {
      throw new CutuError(
        "INVALID_URDF",
        error instanceof Error ? error.message : String(error),
        422,
      );
    }
  });
  app.post("/api/projects/:id/robotics/simulate", async (req, res) => {
    const input = simulationInput.safeParse(req.body);
    if (!input.success)
      throw new CutuError(
        "INVALID_INPUT",
        input.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    if (Object.keys(input.data.jointTargets).length > 128)
      throw new CutuError("INVALID_INPUT", "Too many joint targets");
    const {
      path: relative,
      durationSeconds,
      jointTargets,
      ...options
    } = input.data;
    const snapshot = await store.read(req.params.id, relative);
    const result = await runRobotSimulation({
      source: snapshot.content,
      path: relative,
      projectId: req.params.id,
      dataDir: store.dataDir,
      durationSeconds,
      jointTargets,
      options,
    });
    res.json({
      path: relative,
      sourceSha256: snapshot.sha256,
      ...(result as object),
    });
  });
  app.post("/api/projects/:id/robotics/import", async (req, res) => {
    const { path: relative, content, name } = req.body;
    safeRelative(relative);
    if (
      !/\.(urdf|xml)$/i.test(relative) ||
      typeof content !== "string" ||
      Buffer.byteLength(content) > 1024 * 1024
    )
      throw new CutuError(
        "INVALID_INPUT",
        "Import a URDF/XML text file no larger than 1 MiB",
      );
    if (
      name !== undefined &&
      (typeof name !== "string" || !name.trim() || name.length > 200)
    )
      throw new CutuError(
        "INVALID_INPUT",
        "Robot name must be between 1 and 200 characters",
      );
    let model;
    try {
      model = parseUrdf(content);
    } catch (error) {
      throw new CutuError(
        "INVALID_URDF",
        error instanceof Error ? error.message : String(error),
        422,
      );
    }
    const asset: Asset = {
      id: randomUUID(),
      name: name?.trim() || model.name,
      kind: "urdf",
      path: relative,
      entityIds: [],
    };
    // The store applies file creation and asset registration through its recovery journal.
    res
      .status(201)
      .json(await store.importAsset(req.params.id, asset, content));
  });
}
