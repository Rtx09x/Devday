import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../src/server.ts";
import type { AgentOptions } from "../src/agent/service.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lmgAAAAASUVORK5CYII=";
const chunk = (text: string | null, name?: string, args?: unknown) => ({
  id: "http-fixture",
  object: "chat.completion.chunk" as const,
  created: 0,
  model: "qwen-3.8-27b",
  choices: [
    {
      index: 0,
      delta: {
        content: text,
        ...(name
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${name}`,
                  type: "function" as const,
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : {}),
      },
      finish_reason: name ? "tool_calls" : "stop",
    },
  ],
});

async function fixture(agent: AgentOptions) {
  const dir = await mkdtemp(path.join(tmpdir(), "cutu-agent-integration-"));
  const runtime = await createRuntime({
    dataDir: dir,
    seed: false,
    pollIntervalMs: 0,
    port: 0,
    agent,
  });
  const project = await runtime.store.create(
    "HTTP integration fixture",
    "blank",
  );
  const server = await runtime.listen();
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/api/projects/${project.id}/agent`;
  return {
    dir,
    runtime,
    project,
    origin,
    base,
    async close() {
      await runtime.close();
      const absolute = path.resolve(dir);
      assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
      assert(path.basename(absolute).startsWith("cutu-agent-integration-"));
      await rm(absolute, { recursive: true, force: true });
    },
  };
}
async function post(url: string, data: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return response;
}
async function consume(
  response: Response,
  onEvent?: (event: any) => Promise<void>,
) {
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  assert(response.body);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];
  try {
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (line) {
          const event = JSON.parse(line.slice(6));
          events.push(event);
          await onEvent?.(event);
        }
      }
      if (part.done) break;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return events;
}

test("actual HTTP agent streams a broker read, waits for exact approval, writes CAS source and completes", async () => {
  let round = 0,
    projectId = "";
  const fixtureState = await fixture({
    env: {},
    provider: {
      async *stream(request) {
        if (round++ === 0)
          yield chunk(null, "read_file", { projectId, path: "notes.txt" });
        else if (round === 2) {
          const result = JSON.parse(
            String(request.messages.at(-1)?.content),
          ).result;
          assert.equal(result.content, "original source");
          assert.match(result.sha256, /^[a-f0-9]{64}$/);
          yield chunk(null, "write_file", {
            projectId,
            path: "notes.txt",
            content: "approved updated source",
            expectedSha256: result.sha256,
          });
        } else yield chunk("The approved source was saved.");
      },
    },
  });
  const f = fixtureState;
  projectId = f.project.id;
  try {
    const original = await f.runtime.store.write(
      projectId,
      "notes.txt",
      "original source",
      null,
    );
    const response = await post(f.base + "/turns", {
      message: "Update notes after reading, ask me first.",
    });
    let approvals = 0;
    const events = await consume(response, async (event) => {
      if (event.type !== "approval_required") return;
      approvals++;
      assert.equal(event.name, "write_file");
      assert.equal(event.args.expectedSha256, original.sha256);
      assert.equal(
        (await f.runtime.store.read(projectId, "notes.txt")).content,
        "original source",
      );
      const status = await (await fetch(f.base + "/status")).json();
      assert.equal(status.pendingApproval.approvalId, event.approvalId);
      const decision = await post(f.base + `/approvals/${event.approvalId}`, {
        approved: true,
      });
      assert.deepEqual(await decision.json(), { ok: true });
    });
    assert.equal(approvals, 1);
    assert.deepEqual(
      events.filter((e) => e.type === "tool_result").map((e) => e.name),
      ["read_file", "write_file"],
    );
    assert.equal(events.at(-1).type, "complete");
    assert.equal(events.at(-1).text, "The approved source was saved.");
    assert.equal(
      (await f.runtime.store.read(projectId, "notes.txt")).content,
      "approved updated source",
    );
    const disk = await readFile(
      path.join(f.runtime.store.root(projectId), "notes.txt"),
      "utf8",
    );
    assert.equal(disk, "approved updated source");
  } finally {
    await f.close();
  }
});

test("actual HTTP agent passes current-turn image bytes and Exa evidence without persisting image data", async () => {
  let round = 0,
    searchCalls = 0;
  const requests: any[] = [];
  const f = await fixture({
    env: {},
    provider: {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (round++ === 0)
          yield chunk(null, "exa_search", { query: "NodeMCU ESP8266 D5 pin" });
        else {
          const evidence = JSON.parse(
            String(request.messages.at(-1)?.content),
          ).result;
          assert.equal(evidence.results[0].id, "S1");
          yield chunk("The public fixture source supports this mapping [S1].");
        }
      },
    },
    search: {
      async search(input) {
        searchCalls++;
        assert.equal(input.numResults, 3);
        return {
          results: [
            {
              url: "https://example.com/nodemcu-pinout",
              title: "Fixture pinout",
              highlights: ["D5 maps to GPIO14"],
            },
          ],
        };
      },
      async getContents() {
        throw Error("Unexpected content fetch");
      },
    },
  });
  try {
    const response = await post(f.base + "/turns", {
      message:
        "Inspect the image and verify the pin mapping with a web source.",
      attachments: [{ name: "board.png", dataUrl: png }],
    });
    const events = await consume(response);
    assert.equal(searchCalls, 1);
    assert.equal(events.at(-1).type, "complete");
    assert.equal(requests[0].messages.at(-1).content[1].image_url.url, png);
    assert.deepEqual(events.find((e) => e.type === "citations").sources, [
      {
        id: "S1",
        url: "https://example.com/nodemcu-pinout",
        title: "Fixture pinout",
      },
    ]);
    assert.match(events.at(-1).text, /\[S1\]/);
    const status = await (await fetch(f.base + "/status")).json();
    assert(!JSON.stringify(status).includes(png));
    assert.match(status.history[0].content, /board.png/);
    async function inspectDisk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) await inspectDisk(target);
        else if (entry.isFile())
          assert(
            !(await readFile(target)).includes(Buffer.from(png)),
            `Image URL persisted in ${entry.name}`,
          );
      }
    }
    await inspectDisk(f.dir);
  } finally {
    await f.close();
  }
});
