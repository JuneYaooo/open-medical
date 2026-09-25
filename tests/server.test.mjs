import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import http from "node:http";
import { createHash } from "node:crypto";
import { fixture } from "./helpers.mjs";

test("medical server exposes no removed streaming services or database tables", async (t) => {
  const f = await fixture(t);
  for (const [path, method] of [
    ["/api/live/status", "GET"],
    ["/api/live/ingest", "POST"],
    ["/api/live/jobs", "POST"],
  ]) {
    const result = await f.json(
      path,
      method,
      method === "POST" ? {} : undefined,
    );
    assert.equal(result.status, 404);
    assert.equal(result.data.code, "NOT_FOUND");
  }
  assert.equal(Object.hasOwn(f.server, "live"), false);
  const tables = f.server.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  assert.equal(
    tables.some((table) => table.name.startsWith("live_")),
    false,
  );
  const patient = await f.json("/api/patients", "GET");
  assert.equal(patient.status, 200);
});

test("API requires local auth and rejects cross-site origins and hostile Host", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/sessions")).status, 401);
  assert.equal(
    (
      await f.request("/api/sessions", "GET", undefined, {
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const hostile = await new Promise((resolve, reject) => {
    const req = http.get(
      f.origin + "/api/bootstrap",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(hostile, 403);
  assert.equal((await f.json("/api/agent/health")).data.provider, "local");
});
test("GET is read-only, schema failures are 4xx, concurrent sessions do not overwrite each other", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.json("/api/sessions/missing")).status, 404);
  assert.equal(
    (await f.json("/api/sessions", "POST", { id: "__proto__" })).status,
    400,
  );
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => f.session("session " + i)),
  );
  assert.equal((await f.json("/api/sessions")).data.sessions.length, 20);
  const r = await fetch(f.origin + "/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-medical-token": f.server.token,
    },
    body: "{",
  });
  assert.equal(r.status, 400);
});
test("local pipeline persists source-linked draft and supports versioned human review", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const file = await f.json(`/api/sessions/${s.id}/files`, "POST", {
    name: "病历.txt",
    text: "姓名：张三\n2026-09-01 门诊复查\n2026-09-03 复诊",
  });
  assert.equal(file.status, 201);
  assert.ok(file.data.text.includes("张三"));
  assert.equal(
    file.data.hash,
    createHash("sha256")
      .update("姓名：张三\n2026-09-01 门诊复查\n2026-09-03 复诊")
      .digest("hex"),
  );
  const run = await f.chat(s.id, "请整理病历时间线", {
    fileIds: [file.data.id],
  });
  assert.equal(run.events.at(-1).type, "message.complete");
  const after = (await f.json(`/api/sessions/${s.id}`)).data;
  assert.equal(after.messages.length, 2);
  assert.equal(after.artifacts[0].events.length, 2);
  assert.ok(!JSON.stringify(after).includes("providerMessages"));
  const artifact = after.artifacts[0];
  const base = `/api/sessions/${s.id}/artifacts/${artifact.id}`;
  assert.equal(
    (
      await f.json(base + "/review", "POST", {
        version: 1,
        reviewer: "reviewer-A",
        note: "checked",
        decision: "approved",
      })
    ).status,
    412,
  );
  assert.equal(
    (
      await f.json(base + "/review", "POST", {
        version: 1,
        reviewer: "reviewer-A",
        note: "已逐项对照原文",
        decision: "approved",
        attested: true,
      })
    ).data.status,
    "approved",
  );
  assert.equal(
    (
      await f.json(base + "/review", "POST", {
        version: 1,
        reviewer: "A",
        note: "再次确认",
        decision: "approved",
        attested: true,
      })
    ).status,
    409,
  );
  const edited = await f.json(base, "PATCH", {
    version: 2,
    title: "病历时间线（修订）",
  });
  assert.equal(edited.data.status, "draft");
  assert.equal(edited.data.review, undefined);
  const exported = await (
    await f.request(`/api/sessions/${s.id}/export?format=md`)
  ).text();
  assert.match(exported, /draft/);
  assert.match(exported, /SHA256/);
});
test("file scope, payload limits, duplicate data and deletion are enforced", async (t) => {
  const f = await fixture(t);
  const a = await f.session(),
    b = await f.session();
  const path = `/api/sessions/${a.id}/files`;
  const file = (
    await f.json(path, "POST", { name: "r.txt", text: "2026-01-01 门诊" })
  ).data;
  assert.equal(
    (await f.json(path, "POST", { name: "r2.txt", text: "2026-01-01 门诊" }))
      .status,
    409,
  );
  assert.equal(
    (await f.json(path, "POST", { name: "image.pdf", text: "x" })).status,
    400,
  );
  assert.equal(
    (await f.chat(b.id, "读取病历", { fileIds: [file.id] })).status,
    404,
  );
  assert.equal((await f.chat(b.id, "x".repeat(200001))).status, 400);
  assert.equal((await f.json(`/api/sessions/${a.id}`, "DELETE")).status, 200);
  assert.equal((await f.json(`/api/sessions/${a.id}`)).status, 404);
});
test("unconfigured model fails without fake fallback and legacy route shares the same gate", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const result = await f.chat(s.id, "整理病历", {
    mode: "model",
    externalConsent: true,
  });
  assert.equal(result.status, 503);
  const legacy = await f.json("/api/agent/run", "POST", {
    sessionId: s.id,
    message: "整理病历",
    mode: "model",
  });
  assert.equal(legacy.status, 503);
  assert.equal(legacy.data.code, "MODEL_NOT_CONFIGURED");
});
test("WebSocket rejects wrong token and uses the same source/review/runtime model", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      f.origin.replace("http", "ws") + "/api/ws?token=bad",
    );
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("accepted wrong token"));
    });
    ws.on("error", resolve);
  });
  const events = await new Promise((resolve, reject) => {
    const out = [];
    const ws = new WebSocket(
      f.origin.replace("http", "ws") + `/api/ws?token=${f.server.token}`,
    );
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("timeout"));
    }, 2000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const data = JSON.parse(raw);
      out.push(data);
      if (data.params?.type === "gateway.ready")
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "prompt.submit",
            params: { session_id: s.id, text: "请整理病历" },
          }),
        );
      if (data.params?.type === "message.complete") {
        clearTimeout(timeout);
        ws.close();
        resolve(out);
      }
    });
  });
  assert.equal(events.filter((e) => e.id === 1).length, 1);
  assert.ok(events.some((e) => e.params?.type === "tool.complete"));
});

