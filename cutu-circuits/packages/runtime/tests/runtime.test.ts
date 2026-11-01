import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectStore, sha256 } from "../src/store.js";
import { createRuntime } from "../src/server.js";
import type { Operation, WorkspaceEvent } from "@cutucircuits/core";
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cutucircuits-test-"));
  const templatesDir = path.join(dir, "templates");
  const base = {
    version: 1,
    id: "template",
    name: "Template",
    description: "Test",
    revision: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    units: "mm",
    entities: [
      {
        id: "board",
        name: "Board",
        kind: "board",
        position: [0, 0, 0],
        metadata: {},
      },
    ],
    links: [],
    assets: [
      {
        id: "source",
        name: "Circuit",
        path: "board.circuit.tsx",
        kind: "circuit",
        entityIds: ["board"],
      },
    ],
  };
  for (const name of ["blank", "spidey", "sensor"]) {
    const root = path.join(templatesDir, name);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "cutucircuits.project.json"),
      JSON.stringify(base),
    );
    await fs.writeFile(
      path.join(root, "board.circuit.tsx"),
      "export default () => <board />",
    );
  }
  return {
    dir,
    options: {
      dataDir: path.join(dir, "data"),
      templatesDir,
      seed: false,
      pollIntervalMs: 0,
    },
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
const conflict = (code: string) => (e: unknown) =>
  (e as { code: string }).code === code;
test("HTTP CAD cache rereads saved source, isolates projects and honors explicit refresh", async () => {
  const f = await fixture();
  let calls = 0;
  const runtime = await createRuntime({ ...f.options, port: 0, engines: {
    async compileCad(source: string) { calls++; return { kind: "cad", sourceSha256: sha256(source), call: calls }; },
  } as never });
  try {
    const first = await runtime.store.create("First", "blank");
    const second = await runtime.store.create("Second", "blank");
    const a = await runtime.store.write(first.id, "shape.replicad.ts", "source", null);
    await runtime.store.write(second.id, "shape.replicad.ts", "source", null);
    const server = await runtime.listen();
    const port = (server.address() as { port: number }).port;
    const compile = async (id: string, body: object = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/${id}/compile`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "shape.replicad.ts", ...body }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ call: number; sourceSha256: string }>;
    };
    assert.equal((await compile(first.id, { parameters: { x: 1, y: true } })).call, 1);
    assert.equal((await compile(first.id, { parameters: { y: true, x: 1 } })).call, 1);
    assert.equal((await compile(second.id, { parameters: { x: 1, y: true } })).call, 2);
    assert.equal((await compile(first.id, { parameters: { x: 1, y: true }, force: true })).call, 3);
    await runtime.store.write(first.id, "shape.replicad.ts", "changed", a.sha256);
    const changed = await compile(first.id, { parameters: { x: 1, y: true } });
    assert.equal(changed.call, 4);
    assert.equal(changed.sourceSha256, sha256("changed"));
  } finally { await runtime.close(); await f.cleanup(); }
});
test("projects and selection persist across restart; templates are copied and seed once", async () => {
  const f = await fixture();
  let store = await new ProjectStore({ ...f.options, seed: true }).init();
  try {
    const projects = await store.list();
    assert.equal(projects.length, 2);
    const p = await store.get(projects[0].id);
    assert.notEqual(p.id, "template");
    await store.select(p.id, {
      entityId: "board",
      assetId: "source",
      origin: "codex",
      context: [
        {
          id: "pin:gpio",
          label: "GPIO",
          description: "Selected controller pin",
          groupLabel: "Pins",
          icon: "pin",
          includeData: true,
          data: { pin: 14, net: "signal", geometry: { face: 3 } },
        },
      ],
    });
    const selected = await store.selection(p.id);
    await store.close();
    store = await new ProjectStore({ ...f.options, seed: true }).init();
    assert.equal((await store.list()).length, 2);
    assert.deepEqual(await store.selection(p.id), selected);
    assert.equal(
      (await store.read(p.id, "board.circuit.tsx")).content,
      "export default () => <board />",
    );
  } finally {
    await store.close();
    await f.cleanup();
  }
});
test("serialized CAS and graph revisions reject lost updates without changing source", async () => {
  const f = await fixture();
  const store = await new ProjectStore(f.options).init();
  try {
    const p = await store.create("Project");
    const source = await store.read(p.id, "board.circuit.tsx");
    const results = await Promise.allSettled(
      ["first", "second"].map((content) =>
        store.write(p.id, source.path, content, source.sha256),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal((await store.get(p.id)).revision, 1);
    await assert.rejects(
      store.patch(p.id, 0, { name: "stale" }),
      conflict("REVISION_CONFLICT"),
    );
    await assert.rejects(
      store.patch(p.id, 1, { id: "other" }),
      conflict("IMMUTABLE_FIELD"),
    );
    await assert.rejects(
      store.patch(p.id, 1, {
        links: [
          {
            id: "broken",
            source: "board",
            target: "missing",
            kind: "electrical",
          },
        ],
      }),
      conflict("INVALID_PROJECT"),
    );
    await assert.rejects(
      store.patch(p.id, 1, {
        entities: [{ ...p.entities[0], parentId: "board" }],
      }),
      conflict("INVALID_PROJECT"),
    );
    assert.equal((await store.get(p.id)).revision, 1);
    const updated = await store.patch(p.id, 1, { name: "Renamed" });
    assert.equal(updated.revision, 2);
    await store.write(p.id, "new/nested.txt", "new", null);
    await assert.rejects(
      store.write(p.id, "new/nested.txt", "overwrite", null),
      conflict("HASH_CONFLICT"),
    );
  } finally {
    await store.close();
    await f.cleanup();
  }
});
test("native files are confined, manifest is guarded, symlink traversal is refused", async () => {
  const f = await fixture();
  const store = await new ProjectStore(f.options).init();
  try {
    const p = await store.create("Project");
    for (const filename of [
      "../escape",
      "/tmp/escape",
      "a/../../escape",
      "a\\escape",
      "C:/escape",
      "a//b",
      ".cutucircuits-selection.json",
    ])
      await assert.rejects(
        store.write(p.id, filename, "x", null),
        conflict("INVALID_PATH"),
      );
    await assert.rejects(
      store.write(p.id, "cutucircuits.project.json", "{}", null),
      conflict("INVALID_PATH"),
    );
    const outside = path.join(f.dir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret"), "secret");
    await fs.symlink(
      outside,
      path.join(store.root(p.id), "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      store.read(p.id, "linked/secret"),
      conflict("INVALID_PATH"),
    );
    await assert.rejects(
      store.write(p.id, "linked/write", "x", null),
      conflict("INVALID_PATH"),
    );
    await assert.rejects(
      store.get("../outside"),
      conflict("INVALID_PROJECT_ID"),
    );
    assert.equal(
      await fs.readFile(path.join(outside, "secret"), "utf8"),
      "secret",
    );
  } finally {
    await store.close();
    await f.cleanup();
  }
});
test("external source edits generate file events, fresh reads and revision updates", async () => {
  const f = await fixture();
  const store = await new ProjectStore(f.options).init();
  try {
    const p = await store.create("Project");
    const events: WorkspaceEvent[] = [];
    const stop = store.events.subscribe(p.id, (event) => events.push(event));
    await fs.writeFile(
      path.join(store.root(p.id), "board.circuit.tsx"),
      "terminal edit",
    );
    assert.equal(
      (await store.read(p.id, "board.circuit.tsx")).content,
      "terminal edit",
    );
    await store.poll();
    assert.equal((await store.get(p.id)).revision, 1);
    assert.ok(events.some((e) => e.type === "file.updated"));
    await store.poll();
    assert.equal((await store.get(p.id)).revision, 1);
    const manifest = await store.get(p.id);
    manifest.description = "Terminal metadata";
    await fs.writeFile(
      path.join(store.root(p.id), "cutucircuits.project.json"),
      JSON.stringify(manifest),
    );
    await store.poll();
    assert.equal((await store.get(p.id)).revision, 2);
    assert.equal((await store.get(p.id)).description, "Terminal metadata");
    assert.ok(events.some((e) => e.type === "project.updated"));
    stop();
  } finally {
    await store.close();
    await f.cleanup();
  }
});
test("HTTP API supports edits, errors, origin guards, compile/export, operations, and SSE", async () => {
  const f = await fixture();
  const operations: Operation[] = [];
  const runner = {
    run(
      projectId: string,
      _root: string,
      capability: { id: string; label: string },
    ) {
      const op: Operation = {
        id: "op",
        projectId,
        capabilityId: capability.id,
        label: capability.label,
        status: "running",
        startedAt: new Date().toISOString(),
        output: "",
      };
      operations.push(op);
      return op;
    },
    async cancel() {
      operations[0].status = "cancelled";
      return operations[0];
    },
    list(projectId: string) {
      return operations.filter((o) => o.projectId === projectId);
    },
    async dispose() {},
  };
  const engines = {
    async compileCircuit(source: string, path: string) {
      return { kind: "circuit", path, source, circuitJson: [] };
    },
    async compileCad(source: string) {
      return { kind: "cad", sourceSha256: sha256(source) };
    },
    async exportCircuit() {
      return { name: "bom.csv", mimeType: "text/csv", content: "test" };
    },
    async exportCad() {
      return {};
    },
  };
  const runtime = await createRuntime({
    ...f.options,
    port: 0,
    runner,
    engines: engines as never,
  });
  const server = await runtime.listen();
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (
    route: string,
    body?: unknown,
    method = "POST",
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : method,
      headers: { "Content-Type": "application/json", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  try {
    assert.equal((await call("/api/health")).json.status, "ok");
    const created = await call("/api/projects", { name: "HTTP" });
    assert.equal(created.status, 201);
    const p = created.json;
    const url = `/api/projects/${p.id}`;
    const environment = await call(url + "/environment");
    assert.equal(environment.status, 200);
    assert.equal(environment.json.projectRoot, runtime.store.root(p.id));
    assert.ok((await fs.stat(environment.json.projectRoot)).isDirectory());
    assert.equal(
      environment.json.projectFile,
      path.join(environment.json.projectRoot, "cutucircuits.project.json"),
    );
    assert.equal(environment.json.platform, process.platform);
    assert.equal(environment.json.nodeVersion, process.version);
    assert.equal(
      (await call("/api/projects/bad%20id/environment")).json.error.code,
      "INVALID_PROJECT_ID",
    );
    assert.equal((await call("/api/projects/missing/environment")).status, 404);

    assert.equal((await call(url)).json.id, p.id);
    assert.equal(
      (
        await call(
          url,
          { expectedRevision: 0, changes: { name: "bad" } },
          "PATCH",
          { Origin: "https://attacker.example" },
        )
      ).status,
      403,
    );
    const file = (await call(url + "/files?path=board.circuit.tsx")).json;
    assert.equal(
      (
        await call(
          url + "/files",
          { path: file.path, content: "updated", expectedSha256: file.sha256 },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          url + "/files",
          { path: file.path, content: "stale", expectedSha256: file.sha256 },
          "PUT",
        )
      ).status,
      409,
    );
    assert.equal(
      (await call(url + "/compile", { path: file.path })).json.kind,
      "circuit",
    );
    assert.equal(
      (await call(url + "/export", { path: file.path, format: "bom" })).json
        .content,
      "test",
    );
    const latest = (await call(url)).json;
    await call(
      url,
      {
        expectedRevision: latest.revision,
        changes: {
          hardware: {
            version: 1,
            name: "Test",
            description: "Test",
            capabilities: [
              {
                id: "safe",
                label: "Safe",
                description: "Test",
                kind: "read",
                command: "test",
                args: [],
                inputSchema: {},
              },
            ],
          },
        },
      },
      "PATCH",
    );
    assert.equal(
      (await call(url + "/operations", { capabilityId: "unknown", inputs: {} }))
        .status,
      400,
    );
    assert.equal(
      (await call(url + "/operations", { capabilityId: "safe", inputs: {} }))
        .status,
      202,
    );
    assert.equal(
      (await call(url + "/operations/op/cancel", {})).json.status,
      "cancelled",
    );
    const abort = new AbortController();
    const stream = await fetch(base + url + "/events", {
      signal: abort.signal,
    });
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /connected/);
    await call(
      url + "/selection",
      { entityId: "board", origin: "codex" },
      "PUT",
    );
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /selection.updated/);
    const registered = await call(url + "/editor-sessions", {
      sessionId: "session",
      path: file.path,
      tools: [
        {
          name: "electronics.inspect",
          description: "Inspect",
          inputSchema: {},
          access: { kind: "editor-read" },
        },
        {
          name: "edit",
          description: "Edit",
          inputSchema: {},
          access: { kind: "editor-write" },
        },
      ],
    });
    assert.equal(registered.status, 200);
    const catalog = await call(url + "/editor-tools");
    assert.equal(catalog.json.length, 2);
    assert.equal(typeof catalog.json[0].sha256, "string");
    assert.equal(
      (await call(url + "/editor-tools/edit", { params: {} })).json.error.code,
      "HASH_REQUIRED",
    );
    assert.equal(
      (
        await call(url + "/editor-tools/edit", {
          params: {},
          expectedSha256: file.sha256,
        })
      ).status,
      409,
    );
    const invocation = call(url + "/editor-tools/electronics.inspect", {
      params: { entity: "board" },
      sessionId: "session",
    });
    const request = await reader.read();
    const line = new TextDecoder()
      .decode(request.value)
      .split("\n")
      .find((line) => line.startsWith("data: "));
    const envelope = JSON.parse(line!.slice(6));
    assert.equal(envelope.type, "editor-tool-request");
    assert.equal(envelope.data.params.entity, "board");
    assert.equal(
      (
        await call(url + "/editor-sessions/wrong/results", {
          requestId: envelope.data.requestId,
          result: { ok: false },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(url + "/editor-sessions/session/results", {
          requestId: envelope.data.requestId,
          result: { components: 3 },
        })
      ).status,
      200,
    );
    assert.deepEqual((await invocation).json, { components: 3 });
    const pendingCall = call(url + "/editor-tools/electronics.inspect", {
      params: {},
      sessionId: "session",
    });
    await reader.read();
    await fetch(base + url + "/editor-sessions/session", { method: "DELETE" });
    assert.equal((await pendingCall).json.error.code, "EDITOR_DISCONNECTED");
    const sessionAbort = new AbortController();
    const sessionStream = await fetch(
      base + url + "/events?sessionId=disconnect",
      { signal: sessionAbort.signal },
    );
    const sessionReader = sessionStream.body!.getReader();
    await sessionReader.read();
    await call(url + "/editor-sessions", {
      sessionId: "disconnect",
      path: file.path,
      tools: [
        {
          name: "electronics.inspect",
          description: "Inspect",
          inputSchema: {},
          access: { kind: "editor-read" },
        },
      ],
    });
    const disconnectedCall = call(url + "/editor-tools/electronics.inspect", {
      params: {},
      sessionId: "disconnect",
    });
    await sessionReader.read();
    sessionAbort.abort();
    await sessionReader.cancel().catch(() => {});
    assert.equal(
      (await disconnectedCall).json.error.code,
      "EDITOR_DISCONNECTED",
    );
    await runtime.store.write(
      p.id,
      "authored.replicad.ts",
      "export default () => []",
      null,
    );
    assert.equal(
      (await call(url + "/compile", { path: "authored.replicad.ts" })).json
        .kind,
      "cad",
    );
    abort.abort();
    await reader.cancel().catch(() => {});
    assert.equal((await call(url + "/selection")).json.entityId, "board");
    assert.equal((await call(url + "/files?path=..%2Fescape")).status, 400);
  } finally {
    await runtime.close();
    await f.cleanup();
  }
});

test("selection context rejects invalid state and clears stale graph references", async () => {
  const f = await fixture();
  const store = await new ProjectStore(f.options).init();
  try {
    const p = await store.create("Selection");
    const context = [
      {
        id: "face:3",
        label: "Face",
        description: "Native face selection",
        data: { normal: [0, 0, 1] },
      },
    ];
    const selected = await store.select(p.id, {
      entityId: "board",
      assetId: "source",
      origin: "workspace",
      context,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const invalid of [
      null,
      {},
      [{ id: "a", label: "A" }],
      [{ id: "a", label: "A", description: "D", includeData: "yes" }],
      [{ id: "a", label: "A", description: "D", data: "x".repeat(32768) }],
      [{ id: "a", label: "A", description: "D", data: { x: Infinity } }],
      [{ id: "a", label: "A", description: "D", data: { fn: () => 0 } }],
      [{ id: "a", label: "A", description: "D", data: circular }],
    ]) {
      await assert.rejects(
        store.select(p.id, {
          entityId: "board",
          origin: "workspace",
          context: invalid,
        }),
        conflict("INVALID_SELECTION"),
      );
      assert.deepEqual(await store.selection(p.id), selected);
    }
    await assert.rejects(
      store.select(p.id, { entityId: "missing", origin: "codex", context }),
      conflict("INVALID_SELECTION"),
    );
    await store.patch(p.id, p.revision, { entities: [], assets: [] });
    const cleared = await store.selection(p.id);
    assert.equal(cleared.entityId, null);
    assert.equal(cleared.assetId, undefined);
    assert.equal(cleared.context, undefined);
    await store.select(p.id, {
      entityId: null,
      origin: "workspace",
      context: [],
    });
    assert.deepEqual((await store.selection(p.id)).context, []);
  } finally {
    await store.close();
    await f.cleanup();
  }
});
