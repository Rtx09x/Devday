import { z } from "zod";
import { projectPath } from "./client.ts";
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  handler: (input: any) => Promise<unknown>;
  readOnly: boolean;
}
export function createToolRegistry(broker: {
  baseUrl: string;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const id = z
    .string()
    .min(1)
    .describe("Exact opaque ID returned by the runtime.");
  const parameters = z.record(
    z.union([z.number().finite(), z.boolean(), z.string()]),
  );
  const register = (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (input: any) => Promise<unknown>,
    readOnly = false,
  ) => {
    tools.push({
      name,
      description,
      schema: z.object(schema).strict(),
      handler,
      readOnly,
    });
  };
  register(
    "runtime_status",
    "Check the real local runtime connection; an unavailable runtime returns its start command. Does not start services or claim an active Codex session.",
    {},
    async () => ({
      url: broker.baseUrl,
      health: await broker.request("GET", "/api/health"),
    }),
    true,
  );
  register(
    "list_projects",
    "List persisted engineering projects and their exact IDs.",
    {},
    () => broker.request("GET", "/api/projects"),
    true,
  );
  register(
    "create_project",
    "Create a persistent project from a native source template.",
    {
      name: z.string().trim().min(1),
      template: z.enum(["spidey", "sensor", "blank", "robot"]).optional(),
    },
    (input) => broker.request("POST", "/api/projects", input),
  );
  register(
    "get_project",
    "Read the authoritative project graph, revision, assets and hardware capability manifest.",
    { projectId: id },
    ({ projectId }) => broker.request("GET", projectPath(projectId)),
    true,
  );
  register(
    "build_makada",
    "Start or stop the slow, leg-by-leg Makada assembly presentation in the open project view. Requires an open workspace to acknowledge it. Visual only: never edits source, starts walking, or commands physical hardware.",
    { projectId: id, action: z.enum(["start", "stop"]).default("start") },
    ({ projectId, action }) => broker.request("POST", `${projectPath(projectId)}/presentation/build`, { action }),
    true,
  );
  register(
    "project_environment",
    "Discover the actual local project root and working directory for terminal-based authoring, setup and program execution. Returns runtime-resolved paths and versions, without credentials.",
    { projectId: id },
    ({ projectId }) =>
      broker.request("GET", `${projectPath(projectId)}/environment`),
    true,
  );
  register(
    "list_files",
    "List actual project-relative files before reading or editing native source and device programs.",
    { projectId: id },
    ({ projectId }) =>
      broker.request("GET", `${projectPath(projectId)}/file-list`),
    true,
  );
  register(
    "read_file",
    "Read a project-relative native source file and its SHA-256. Use this hash for a subsequent write.",
    { projectId: id, path: z.string().min(1) },
    ({ projectId, path }) =>
      broker.request(
        "GET",
        `${projectPath(projectId)}/files?path=${encodeURIComponent(path)}`,
      ),
    true,
  );
  register(
    "write_file",
    "Persist native source through the broker with mandatory compare-and-swap. Supply the exact observed SHA-256, or null only for a new file. On conflict reread and reconcile.",
    {
      projectId: id,
      path: z.string().min(1),
      content: z.string(),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    },
    ({ projectId, ...body }) =>
      broker.request("PUT", `${projectPath(projectId)}/files`, body),
  );
  register(
    "list_file_history",
    "List immutable saved versions of native project files. Optional path filters one file; results contain metadata without source content. Versions start when the runtime first observes or saves content.",
    {
      projectId: id,
      path: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    ({ projectId, path, limit }) => {
      const query = new URLSearchParams();
      if (path !== undefined) query.set("path", path);
      if (limit !== undefined) query.set("limit", String(limit));
      return broker.request(
        "GET",
        `${projectPath(projectId)}/history?${query}`,
      );
    },
    true,
  );
  register(
    "read_file_version",
    "Read the content and metadata of an immutable version returned by list_file_history. This does not change the current file.",
    { projectId: id, versionId: id },
    ({ projectId, versionId }) =>
      broker.request(
        "GET",
        `${projectPath(projectId)}/history/${encodeURIComponent(versionId)}`,
      ),
    true,
  );
  register(
    "restore_file_version",
    "Restore a native-file version as a new guarded save, retaining the current version in history. Read the current file first and supply its exact SHA-256; null only if the file is missing. Conflicts require reconciliation. Project-manifest restoration is unsupported.",
    {
      projectId: id,
      versionId: id,
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    },
    ({ projectId, versionId, expectedSha256 }) =>
      broker.request(
        "POST",
        `${projectPath(projectId)}/history/${encodeURIComponent(versionId)}/restore`,
        { expectedSha256 },
      ),
  );
  register(
    "import_urdf",
    "Validate and save a new project-local URDF/XML file and register its Robot asset through the runtime recovery journal. Existing files are never overwritten. Referenced meshes must already exist in the project; relative paths and package://pkg/path resolve locally. Uses SI metres/kilograms/radians.",
    {
      projectId: id,
      path: z.string().min(1),
      content: z.string().min(1),
      name: z.string().trim().min(1).max(200).optional(),
    },
    ({ projectId, ...body }) =>
      broker.request("POST", `${projectPath(projectId)}/robotics/import`, body),
  );
  register(
    "inspect_robot",
    "Parse a saved URDF and inspect actual links, joints, authored limits, inertia and model diagnostics. Values use SI metres/kilograms/radians. This is model inspection, not measured hardware feedback.",
    { projectId: id, path: z.string().min(1) },
    ({ projectId, path }) =>
      broker.request("POST", `${projectPath(projectId)}/robotics/inspect`, {
        path,
      }),
    true,
  );
  register(
    "simulate_robot",
    "Run real, bounded Rapier rigid-body simulation of a saved URDF in a disposable process. Returns initial/final poses, joint positions, contacts and diagnostics labelled simulated. Joint targets respect declared limits; authored effort/velocity ratings are not a calibrated servo model. Never sends hardware commands.",
    {
      projectId: id,
      path: z.string().min(1),
      durationSeconds: z.number().finite().min(0).max(10).optional(),
      fixedBase: z.boolean().optional(),
      ground: z.boolean().optional(),
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
      jointTargets: z.record(z.number().finite()).optional(),
    },
    ({ projectId, ...body }) =>
      broker.request(
        "POST",
        `${projectPath(projectId)}/robotics/simulate`,
        body,
      ),
    true,
  );
  register(
    "update_graph",
    "Update project graph using the exact observed revision. Preserve stable entity/asset/link IDs. Immutable identity and timestamps cannot be changed.",
    {
      projectId: id,
      expectedRevision: z.number().int().nonnegative(),
      changes: z.record(z.unknown()),
    },
    ({ projectId, ...body }) =>
      broker.request("PATCH", projectPath(projectId), body),
  );
  register(
    "get_selection",
    "Inspect the selection shared with the workspace UI.",
    { projectId: id },
    ({ projectId }) =>
      broker.request("GET", `${projectPath(projectId)}/selection`),
    true,
  );
  register(
    "set_selection",
    "Select an exact entity/asset in the workspace, or clear with null.",
    { projectId: id, entityId: id.nullable(), assetId: id.optional() },
    ({ projectId, ...body }) =>
      broker.request("PUT", `${projectPath(projectId)}/selection`, {
        ...body,
        origin: "codex",
      }),
  );
  register(
    "compile",
    "Compile persisted .circuit.tsx or native Replicad source. Returns real engine diagnostics and geometry; no measured hardware state.",
    {
      projectId: id,
      path: z.string().min(1),
      parameters: parameters.optional(),
      force: z
        .boolean()
        .optional()
        .describe(
          "Bypass the compile cache and explicitly re-execute the saved source. Execution requires trusted source and embedded-agent approval.",
        ),
    },
    ({ projectId, ...body }) =>
      broker.request("POST", `${projectPath(projectId)}/compile`, body),
    true,
  );
  register(
    "export",
    "Export persisted source through its real engine: CAD STEP/STL/OBJ or circuit SVG/BOM. Returns downloadable artifact content.",
    {
      projectId: id,
      path: z.string().min(1),
      format: z.enum(["step", "stl", "obj", "svg", "bom"]),
      parameters: parameters.optional(),
    },
    ({ projectId, ...body }) =>
      broker.request("POST", `${projectPath(projectId)}/export`, body),
    true,
  );
  register(
    "hardware_capabilities",
    "Read project-defined device/program capabilities and input schemas. Commanded values and simulation do not imply measured hardware feedback.",
    { projectId: id },
    async ({ projectId }) => {
      const project = (await broker.request("GET", projectPath(projectId))) as {
        hardware?: unknown;
      };
      return project.hardware ?? { capabilities: [] };
    },
    true,
  );
  register(
    "run_operation",
    "Execute an exact capability from the current project manifest with validated inputs. May operate physical hardware. Only report measurements actually returned by the device; Makada has no shaft-position feedback.",
    { projectId: id, capabilityId: id, inputs: z.record(z.unknown()) },
    ({ projectId, ...body }) =>
      broker.request("POST", `${projectPath(projectId)}/operations`, body),
  );
  register(
    "send_operation",
    "Send a JSON control message to a live persistent project capability. The program defines and validates its control protocol; inspect its source before sending. Makada monitor status/walk/stop reuse the broker-owned connection. This does not imply measured servo feedback.",
    { projectId: id, operationId: id, message: z.record(z.unknown()) },
    ({ projectId, operationId, message }) =>
      broker.request(
        "POST",
        `${projectPath(projectId)}/operations/${encodeURIComponent(operationId)}/send`,
        { message },
      ),
  );
  register(
    "list_operations",
    "Inspect real operation status, output and telemetry. Do not relabel commanded pulses as measured angles.",
    { projectId: id },
    ({ projectId }) =>
      broker.request("GET", `${projectPath(projectId)}/operations`),
    true,
  );
  register(
    "cancel_operation",
    "Request cancellation of a running project capability and return its actual status.",
    { projectId: id, operationId: id },
    ({ projectId, operationId }) =>
      broker.request(
        "POST",
        `${projectPath(projectId)}/operations/${encodeURIComponent(operationId)}/cancel`,
        {},
      ),
  );
  register(
    "list_editor_tools",
    "List actual native electronics/CAD tool schemas exposed by mounted workspace editors, including session IDs and availability. Open the relevant asset in the workspace if no tools are available.",
    { projectId: id },
    ({ projectId }) =>
      broker.request("GET", `${projectPath(projectId)}/editor-tools`),
    true,
  );
  register(
    "call_editor_tool",
    "Invoke an exact native editor tool discovered via list_editor_tools. Pass its schema-valid params and sessionId. Advanced electronics/CAD mutations require a mounted editor; they preserve native handler semantics and saved-file guards.",
    {
      projectId: id,
      name: id,
      params: z.record(z.unknown()),
      sessionId: id.optional(),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe(
          "Exact read_file SHA-256; required for native source mutations.",
        ),
    },
    ({ projectId, name, ...body }) =>
      broker.request(
        "POST",
        `${projectPath(projectId)}/editor-tools/${encodeURIComponent(name)}`,
        body,
      ),
  );

  return tools;
}
