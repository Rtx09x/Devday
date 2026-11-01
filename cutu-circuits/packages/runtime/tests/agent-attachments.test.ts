import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentService } from "../src/agent/service.ts";
import {
  validateAttachments,
  MAX_ATTACHMENT_BYTES,
} from "../src/agent/attachments.ts";
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lmgAAAAASUVORK5CYII=";
const image = { name: "board.png", dataUrl: png };

test("attachments accept bounded PNG/JPEG bytes and reject URLs, wrong magic, names and limits", () => {
  assert.deepEqual(validateAttachments([image]), [image]);
  assert.deepEqual(validateAttachments(undefined), []);
  for (const value of [
    [...Array(3)].map(() => image),
    [{ ...image, dataUrl: "https://example.com/a.png" }],
    [{ ...image, name: "../key.png" }],
    [{ ...image, dataUrl: "data:image/png;base64,YWJj" }],
    [{ ...image, dataUrl: png + "=" }],
    [
      {
        ...image,
        dataUrl:
          "data:image/png;base64," +
          Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
      },
    ],
  ])
    assert.throws(() => validateAttachments(value));
});

test("images reach only current provider turn and are not retained in project history", async () => {
  const requests: any[] = [];
  const agent = new AgentService(
    {
      provider: {
        async *stream(request) {
          requests.push(structuredClone(request));
          yield {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "qwen-3.8-27b",
            choices: [
              {
                index: 0,
                delta: { content: "Saw the attachment." },
                finish_reason: "stop",
              },
            ],
          };
        },
      },
    },
    () => "http://127.0.0.1:1",
  );
  await agent.run("p", "Inspect this image", () => {}, undefined, [image]);
  assert.equal(requests[0].messages.at(-1).content[1].image_url.url, png);
  assert.ok(!JSON.stringify(agent.status("p")).includes(png));
  assert.match(agent.status("p").history[0].content, /board.png/);
  await agent.run("p", "Follow up", () => {});
  assert.ok(!JSON.stringify(requests[1]).includes(png));
  await assert.rejects(
    agent.run("p", "Bad attachment", () => {}, undefined, [
      { ...image, dataUrl: "file:///key.png" },
    ]),
  );
  assert.equal(requests.length, 2);
});