test("stale conversation revision and duplicate request IDs cannot replay turns", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  await f.json(`/api/sessions/${s.id}`, "PATCH", { title: "new title" });
  assert.equal(
    (await f.chat(s.id, "整理资料", { sessionRevision: 0 })).status,
    409,
  );
  assert.equal(
    (await f.chat(s.id, "整理资料", { requestId: "stable-request" })).status,
    200,
  );
  assert.equal(
    (await f.chat(s.id, "整理资料", { requestId: "stable-request" })).status,
    409,
  );
});
test("clinical event edits preserve the immutable source and require a reason", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  await f.chat(s.id, "病历时间线\n2026-01-01 门诊");
  const artifact = (await f.json(`/api/sessions/${s.id}`)).data.artifacts[0];
  const route = `/api/sessions/${s.id}/artifacts/${artifact.id}`;
  const event = { date: "2026-01-02", event: "日期修正", correctionNote: "" };
  assert.equal(
    (
      await f.json(route, "PATCH", {
        version: 1,
        title: "修订",
        events: [event],
      })
    ).status,
    400,
  );
  const changed = (
    await f.json(route, "PATCH", {
      version: 1,
      title: "修订",
      events: [{ ...event, correctionNote: "合成测试校正依据" }],
    })
  ).data;
  assert.equal(changed.events[0].source.quote, "2026-01-01 门诊");
  assert.equal(changed.history[0].events[0].date, "2026-01-01");
  assert.equal(
    (
      await f.json(route, "PATCH", {
        version: 2,
        title: "伪造来源",
        events: [{ ...event, source: { sourceId: "elsewhere" } }],
      })
    ).status,
    400,
  );
});

test("referenced materials retain source integrity and exports include observation provenance", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const route = `/api/sessions/${s.id}/files`;
  const file = (
    await f.json(route, "POST", { name: "r.txt", text: "2026-01-01 Hb 98 g/L" })
  ).data;
  await f.chat(s.id, "摘录检验数值", { fileIds: [file.id] });
  assert.equal((await f.json(route + "/" + file.id, "DELETE")).status, 409);
  const exported = await (
    await f.request(`/api/sessions/${s.id}/export?format=md`)
  ).text();
  assert.match(exported, /SHA256/);
  assert.match(exported, /原文：2026-01-01 Hb 98 g\/L/);
  const untouched = (
    await f.json(route, "POST", { name: "unused.txt", text: "尚未引用" })
  ).data;
  assert.equal(
    (await f.json(route + "/" + untouched.id, "DELETE")).status,
    200,
  );
});

