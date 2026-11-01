import test from "node:test";
import assert from "node:assert/strict";
import { readAgentEvents } from "../src/agentStream";

test("agent SSE keeps UTF-8 and split CRLF event framing intact", async () => {
  const bytes = new TextEncoder().encode(
    ': alive\r\nevent: text_delta\r\ndata: {"turnId":"one","delta":"😀"}\r\n\r\nevent: complete\r\ndata: {"turnId":"one","text":"done"}\r\n\r\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readAgentEvents(body, new AbortController().signal))
    events.push(event);
  assert.deepEqual(
    events.map((event) => [event.type, event.delta ?? event.text]),
    [
      ["text_delta", "😀"],
      ["complete", "done"],
    ],
  );
});
test("leaving agent stream iteration cancels only its owned reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('event: start\ndata: {"turnId":"one"}\n\n'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const caller = new AbortController();
  for await (const _ of readAgentEvents(body, caller.signal)) break;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(caller.signal.aborted, false);
});
test("malformed agent events fail instead of becoming assistant text", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: text_delta\ndata: {"delta":"unowned"}\n\n',
        ),
      );
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _ of readAgentEvents(body, new AbortController().signal)) {
    }
  }, /Invalid assistant event/);
});
