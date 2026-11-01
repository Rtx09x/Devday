import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentService, type AgentEvent } from "../src/agent/service.ts";
import { BrokerClient } from "../../plugin/src/client.ts";
const chunk = (content: string | null, calls: any[] = [], finish = "stop") => ({
  id: "x",
  object: "chat.completion.chunk" as const,
  created: 0,
  model: "qwen-3.8-27b",
  choices: [
    { index: 0, delta: { content, tool_calls: calls }, finish_reason: finish },
  ],
});
const call = (name: string, args: unknown, index = 0) => ({
  index,
  id: `c${index}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(
  rounds: any[][],
  handler?: (method: string, path: string, body: unknown) => Promise<unknown>,
) {
  const invoked: any[] = [];
  let round = 0;
  const events: AgentEvent[] = [];
  const service = new AgentService(
    {
      provider: {
        async *stream() {
          for (const c of rounds[round++] ?? []) yield c;
        },
      },
      broker: () =>
        ({
          baseUrl: "http://127.0.0.1:1",
          async request(m: string, p: string, b: unknown) {
            invoked.push({ m, p, b });
            return handler ? handler(m, p, b) : { id: "p", revision: 1 };
          },
        }) as BrokerClient,
    },
    () => "http://127.0.0.1:1",
  );
  return { service, events, invoked, emit: (e: AgentEvent) => events.push(e) };
}
test("missing configuration is honest and per-project history is isolated", async () => {
  const s = new AgentService({ env: {} }, () => "http://127.0.0.1:1");
  assert.equal(s.status("a").configured, false);
  assert.equal(s.status("a").tools.length, 29);
  await assert.rejects(
    s.run("a", "hello", () => {}),
    /CEREBRAS_NOT_CONFIGURED/,
  );
  assert.deepEqual(s.status("b").history, []);
});
test("streams text and does not retry incomplete output", async () => {
  const f = fixture([[chunk("hello")]]);
  await f.service.run("p", "hi", f.emit);
  assert.equal(f.events.find((e) => e.type === "text_delta")?.delta, "hello");
  assert.equal(f.events.at(-1)?.type, "complete");
  assert.equal(f.service.status("q").history.length, 0);
  const bad = fixture([[chunk("partial", [], "length")]]);
  await bad.service.run("p", "hi", bad.emit);
  assert.equal(bad.events.at(-1)?.code, "INCOMPLETE_MODEL_OUTPUT");
  assert.equal(bad.service.status("p").history.length, 1);
});
test("model cannot cross project boundary or discover other projects", async () => {
  const f = fixture([
    [chunk(null, [call("get_project", { projectId: "other" })], "tool_calls")],
    [chunk("done")],
  ]);
  await f.service.run("p", "hi", f.emit);
  assert.equal(f.invoked.length, 0);
  assert.match(JSON.stringify(f.events), /CROSS_PROJECT_DENIED/);
  const g = fixture([
    [chunk(null, [call("list_projects", {})], "tool_calls")],
    [chunk("done")],
  ]);
  await g.service.run("p", "hi", g.emit);
  assert.equal(g.invoked.length, 0);
  assert.match(JSON.stringify(g.events), /PROJECT_SCOPE_DENIED/);
});
test("guarded write requires observed SHA and single-use exact approval", async () => {
  const hash = "a".repeat(64);
  const f = fixture(
    [
      [
        chunk(
          null,
          [call("read_file", { projectId: "p", path: "a.ts" })],
          "tool_calls",
        ),
      ],
      [
        chunk(
          null,
          [
            call("write_file", {
              projectId: "p",
              path: "a.ts",
              content: "next",
              expectedSha256: hash,
            }),
          ],
          "tool_calls",
        ),
      ],
      [chunk("Saved")],
    ],
    async (m) =>
      m === "GET" ? { sha256: hash, content: "old" } : { sha256: hash },
  );
  await f.service.run("p", "edit", (e) => {
    f.emit(e);
    if (e.type === "approval_required") {
      assert.equal(f.invoked.length, 1);
      assert.throws(
        () => f.service.approve("other", String(e.approvalId), true),
        /APPROVAL_EXPIRED/,
      );
      f.service.approve("p", String(e.approvalId), true);
      assert.throws(
        () => f.service.approve("p", String(e.approvalId), true),
        /APPROVAL_EXPIRED/,
      );
    }
  });
  assert.equal(f.invoked[1].b.content, "next");
  assert.equal(f.events.at(-1)?.type, "complete");
});
test("unobserved source cannot be approved and hardware denial never executes", async () => {
  const f = fixture([
    [
      chunk(
        null,
        [
          call("write_file", {
            projectId: "p",
            path: "a.ts",
            content: "x",
            expectedSha256: null,
          }),
        ],
        "tool_calls",
      ),
    ],
    [chunk("Cannot save")],
  ]);
  await f.service.run("p", "edit", f.emit);
  assert.equal(f.invoked.length, 0);
  assert(!f.events.some((e) => e.type === "approval_required"));
  const g = fixture([
    [
      chunk(
        null,
        [
          call("run_operation", {
            projectId: "p",
            capabilityId: "motor",
            inputs: {},
          }),
        ],
        "tool_calls",
      ),
    ],
    [chunk("Denied")],
  ]);
  await g.service.run("p", "run", (e) => {
    g.emit(e);
    if (e.type === "approval_required")
      g.service.approve("p", String(e.approvalId), false);
  });
  assert.equal(g.invoked.length, 0);
  assert.match(JSON.stringify(g.events), /USER_DENIED/);
});
test("cancelling a pending approval releases the turn", async () => {
  const f = fixture([
    [
      chunk(
        null,
        [
          call("run_operation", {
            projectId: "p",
            capabilityId: "motor",
            inputs: {},
          }),
        ],
        "tool_calls",
      ),
    ],
  ]);
  await f.service.run("p", "run", (e) => {
    f.emit(e);
    if (e.type === "approval_required") f.service.cancel("p");
  });
  assert.equal(f.events.at(-1)?.type, "cancelled");
  assert.equal(f.invoked.length, 0);
  assert.equal(f.service.status("p").activeTurnId, null);
});
test("invented citations fail and unknown finishes are rejected", async () => {
  const f = fixture([[chunk("claim [S9]")]]);
  await f.service.run("p", "research", f.emit);
  assert.equal(f.events.at(-1)?.code, "UNKNOWN_CITATION");
  const g = fixture([[chunk("partial", [], "content_filter")]]);
  await g.service.run("p", "hi", g.emit);
  assert.equal(g.events.at(-1)?.code, "INCOMPLETE_MODEL_OUTPUT");
});

test("Exa evidence receives server citation IDs and contents accept only those IDs", async () => {
  const searchCalls: any[] = [];
  let round = 0;
  const events: AgentEvent[] = [];
  const service = new AgentService(
    {
      provider: {
        async *stream() {
          yield [
            chunk(
              null,
              [call("exa_search", { query: "servo datasheet" })],
              "tool_calls",
            ),
            chunk(
              null,
              [
                call("exa_contents", {
                  sourceIds: ["https://127.0.0.1/private"],
                }),
              ],
              "tool_calls",
            ),
            chunk("Supported [S1]"),
          ][round++];
        },
      },
      search: {
        async search(input) {
          searchCalls.push(input);
          return {
            results: [
              {
                url: "https://example.com/spec",
                title: "Spec",
                highlights: ["Data"],
              },
            ],
          };
        },
        async getContents() {
          throw new Error("arbitrary reference should not be fetched");
        },
      },
    },
    () => "http://127.0.0.1:1",
  );
  await service.run("p", "research", (e) => events.push(e));
  assert.equal(searchCalls[0].type, "lite");
  assert.deepEqual(events.find((e) => e.type === "citations")?.sources, [
    { id: "S1", url: "https://example.com/spec", title: "Spec" },
  ]);
  assert.match(JSON.stringify(events), /UNKNOWN_SOURCE/);
  assert.equal(events.at(-1)?.type, "complete");
});
test("conflicting broker writes remain failures after approval", async () => {
  const hash = "b".repeat(64);
  const f = fixture(
    [
      [
        chunk(
          null,
          [call("read_file", { projectId: "p", path: "a" })],
          "tool_calls",
        ),
      ],
      [
        chunk(
          null,
          [
            call("write_file", {
              projectId: "p",
              path: "a",
              content: "new",
              expectedSha256: hash,
            }),
          ],
          "tool_calls",
        ),
      ],
      [chunk("A conflict prevented saving")],
    ],
    async (m) => {
      if (m === "GET") return { sha256: hash, content: "old" };
      throw new Error("HASH_CONFLICT");
    },
  );
  await f.service.run("p", "edit", (e) => {
    f.emit(e);
    if (e.type === "approval_required")
      f.service.approve("p", String(e.approvalId), true);
  });
  assert.match(JSON.stringify(f.events), /HASH_CONFLICT/);
});
test("total deadline cancels stalled approvals and invalidates their IDs", async () => {
  let approvalId = "";
  const service = new AgentService(
    {
      deadlineMs: 20,
      provider: {
        async *stream() {
          yield chunk(
            null,
            [
              call("run_operation", {
                projectId: "p",
                capabilityId: "motor",
                inputs: {},
              }),
            ],
            "tool_calls",
          );
        },
      },
    },
    () => "http://127.0.0.1:1",
  );
  const events: AgentEvent[] = [];
  await service.run("p", "run", (e) => {
    events.push(e);
    if (e.type === "approval_required") approvalId = String(e.approvalId);
  });
  assert.equal(events.at(-1)?.code, "AGENT_DEADLINE");
  assert.throws(
    () => service.approve("p", approvalId, true),
    /APPROVAL_EXPIRED/,
  );
});

test("HTTP SSE uses the current runtime broker and reports missing configuration", async () => {
  const { createRuntime } = await import("../src/server.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "cutu-agent-http-"));
  let round = 0;
  const runtime = await createRuntime({
    dataDir: dir,
    seed: false,
    pollIntervalMs: 0,
    port: 0,
    agent: {
      provider: {
        async *stream() {
          yield round++ === 0
            ? chunk(
                null,
                [call("get_project", { projectId: project.id })],
                "tool_calls",
              )
            : chunk("Project inspected");
        },
      },
    },
  });
  const project = await runtime.store.create("Agent fixture", "blank");
  try {
    const server = await runtime.listen();
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/projects/${project.id}/agent`;
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.model, "qwen-3.8-27b");
    const response = await fetch(`${base}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Inspect current project" }),
    });
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    const stream = await response.text();
    assert.match(stream, /event: complete/);
    assert.match(stream, /Project inspected/);
    assert.match(stream, new RegExp(project.id));
    assert.match(stream, /event: tool_result/);
    const wrong = await fetch(base.replace(project.id, "missing") + "/status");
    assert.equal(wrong.status, 404);
    await fetch(`${base}/history`, { method: "DELETE" });
    assert.deepEqual(
      (await (await fetch(`${base}/status`)).json()).history,
      [],
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("truncated tool arguments and graph mutations without observed revision never execute", async () => {
  const f = fixture([
    [
      chunk(
        null,
        [call("set_selection", { projectId: "p", entityId: null })],
        "length",
      ),
    ],
  ]);
  await f.service.run("p", "select", f.emit);
  assert.equal(f.invoked.length, 0);
  assert.equal(f.events.at(-1)?.code, "INCOMPLETE_MODEL_OUTPUT");
  const g = fixture([
    [
      chunk(
        null,
        [
          call("update_graph", {
            projectId: "p",
            expectedRevision: 2,
            changes: { name: "new" },
          }),
        ],
        "tool_calls",
      ),
    ],
    [chunk("Read project first")],
  ]);
  await g.service.run("p", "edit", g.emit);
  assert.equal(g.invoked.length, 0);
  assert(!g.events.some((e) => e.type === "approval_required"));
  assert.match(JSON.stringify(g.events), /READ_PROJECT_BEFORE_UPDATE/);
});
test("private search endpoints never become fetchable citation IDs", async () => {
  let round = 0;
  const events: AgentEvent[] = [];
  let contents = 0;
  const service = new AgentService(
    {
      provider: {
        async *stream() {
          yield round++ === 0
            ? chunk(
                null,
                [call("exa_search", { query: "anything" })],
                "tool_calls",
              )
            : chunk("No public source returned");
        },
      },
      search: {
        async search() {
          return {
            results: [{ url: "http://127.0.0.1/private", title: "Private" }],
          };
        },
        async getContents() {
          contents++;
          return { results: [] };
        },
      },
    },
    () => "http://127.0.0.1:1",
  );
  await service.run("p", "research", (e) => events.push(e));
  assert.equal(contents, 0);
  assert(!events.some((e) => e.type === "citations"));
  assert.match(JSON.stringify(events), /INVALID_SOURCE_URL/);
});

test("failed streamed answers retract provisional text before terminal errors", async () => {
  for (const [text, finish, code] of [
    ["Bad [S99]", "stop", "UNKNOWN_CITATION"],
    ["Bad https://invented.example/", "stop", "USE_SOURCE_IDS_FOR_CITATIONS"],
    ["Incomplete", "length", "INCOMPLETE_MODEL_OUTPUT"],
  ]) {
    const f = fixture([[chunk(text, [], finish)]]);
    await f.service.run("p", "question", f.emit);
    assert.equal(
      f.events.find((e) => e.type === "text_delta")?.provisional,
      true,
    );
    assert.equal(f.events.at(-2)?.type, "text_reset");
    assert.equal(f.events.at(-1)?.code, code);
    assert.equal(f.events.at(-1)?.discardText, true);
    assert(!f.events.some((e) => e.type === "complete"));
    assert(!f.service.status("p").history.some((h) => h.role === "assistant"));
  }
});

test("compile and export require approval before executing project-authored local code", async () => {
  for (const name of ["compile", "export"]) {
    const args = {
      projectId: "p",
      path: "model.replicad.ts",
      ...(name === "export" ? { format: "stl" } : {}),
    };
    const f = fixture([
      [chunk(null, [call(name, args)], "tool_calls")],
      [chunk("Execution denied")],
    ]);
    const definition = f.service.status("p").tools.find((t) => t.name === name);
    assert.equal(definition?.policy, "approval");
    assert.match(definition?.description ?? "", /not a security sandbox/);
    await f.service.run("p", "compile current project", (e) => {
      f.emit(e);
      if (e.type === "approval_required") {
        assert.equal(f.invoked.length, 0);
        assert.match(String(e.warning), /environment access/);
        f.service.approve("p", String(e.approvalId), false);
      }
    });
    assert.equal(f.invoked.length, 0);
    assert.match(JSON.stringify(f.events), /USER_DENIED/);
  }
});

test("private credential paths are denied before broker access or approval", async () => {
  for (const path of [
    ".local/wifi.json",
    "firmware/include/secrets.h",
    ".env.production",
    "credentials.json",
    "keys/id_rsa",
    "cert/server.key",
  ]) {
    for (const name of [
      "read_file",
      "write_file",
      "list_file_history",
      "import_urdf",
    ]) {
      const args = {
        projectId: "p",
        path,
        ...(name === "write_file"
          ? { content: "fake-secret", expectedSha256: null }
          : name === "import_urdf"
            ? { content: "<robot/>" }
            : {}),
      };
      const f = fixture(
        [
          [chunk(null, [call(name, args)], "tool_calls")],
          [chunk("Private file unavailable")],
        ],
        async () => {
          throw new Error("PRIVATE_BROKER_MUST_NOT_EXECUTE");
        },
      );
      await f.service.run("p", "inspect", f.emit);
      assert.equal(f.invoked.length, 0);
      assert(
        !f.events.some(
          (e) => e.type === "tool_start" || e.type === "approval_required",
        ),
      );
      assert.match(JSON.stringify(f.events), /PRIVATE_FILE_DENIED/);
      assert(!JSON.stringify(f.events).includes("fake-secret"));
    }
  }
});
test("discovery and history expose only safe files and observed safe version IDs", async () => {
  const f = fixture(
    [
      [chunk(null, [call("list_files", { projectId: "p" })], "tool_calls")],
      [
        chunk(
          null,
          [call("list_file_history", { projectId: "p" })],
          "tool_calls",
        ),
      ],
      [
        chunk(
          null,
          [
            call("read_file_version", {
              projectId: "p",
              versionId: "private-version",
            }),
          ],
          "tool_calls",
        ),
      ],
      [chunk("Safe sources only")],
    ],
    async (_m, p) =>
      p.endsWith("file-list")
        ? ["model.ts", ".local/wifi.json", "firmware/include/secrets.h"]
        : [
            { id: "safe-version", path: "model.ts", sha256: "a".repeat(64) },
            {
              id: "private-version",
              path: ".local/wifi.json",
              sha256: "b".repeat(64),
            },
          ],
  );
  await f.service.run("p", "history", f.emit);
  assert.equal(f.invoked.length, 2);
  const output = JSON.stringify(f.events);
  assert(!output.includes(".local"));
  assert(!output.includes("secrets.h"));
  assert(!output.includes("private-version"));
  assert.match(output, /UNOBSERVED_OR_PRIVATE_VERSION_DENIED/);
});
test("safe observed versions are readable, but version IDs are scoped to project and turn", async () => {
  const f = fixture(
    [
      [
        chunk(
          null,
          [call("list_file_history", { projectId: "p" })],
          "tool_calls",
        ),
      ],
      [
        chunk(
          null,
          [call("read_file_version", { projectId: "p", versionId: "v1" })],
          "tool_calls",
        ),
      ],
      [chunk("History inspected")],
    ],
    async (_m, p) =>
      p.endsWith("history?")
        ? [{ id: "v1", path: "model.ts" }]
        : { entry: { id: "v1", path: "model.ts" }, content: "safe-code" },
  );
  await f.service.run("p", "history", f.emit);
  assert.equal(f.invoked.length, 2);
  assert.match(JSON.stringify(f.events), /safe-code/);
  const g = fixture([
    [
      chunk(
        null,
        [
          call("restore_file_version", {
            projectId: "p",
            versionId: "v1",
            expectedSha256: null,
          }),
        ],
        "tool_calls",
      ),
    ],
    [chunk("Version must be observed")],
  ]);
  await g.service.run("p", "restore", g.emit);
  assert.equal(g.invoked.length, 0);
  assert(!g.events.some((e) => e.type === "approval_required"));
});

test('large project tool context retains authoritative counts instead of cutting JSON mid-entity', async () => {
  const entities = Array.from({length:81}, (_,i) => ({id:`e${i}`,name:`Part ${i}`,kind:'part',metadata:{detail:'x'.repeat(1500)}}));
  const f=fixture([[chunk(null,[call('get_project',{projectId:'p'})],'tool_calls')],[chunk('81 objects')]],async()=>({id:'p',name:'Makada Demo',revision:3,entities,assets:[{id:'cad',name:'CAD',kind:'cad',path:'model.replicad.ts'}]}));
  await f.service.run('p','Inspect counts',f.emit);
  const result=f.events.find(e=>e.type==='tool_result')?.result as any;
  assert.equal(result.entityCount,81);
  assert.equal(result.assetCount,1);
  assert.equal(result.entities.length,50);
  assert.equal(result.truncated,true);
  assert(result.note.includes('do not reconstruct'));
  assert(JSON.stringify(result).length<28000);
});

test('summarized project context cannot authorize replacement of an incomplete graph', async () => {
  const f=fixture([[chunk(null,[call('get_project',{projectId:'p'})],'tool_calls')],[chunk(null,[call('update_graph',{projectId:'p',expectedRevision:3,changes:{entities:[]}})],'tool_calls')],[chunk('Use the external client for full graph edits.')]],async()=>({id:'p',revision:3,entities:[{id:'a',metadata:{detail:'x'.repeat(30000)}}],assets:[]}));
  await f.service.run('p','Inspect project',f.emit);
  assert.equal(f.invoked.length,1);
  assert(!f.events.some(e=>e.type==='approval_required'));
  assert.match(JSON.stringify(f.events),/FULL_GRAPH_CONTEXT_UNAVAILABLE_USE_EXTERNAL_CODEX/);
});


