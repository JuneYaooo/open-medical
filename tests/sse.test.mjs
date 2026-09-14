import test from "node:test";
import assert from "node:assert/strict";
import { sseFrames } from "../shared/sse.mjs";
const stream = (text) =>
  new ReadableStream({
    start(controller) {
      for (const byte of new TextEncoder().encode(text))
        controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
test("SSE decoder joins multiline data, tolerates comments and preserves trailing event", async () => {
  const frames = [];
  for await (const f of sseFrames(
    stream(
      ":ping\r\nevent: result\r\ndata: 第一行\r\ndata: 第二行\r\n\r\ndata: tail",
    ),
  ))
    frames.push(f);
  assert.deepEqual(frames, [
    { event: "result", data: "第一行\n第二行" },
    { event: "message", data: "tail" },
  ]);
});
test("SSE decoder bounds malformed frames and cancels the upstream on consumer error", async () => {
  await assert.rejects(async () => {
    for await (const _f of sseFrames(stream("data: " + "x".repeat(100)), {
      maxBuffer: 30,
    })) {
      /* consume until size guard rejects */
    }
  }, /过大/);
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: test\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(async () => {
    for await (const _f of sseFrames(body)) throw new Error("consumer failed");
  }, /consumer failed/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
