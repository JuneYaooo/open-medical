import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fixture } from "./helpers.mjs";

test("medical server: model settings GET reflects environment, PUT hot-swaps provider", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omw-models-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, {
    database: join(dir, "medical.sqlite"),
  });

  // GET shows the environment config (no key leakage).
  const initial = (await f.json("/api/model-settings")).data;
  assert.equal(initial.source, "environment");
  assert.equal(initial.hasKey, false);
  assert.ok(initial.model);

  // PUT with a local loopback provider (no key required) hot-swaps.
  const saved = await f.json("/api/model-settings", "PUT", {
    provider: "local",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:14b",
    timeoutMs: 60000,
    maxTokens: 4096,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.source, "saved");
  assert.equal(saved.data.provider, "local");
  assert.equal(saved.data.model, "qwen3:14b");
  assert.equal(saved.data.timeoutMs, 60000);

  // Persistence: GET still returns saved settings.
  const persisted = (await f.json("/api/model-settings")).data;
  assert.equal(persisted.source, "saved");
  assert.equal(persisted.model, "qwen3:14b");

  // Key file lands beside the database (vault dir), not the repo root.
  assert.ok(existsSync(join(dir, "credentials.key")));

  // HTTPS discipline: plain-http remote host is rejected.
  const rejected = await f.json("/api/model-settings", "PUT", {
    provider: "openai",
    baseUrl: "http://api.example.com/v1",
    model: "gpt-x",
    apiKey: "sk-test",
  });
  assert.equal(rejected.status, 400);

  rmSync(join(dir, "credentials.key"), { force: true });
});

test("medical server: model switch is blocked while a run is active", async (t) => {
  // The busy guard mirrors the generic server; verified via the same
  // runtime.active set semantics here with a minimal simulation.
  const f = await fixture(t);
  f.server.runtime.active.set("fake-session", {});
  const blocked = await f.json("/api/model-settings", "PUT", {
    provider: "local",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:14b",
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "MODEL_BUSY");
  f.server.runtime.active.delete("fake-session");
  const ok = await f.json("/api/model-settings", "PUT", {
    provider: "local",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:14b",
  });
  assert.equal(ok.status, 200);
});

test("model settings test endpoint validates reachability contract", async (t) => {
  const f = await fixture(t);
  const test = await f.json("/api/model-settings/test", "POST", {
    provider: "local",
    baseUrl: "http://127.0.0.1:9",
    model: "nope",
  });
  // Any structured verdict (ok or error text) is acceptable; must not throw 500.
  assert.ok([200, 502, 400].includes(test.status));
});
