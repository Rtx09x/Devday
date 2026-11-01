import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = fileURLToPath(
  new URL("../../../plugins/cutucircuits/scripts/launch.mjs", import.meta.url),
);
const hash = "a".repeat(64);
test("official SDK client executes actual packaged stdio tools against HTTP broker", async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    calls.push({ method: request.method!, url: request.url!, body });
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("conflict")) {
      response.writeHead(409).end(
        JSON.stringify({
          error: {
            code: "HASH_CONFLICT",
            message: "Source changed; reread it.",
          },
        }),
      );
      return;
    }
    if (request.url === "/api/health")
      response.end(
        JSON.stringify({
          name: "Cutu Circuits",
          status: "ok",
          version: "0.1.0",
        }),
      );
    else if (request.url === "/api/projects/p")
      response.end(
        JSON.stringify({
          id: "p",
          revision: 4,
          hardware: { capabilities: [{ id: "program" }] },
        }),
      );
    else
      response.end(
        JSON.stringify({
          ok: true,
          method: request.method,
          url: request.url,
          body,
        }),
      );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: tmpdir(),
    env: {
      ...(process.env as Record<string, string>),
      CUTUCIRCUITS_URL: `http://127.0.0.1:${address.port}`,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "cutucircuits-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 27);
    const invoke = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, JSON.stringify(result));
      return result;
    };
    await invoke("runtime_status");
    await invoke("list_projects");
    await invoke("create_project", { name: "Fixture", template: "blank" });
    await invoke("get_project", { projectId: "p" });
    await invoke("project_environment", { projectId: "p" });
    assert.equal(calls.at(-1)?.url, "/api/projects/p/environment");
    await invoke("list_files", { projectId: "p" });
    assert.equal(calls.at(-1)?.url, "/api/projects/p/file-list");
    await invoke("read_file", { projectId: "p", path: "models/a b.js" });
    assert.equal(
      calls.at(-1)?.url,
      "/api/projects/p/files?path=models%2Fa%20b.js",
    );
    await invoke("write_file", {
      projectId: "p",
      path: "model.js",
      content: "native source",
      expectedSha256: hash,
    });
    assert.equal(calls.at(-1)?.body.expectedSha256, hash);
    const before = calls.length;
    const missingGuard = await client.callTool({
      name: "write_file",
      arguments: { projectId: "p", path: "model.js", content: "unsafe" },
    });
    assert(missingGuard.isError);
    assert.equal(calls.length, before);
    await invoke("write_file", {
      projectId: "p",
      path: "new.js",
      content: "",
      expectedSha256: null,
    });
    await invoke("update_graph", {
      projectId: "p",
      expectedRevision: 4,
      changes: { name: "Changed" },
    });
    assert.equal(calls.at(-1)?.body.expectedRevision, 4);
    await invoke("get_selection", { projectId: "p" });
    await invoke("set_selection", { projectId: "p", entityId: null });
    assert.equal(calls.at(-1)?.body.origin, "codex");
    await invoke("compile", {
      projectId: "p",
      path: "model.js",
      parameters: { width: 4 },
    });
    await invoke("export", {
      projectId: "p",
      path: "model.js",
      format: "step",
    });
    await invoke("hardware_capabilities", { projectId: "p" });
    await invoke("run_operation", {
      projectId: "p",
      capabilityId: "program",
      inputs: { cycles: 1 },
    });
    await invoke("send_operation", {
      projectId: "p",
      operationId: "op",
      message: { type: "status" },
    });
    assert.deepEqual(calls.at(-1)?.body, { message: { type: "status" } });
    await invoke("list_operations", { projectId: "p" });
    await invoke("cancel_operation", { projectId: "p", operationId: "op" });
    await invoke("list_editor_tools", { projectId: "p" });
    await invoke("call_editor_tool", {
      projectId: "p",
      name: "edit_native",
      params: { x: 3 },
      sessionId: "s",
      expectedSha256: hash,
    });
    assert.deepEqual(calls.at(-1)?.body, {
      params: { x: 3 },
      sessionId: "s",
      expectedSha256: hash,
    });
    const conflict = await client.callTool({
      name: "read_file",
      arguments: { projectId: "conflict", path: "a" },
    });
    assert(conflict.isError);
    assert.match(JSON.stringify(conflict.content), /HASH_CONFLICT/);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("packaged launcher reports a missing runtime without starting one", async () => {
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: tmpdir(),
    env: {
      ...(process.env as Record<string, string>),
      CUTUCIRCUITS_URL: "http://127.0.0.1:1",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "runtime_status",
      arguments: {},
    });
    assert(result.isError);
    assert.match(JSON.stringify(result.content), /RUNTIME_UNREACHABLE/);
    assert.match(JSON.stringify(result.content), /npm start/);
  } finally {
    await client.close();
  }
});

test("copied plugin cache launches its standalone bundle without repository dependencies", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "cutucircuits-plugin-cache-"));
  const copied = resolve(temp, "installed-plugin");
  await cp(
    fileURLToPath(new URL("../../../plugins/cutucircuits", import.meta.url)),
    copied,
    { recursive: true },
  );
  const environment: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CUTUCIRCUITS_URL: "http://127.0.0.1:1",
  };
  delete environment.CUTUCIRCUITS_REPO;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(copied, "scripts/launch.mjs")],
    cwd: tmpdir(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "cache-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 27);
    const result = await client.callTool({
      name: "runtime_status",
      arguments: {},
    });
    assert(result.isError);
    assert.match(JSON.stringify(result.content), /RUNTIME_UNREACHABLE/);
  } finally {
    await client.close();
    await rm(temp, { recursive: true, force: true });
  }
});

