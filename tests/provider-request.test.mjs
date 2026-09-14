import test from "node:test";
import assert from "node:assert/strict";
import { requestProvider } from "../server/core/provider-request.mjs";

test("connection and pre-stream HTTP failures retry with a bounded cancellable delay", async () => {
  let calls = 0, cancelled = false;
  const waits = [], statuses = [];
  const result = await requestProvider(async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 503, headers: { "retry-after": "3600" },
    });
    return new Response("ok");
  }, "https://model.example", { signal: new AbortController().signal }, (s) => statuses.push(s), async (ms) => waits.push(ms));
  assert.equal(await result.text(), "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [300, 5000]);
  assert.equal(cancelled, true);
  assert.deepEqual(statuses.map((s) => s.reason), ["network", "http"]);
});

test("authentication errors and partial stream failures are never replayed", async () => {
  let calls = 0;
  const response = await requestProvider(async () => { calls++; return new Response("unauthorized", { status: 401 }); },
    "https://model.example", {}, () => {}, async () => assert.fail("retry"));
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
  const stream = await requestProvider(async () => { calls++; return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error("stream broke")); },
  })); }, "https://model.example", {}, () => {}, async () => assert.fail("retry"));
  await assert.rejects(stream.text(), /stream broke/);
  assert.equal(calls, 2);
});

test("aborting during retry propagates the original cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by user");
  await assert.rejects(requestProvider(async () => { controller.abort(reason); throw new TypeError("network"); },
    "https://model.example", { signal: controller.signal }), (error) => error === reason);
});
