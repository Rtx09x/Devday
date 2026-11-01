import { z } from "zod";
import { CutuError, type Project } from "@cutucircuits/core";
const id = z.string().min(1).max(256);
const vector = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const entity = z
  .object({
    id,
    name: z.string(),
    kind: z.enum([
      "controller",
      "servo",
      "board",
      "part",
      "sensor",
      "connector",
      "joint",
      "group",
    ]),
    parentId: id.optional(),
    position: vector,
    rotation: vector.optional(),
    color: z.string().optional(),
    metadata: z.record(z.unknown()),
    geometry: z
      .object({
        type: z.enum(["box", "cylinder", "wire", "mesh"]),
        assetId: id.optional(),
        size: vector.optional(),
        radius: z.number().finite().positive().optional(),
        length: z.number().finite().positive().optional(),
        points: z.array(vector).optional(),
        shapeName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const projectSchema = z
  .object({
    version: z.literal(1),
    id,
    name: z.string().trim().min(1).max(200),
    description: z.string(),
    revision: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    units: z.literal("mm"),
    entities: z.array(entity),
    links: z.array(
      z
        .object({
          id,
          source: id,
          target: id,
          kind: z.enum(["electrical", "mechanical", "control"]),
          label: z.string().optional(),
          sourcePort: z.string().optional(),
          targetPort: z.string().optional(),
        })
        .passthrough(),
    ),
    assets: z.array(
      z.object({
        id,
        name: z.string(),
        path: z.string(),
        kind: z.enum(["circuit", "cad", "firmware", "program", "data", "urdf"]),
        entityIds: z.array(id),
      }),
    ),
    motion: z
      .object({
        id,
        name: z.string(),
        description: z.string(),
        source: z.literal("commanded"),
        calibrated: z.boolean(),
        previewTravel: z
          .object({
            direction: vector.refine(
              (v) => v[2] === 0 && Math.hypot(v[0], v[1]) > 0,
              "Ground travel needs a nonzero horizontal direction",
            ),
            strideMm: z.number().finite().positive(),
          })
          .optional(),
        joints: z.array(
          z
            .object({
              entityId: id,
              channel: z.string().optional(),
              pulsePerDegree: z.number().finite().optional(),
              drivenEntityIds: z.array(id).optional(),
              axis: vector,
              centerUs: z.number().finite(),
              minUs: z.number().finite(),
              maxUs: z.number().finite(),
            })
            .passthrough(),
        ),
        phases: z.array(
          z
            .object({
              label: z.string(),
              targets: z.record(z.number().finite()),
              durationMs: z.number().nonnegative(),
              settleMs: z.number().nonnegative(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .optional(),
    hardware: z
      .object({
        version: z.literal(1),
        name: z.string(),
        description: z.string(),
        capabilities: z.array(
          z.object({
            id,
            label: z.string(),
            description: z.string(),
            kind: z.enum(["read", "write", "motion"]),
            command: z.string().min(1),
            args: z.array(z.string()),
            inputSchema: z.record(z.unknown()),
            timeoutMs: z.number().positive().optional(),
            persistent: z.boolean().optional(),
          }),
        ),
      })
      .optional(),
  })
  .strict();
export function safeRelative(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.split("/").some((p) => p.startsWith(".cutucircuits-"))
  )
    throw new CutuError(
      "INVALID_PATH",
      "Use a confined project-relative file path",
    );
}
export function validateProject(value: unknown): Project {
  const result = projectSchema.safeParse(value);
  if (!result.success)
    throw new CutuError(
      "INVALID_PROJECT",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  const p = result.data as Project;
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length)
      throw new CutuError("INVALID_PROJECT", `Duplicate ${label} identity`);
  };
  unique(
    p.entities.map((x) => x.id),
    "entity",
  );
  unique(
    p.assets.map((x) => x.id),
    "asset",
  );
  unique(
    p.links.map((x) => x.id),
    "link",
  );
  unique(p.hardware?.capabilities.map((x) => x.id) ?? [], "capability");
  unique(p.motion?.joints.map((j) => j.entityId) ?? [], "motion joint");
  const entities = new Map(p.entities.map((x) => [x.id, x]));
  const assets = new Set(p.assets.map((x) => x.id));
  const has = (value: string) => {
    if (!entities.has(value))
      throw new CutuError("INVALID_PROJECT", `Unknown entity: ${value}`);
  };
  for (const e of p.entities) {
    if (e.parentId) has(e.parentId);
    if (e.geometry?.assetId && !assets.has(e.geometry.assetId))
      throw new CutuError(
        "INVALID_PROJECT",
        `Unknown geometry asset: ${e.geometry.assetId}`,
      );
    const seen = new Set([e.id]);
    let parent = e.parentId;
    while (parent) {
      if (seen.has(parent))
        throw new CutuError("INVALID_PROJECT", "Entity parent cycle");
      seen.add(parent);
      parent = entities.get(parent)?.parentId;
    }
  }
  for (const a of p.assets) {
    safeRelative(a.path);
    a.entityIds.forEach(has);
  }
  for (const l of p.links) {
    has(l.source);
    has(l.target);
  }
  for (const j of p.motion?.joints ?? []) {
    has(j.entityId);
    j.drivenEntityIds?.forEach(has);
    if (j.minUs > j.centerUs || j.centerUs > j.maxUs)
      throw new CutuError("INVALID_PROJECT", "Invalid joint pulse range");
  }
  for (const phase of p.motion?.phases ?? [])
    for (const target of Object.keys(phase.targets)) {
      has(target);
      if (!p.motion?.joints.some((j) => j.entityId === target))
        throw new CutuError(
          "INVALID_PROJECT",
          `Motion target is not a joint: ${target}`,
        );
    }
  return p;
}

const selectionContextSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    icon: z.string().optional(),
    groupLabel: z.string().optional(),
    data: z.unknown().optional(),
    includeData: z.boolean().optional(),
  })
  .strict();
const selectionSchema = z.object({
  entityId: z.string().min(1).nullable(),
  assetId: z.string().min(1).optional(),
  origin: z.enum(["workspace", "codex"]),
  context: z.array(selectionContextSchema).optional(),
});
function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new CutuError(
      "INVALID_SELECTION",
      "Selection context must contain finite, JSON-serializable values",
    );
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new CutuError(
      "INVALID_SELECTION",
      "Selection context data must contain plain JSON objects",
    );
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value))
    assertJsonValue(child, ancestors);
  ancestors.delete(value);
}
export function validateSelectionInput(input: unknown) {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success)
    throw new CutuError(
      "INVALID_SELECTION",
      "Selection requires entityId, origin and an optional context array of labeled items",
    );
  if (parsed.data.context !== undefined) {
    try {
      for (const item of parsed.data.context)
        if (item.data !== undefined) assertJsonValue(item.data);
    } catch (error) {
      if (error instanceof CutuError) throw error;
      throw new CutuError(
        "INVALID_SELECTION",
        "Selection context must contain bounded JSON-serializable values",
      );
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data.context)) > 32 * 1024)
      throw new CutuError(
        "INVALID_SELECTION",
        "Selection context exceeds 32 KiB",
      );
  }
  return parsed.data;
}
