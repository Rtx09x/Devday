import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserHost } from "../src/browser.ts";
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
const project = { id: "p1", entities: [] };
const asset = { id: "a1", path: "board.circuit.tsx" };
const options = { project, asset };
test("host save requires a loaded source revision and sends that revision", async () => {
  let received;
  const host = new BrowserHost(options);
  host.request = async (path, init) => {
    if (init) {
      received = JSON.parse(init.body);
      return { ...received, sha256: "new" };
    }
    return { path: asset.path, content: "before", sha256: "observed" };
  };
  await assert.rejects(host.saveContent("after"), /Load the file/);
  assert.equal(await host.loadContent(), "before");
  await host.saveContent("after");
  assert.deepEqual(received, {
    path: asset.path,
    content: "after",
    expectedSha256: "observed",
  });
});
test("multi-file edits reject stale revisions before writing any file", async () => {
  const host = new BrowserHost(options);
  let writes = 0;
  host.request = async (path, init) => {
    if (init) {
      writes++;
      return {};
    }
    return { path: "a.ts", content: "newer", sha256: "newer" };
  };
  await assert.rejects(
    host.fs.write({
      label: "edit",
      actor: "agent",
      changes: [{ path: "a.ts", content: "changed", expectedSha256: "stale" }],
    }),
    /revision conflict/,
  );
  assert.equal(writes, 0);
});
test("filesystem writes preserve prior observed revision for broker conflict detection", async () => {
  const host = new BrowserHost(options);
  let expected;
  host.request = async (path, init) => {
    if (init) {
      expected = JSON.parse(init.body).expectedSha256;
      throw Object.assign(new Error("Revision conflict"), { status: 409 });
    }
    return { path: "a.ts", content: "old", sha256: "oldhash" };
  };
  await host.context.services.filesystem.readFile("a.ts");
  await assert.rejects(
    host.context.services.filesystem.writeFile("a.ts", "changed"),
    /Revision conflict/,
  );
  assert.equal(expected, "oldhash");
});
test("project filesystem rejects traversal before sending a request", async () => {
  const host = new BrowserHost(options);
  host.request = async () => {
    throw new Error("unexpected request");
  };
  await assert.rejects(host.read("../secret"), /inside the project/);
});
test("remote changes cannot advance the save revision of a dirty editor", async () => {
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  };
  const host = new BrowserHost(options);
  let remote = false;
  let writtenHash;
  let delivered = false;
  host.request = async (_path, init) => {
    if (init) {
      writtenHash = JSON.parse(init.body).expectedSha256;
      return { path: asset.path, content: "mine", sha256: "saved" };
    }
    return {
      path: asset.path,
      content: remote ? "theirs" : "before",
      sha256: remote ? "remote-hash" : "original-hash",
    };
  };
  await host.loadContent();
  host.setDirty(true);
  host.onFileChanged(() => {
    delivered = true;
  });
  remote = true;
  host.changes.forEach((cb) => cb([asset.path]));
  await new Promise((resolve) => setImmediate(resolve));
  await host.saveContent("mine");
  assert.equal(delivered, false);
  assert.equal(writtenHash, "original-hash");
});
test("structured servo reference wins over incidental controller text", async () => {
  const selectionProject = {
    id: "p1",
    entities: [
      { id: "controller", name: "Controller", metadata: { reference: "U1" } },
      { id: "servo-left", name: "Left servo", metadata: { ref: "J2" } },
    ],
  };
  let selected;
  const host = new BrowserHost({
    project: selectionProject,
    asset,
    onSelection: (id) => {
      selected = id;
    },
  });
  host.request = async () => ({});
  host.setEditorContextItems([
    {
      id: "component:c7",
      label: "J2",
      description: "Connected to controller U1",
      data: { sourceComponentId: "c7", ref: "J2", type: "connector" },
    },
  ]);
  assert.equal(selected, "servo-left");
});
test("CAD structured shape uses exact geometry identity", async () => {
  let selected;
  const host = new BrowserHost({
    project: {
      id: "p1",
      entities: [
        {
          id: "body",
          name: "body",
          metadata: {},
          geometry: { shapeName: "body" },
        },
        {
          id: "servo",
          name: "servo",
          metadata: {},
          geometry: { shapeName: "servo-arm" },
        },
      ],
    },
    asset,
    onSelection: (id) => {
      selected = id;
    },
  });
  host.request = async () => ({});
  host.setEditorContextItems([
    {
      id: "shape:servo-arm:face:1",
      label: "servo-arm / face 1",
      description: "body assembly",
      data: { shapeName: "servo-arm" },
    },
  ]);
  assert.equal(selected, "servo");
});
test("save conflict remains visible and keeps dirty state", async () => {
  const host = new BrowserHost(options);
  host.request = async (_path, init) => {
    if (init) throw new Error("File revision conflict");
    return { path: asset.path, content: "before", sha256: "old" };
  };
  await host.loadContent();
  host.setDirty(true);
  await assert.rejects(host.saveContent("mine"), /revision conflict/);
  assert.equal(host.dirty, true);
  assert.equal(host.saveError, "File revision conflict");
  assert.equal(host.saving, false);
});
test("arbitrary source reads cannot advance dirty editor baseline", async () => {
  const host = new BrowserHost(options);
  let remote = false;
  let written;
  host.request = async (_path, init) => {
    if (init) {
      written = JSON.parse(init.body).expectedSha256;
      return { path: asset.path, content: "mine", sha256: "saved" };
    }
    return {
      path: asset.path,
      content: remote ? "theirs" : "old",
      sha256: remote ? "remote" : "original",
    };
  };
  await host.loadContent();
  host.setDirty(true);
  remote = true;
  await host.context.services.filesystem.readFile(asset.path);
  await host.fs.read([asset.path]);
  await host.saveContent("mine");
  assert.equal(written, "original");
});
test("CAD parameter schemas register as broker inputSchema", async () => {
  let eventSource;
  globalThis.EventSource = class {
    constructor() {
      eventSource = this;
    }
    close() {}
  };
  const host = new BrowserHost(options);
  let registration;
  host.request = async (path, init) => {
    if (path === "/editor-sessions") registration = JSON.parse(init.body);
    return {};
  };
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };
  const disconnect = host.connect([
    {
      name: "replicad_compile",
      description: "Compile CAD",
      parameters: schema,
      handler: async () => ({ success: true }),
    },
  ]);
  eventSource.onopen();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registration.tools[0].inputSchema, schema);
  assert.equal("handler" in registration.tools[0], false);
  disconnect();
});
test("editor-write tool waits for the registered CAS save before succeeding", async () => {
  const host = new BrowserHost(options);
  let releaseWrite;
  let persisted = false;
  let finished = false;
  host.request = async (_path, init) => {
    if (init) {
      await new Promise((resolve) => {
        releaseWrite = resolve;
      });
      persisted = true;
      return { path: asset.path, content: "after", sha256: "new" };
    }
    return { path: asset.path, content: "before", sha256: "old" };
  };
  await host.loadContent();
  host.onSaveRequested(() => {
    void host.saveContent("after").catch(() => {});
  });
  const execution = host
    .executeTool(
      {
        name: "edit",
        description: "Edit",
        inputSchema: { type: "object" },
        access: { kind: "editor-write" },
        handler: async () => {
          host.setDirty(true);
          return { success: true };
        },
      },
      {},
    )
    .then((result) => {
      finished = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(persisted, false);
  releaseWrite();
  assert.equal((await execution).success, true);
  assert.equal(persisted, true);
  assert.equal(host.dirty, false);
});
test("editor-write SSE dispatch reports CAS save conflicts and retains edits", async () => {
  const host = new BrowserHost(options);
  let eventSource;
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      eventSource = this;
    }
    close() {}
  };
  let reply;
  host.request = async (path, init) => {
    if (path.includes("/results")) {
      reply = JSON.parse(init.body);
      return {};
    }
    if (path === "/editor-sessions") return {};
    if (init) throw new Error("File revision conflict");
    return { path: asset.path, content: "before", sha256: "old" };
  };
  await host.loadContent();
  host.onSaveRequested(() => {
    void host.saveContent("mine").catch(() => {});
  });
  const disconnect = host.connect([
    {
      name: "edit",
      description: "Edit",
      inputSchema: { type: "object" },
      access: { kind: "editor-write" },
      handler: async () => {
        host.setDirty(true);
        return { success: true };
      },
    },
  ]);
  eventSource.onopen();
  await new Promise((resolve) => setImmediate(resolve));
  const sessionId = new URL(
    eventSource.url,
    "http://localhost",
  ).searchParams.get("sessionId");
  eventSource.onmessage({
    data: JSON.stringify({
      type: "editor-tool-request",
      data: { sessionId, requestId: "r1", name: "edit", params: {} },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reply.result.success, false);
  assert.match(reply.result.error, /revision conflict/);
  assert.equal(host.dirty, true);
  assert.equal(host.saveError, "File revision conflict");
  disconnect();
});
test("preview and editor-read tools never trigger source saves", async () => {
  const host = new BrowserHost(options);
  let saves = 0;
  host.onSaveRequested(() => {
    saves++;
  });
  host.setDirty(true);
  await host.executeTool(
    {
      name: "read",
      description: "Read",
      inputSchema: { type: "object" },
      access: { kind: "editor-read" },
      handler: async () => ({ success: true }),
    },
    {},
  );
  assert.equal(saves, 0);
  host.setDirty(false);
  await host.executeTool(
    {
      name: "preview",
      description: "Preview",
      inputSchema: { type: "object" },
      access: { kind: "editor-write" },
      handler: async () => ({
        success: true,
        data: { requiresApproval: true },
      }),
    },
    {},
  );
  assert.equal(saves, 0);
});
test("an edit made during a save stays dirty and queued saves use the committed revision", async () => {
  const host = new BrowserHost(options);
  let release;
  const writes = [];
  host.request = async (_path, init) => {
    if (!init) return { path: asset.path, content: "zero", sha256: "v0" };
    const body = JSON.parse(init.body);
    writes.push(body);
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    return { path: asset.path, content: body.content, sha256: `v${writes.length}` };
  };
  await host.loadContent();
  host.setDirty(true);
  const first = host.saveContent("one");
  await new Promise(resolve => setImmediate(resolve));
  host.setDirty(true);
  release();
  await first;
  assert.equal(host.dirty, true, "newer edit must remain unsaved");
  const second = host.saveContent("two");
  host.setDirty(true);
  const third = host.saveContent("three");
  await Promise.all([second, third]);
  assert.deepEqual(writes.map(w => w.expectedSha256), ["v0", "v1", "v2"]);
  assert.deepEqual(writes.map(w => w.content), ["one", "two", "three"]);
  assert.equal(host.dirty, false);
  assert.equal(host.saving, false);
});
test("native tool handlers run in arrival order and a failure does not block the next", async () => {
  const host = new BrowserHost(options);
  let release;
  const calls = [];
  const tool = { name: "ordered", description: "ordered", handler: async ({ id }) => {
    calls.push(id);
    if (id === 1) { await new Promise(resolve => { release = resolve; }); throw new Error("first failed"); }
    return { success: true };
  }};
  const first = host.executeTool(tool, { id: 1 });
  const rejected = assert.rejects(first, /first failed/);
  const second = host.executeTool(tool, { id: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [1]);
  release();
  await rejected;
  await second;
  assert.deepEqual(calls, [1, 2]);
  await assert.rejects(host.executeTool(tool, { id: 3 }, () => false), /session closed/);
  assert.deepEqual(calls, [1, 2]);
});
test("a queued write checks the caller's observed source again before mutation", async () => {
  const host = new BrowserHost(options);
  let hash = "original";
  host.request = async () => ({ path: asset.path, content: "source", sha256: hash });
  await host.loadContent();
  let release;
  let mutations = 0;
  const tool = { name: "mutate", description: "mutate", access: { kind: "editor-write" }, handler: async () => {
    mutations++;
    await new Promise(resolve => { release = resolve; });
    hash = "changed";
    return { success: true };
  }};
  const first = host.executeTool(tool, {}, () => true, "original");
  const second = host.executeTool(tool, {}, () => true, "original");
  const rejected = assert.rejects(second, /source changed while this tool was waiting/i);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
  await rejected;
  assert.equal(mutations, 1);
});
test("browser online reconciles native source even when the SSE stream does not reopen", async () => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = { dispatchEvent() {}, addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) };
  let source;
  globalThis.EventSource = class { constructor() { source = this; } close() {} };
  const host = new BrowserHost(options);
  let remote = false, registrations = 0, delivered;
  host.request = async (path) => {
    if (path === "/editor-sessions") { registrations++; return {}; }
    return { path: asset.path, content: remote ? "new source" : "old source", sha256: remote ? "new" : "old" };
  };
  try {
    await host.loadContent();
    host.onFileChanged(content => { delivered = content; });
    const disconnect = host.connect([]);
    source.onopen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delivered, "old source");
    remote = true;
    listeners.get("online")();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delivered, "new source");
    assert.equal(registrations, 2);
    disconnect();
    assert.equal(listeners.has("online"), false);
  } finally { globalThis.window = previousWindow; }
});