test("copy selected materials starts clean context without carrying review or model history", async (t) => {
  const f = await fixture(t);
  const a = await f.session();
  const selected = (
    await f.json(`/api/sessions/${a.id}/files`, "POST", {
      name: "a.txt",
      text: "2026-01-01 Hb 98 g/L",
    })
  ).data;
  await f.chat(a.id, "检验数值摘录", { fileIds: [selected.id] });
  const before = (await f.json(`/api/sessions/${a.id}`)).data;
  const result = await f.json(`/api/sessions/${a.id}/copy-materials`, "POST", {
    sessionRevision: before.revision,
    fileIds: [selected.id],
  });
  assert.equal(result.status, 201);
  assert.notEqual(result.data.id, a.id);
  assert.equal(result.data.files[0].hash, selected.hash);
  assert.notEqual(result.data.files[0].id, selected.id);
  assert.deepEqual(result.data.messages, []);
  assert.deepEqual(result.data.artifacts, []);
  assert.deepEqual(result.data.runs, []);
  assert.equal(
    (
      await f.json(`/api/sessions/${a.id}/copy-materials`, "POST", {
        sessionRevision: 0,
        fileIds: [selected.id],
      })
    ).status,
    409,
  );
});

test("fork endpoint creates a clean local branch from all materials", async (t) => {
  const f = await fixture(t);
  const source = await f.session("分支源任务");
  const file = (
    await f.json(`/api/sessions/${source.id}/files`, "POST", {
      name: "branch.txt",
      text: "合成分支材料",
    })
  ).data;
  const current = (await f.json(`/api/sessions/${source.id}`)).data;
  const branch = await f.json(`/api/sessions/${source.id}/fork`, "POST", {
    sessionRevision: current.revision,
  });
  assert.equal(branch.status, 201);
  assert.equal(branch.data.files.length, 1);
  assert.notEqual(branch.data.files[0].id, file.id);
  assert.deepEqual(branch.data.messages, []);
  assert.deepEqual(branch.data.artifacts, []);
  assert.deepEqual(branch.data.runs, []);
  assert.equal(branch.data.copiedFrom.sessionId, source.id);
});

test("single-user runtime exposes bounded Harness modes", async (t) => {
  const f = await fixture(t);
  const session = await f.session("模式验证");
  for (const mode of ["standard", "minimal", "creator"])
    assert.equal(
      (
        await f.json(`/api/chat/${session.id}`, "POST", {
          mode,
          message: "模式验证",
        })
      ).status,
      503,
      `${mode} requires an explicitly configured model`,
    );
  assert.equal(
    (
      await f.json(`/api/chat/${session.id}`, "POST", {
        mode: "code",
        message: "代码模式",
      })
    ).status,
    400,
  );
  const bootstrap = (await f.json("/api/bootstrap")).data;
  assert.deepEqual(
    bootstrap.modes.map((mode) => mode.id),
    ["standard", "minimal", "creator", "code"],
  );
});

test("append-only trajectory keeps every runtime event beyond the UI run snapshot", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const result = await f.chat(s.id, "请整理病历");
  assert.ok(result.events.length > 0);
  const events = (await f.json(`/api/sessions/${s.id}/events?limit=500`)).data
    .events;
  assert.ok(events.length >= result.events.length);
  assert.equal(events[0].type, "message.start");
  assert.ok(events.some((e) => e.type === "message.complete"));
  const tail = (
    await f.json(
      `/api/sessions/${s.id}/events?after=${events[events.length - 1].id}`,
    )
  ).data.events;
  assert.deepEqual(tail, []);
});

test("skills endpoint exposes only metadata and the medical skill tool is scoped", async (t) => {
  const f = await fixture(t);
  const list = await f.json("/api/skills");
  assert.equal(list.status, 200);
  assert.ok(list.data.skills.some((s) => s.id === "medical-record"));
  assert.equal(
    JSON.stringify(list.data).includes("extract_clinical_timeline"),
    false,
  );
});

test("provider selection exposes truthful OpenAI-compatible and Anthropic configuration", async (t) => {
  const open = await fixture(t, {
    providerName: "openai",
    apiKey: "synthetic",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "gpt-test",
  });
  assert.equal((await open.json("/api/agent/health")).data.provider, "openai");
  const claude = await fixture(t, {
    providerName: "anthropic",
    apiKey: "synthetic",
    baseUrl: "http://127.0.0.1:9",
    model: "claude-test",
  });
  const boot = (await claude.json("/api/bootstrap")).data;
  assert.equal(boot.provider, "anthropic");
  assert.equal(boot.model, "claude-test");
});
