import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const answer = (content) => ({ message: { role: "assistant", content } });
const call = (name, args) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-" + name,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
const LAB_TEXT = "2026-09-19 化验\n血糖: 8.9 mmol/L\n血红蛋白: 105 g/L";
const stubProvider = {
  provider: "stub",
  model: "stub-model",
  apiKey: "stub-key",
  async complete(messages) {
    if (!messages.some((m) => m.role === "tool"))
      return call("extract_observations", {});
    return answer("整理完成：已摘录检验数值，请复核。");
  },
};

test("new home sessions run on the unified kernel with the medical layer", async (t) => {
  const f = await fixture(t, { provider: stubProvider });
  const created = await f.json("/api/sessions", "POST", { title: "统一会话" });
  assert.equal(created.status, 201);
  const session = created.data;
  assert.equal(session.kind, "session");
  assert.equal(session.files.length, 0);

  const added = await f.json(`/api/sessions/${session.id}/files`, "POST", {
    name: "化验单.txt",
    text: LAB_TEXT,
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.name, "化验单.txt");

  const detail = await f.json(`/api/sessions/${session.id}`);
  assert.equal(detail.data.files.length, 1);
  assert.equal(detail.data.files[0].text, LAB_TEXT);

  // 内核能力与医疗叠层同时可用
  const wsList = await f.json("/api/workspaces");
  assert.ok(
    wsList.data.workspaces.every((w) => w.kind !== "session"),
    "session workspaces must not appear in the projects list",
  );
  const capabilities = await f.json(
    `/api/workspaces/${session.id}/capabilities`,
  );
  const toolNames = capabilities.data.tools.map((tool) => tool.name);
  for (const name of [
    "list_directory",
    "web_search",
    "extract_observations",
    "list_skills",
    "patient_create_propose",
  ])
    assert.ok(toolNames.includes(name), `missing tool ${name}`);
});

test("session chat: local rule mode and model mode both land structured artifacts", async (t) => {
  const f = await fixture(t, { provider: stubProvider });
  const session = (await f.json("/api/sessions", "POST", {})).data;
  await f.json(`/api/sessions/${session.id}/files`, "POST", {
    name: "化验单.txt",
    text: LAB_TEXT,
  });
  const revision = (await f.json(`/api/sessions/${session.id}`)).data.revision;

  const local = await f.chat(session.id, "整理这份化验单", {
    mode: "local",
    sessionRevision: revision,
    fileIds: [],
    requestId: "local-1",
  });
  const localTypes = local.events.map((e) => e.type);
  assert.ok(localTypes.includes("tool.complete"));
  assert.ok(localTypes.includes("message.complete"));
  let detail = (await f.json(`/api/sessions/${session.id}`)).data;
  assert.equal(detail.runs.at(-1).mode, "local");
  assert.equal(detail.runs.at(-1).policy.intent, "observations");
  assert.equal(detail.artifacts.at(-1).type, "observations");
  assert.equal(detail.artifacts.at(-1).provenance, "local_rule");
  assert.ok(detail.messages.at(-1).content.includes("检验数值"));
  assert.equal(detail.messages.at(-1).intent, "observations");

  const model = await f.chat(session.id, "请摘录检验数值", {
    mode: "model",
    externalConsent: true,
    sessionRevision: detail.revision,
    fileIds: [],
    requestId: "model-1",
  });
  assert.ok(model.events.map((e) => e.type).includes("message.complete"));
  detail = (await f.json(`/api/sessions/${session.id}`)).data;
  const run = detail.runs.at(-1);
  assert.equal(run.status, "completed");
  assert.equal(run.mode, "model");
  assert.ok(run.usage.total_tokens >= 0);
  // 模型模式下 collectArtifacts 收集结构化产物
  assert.equal(run.artifacts.at(-1).type, "observations");
  assert.equal(run.artifacts.at(-1).provenance, "model_draft");
  assert.equal(detail.messages.at(-1).intent, "observations");

  // 复核端点作用于内核运行中的结构化产物
  const artifact = detail.artifacts.at(-1);
  const reviewed = await f.json(
    `/api/sessions/${session.id}/artifacts/${artifact.id}/review`,
    "POST",
    {
      decision: "approved",
      note: "数值与原文一致",
      attested: true,
      version: artifact.version,
    },
  );
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.status, "approved");
  assert.equal(reviewed.data.reviews.length, 1);
});

test("session chats reach generic kernel tools (terminal-free file read)", async (t) => {
  const seen = [];
  const provider = {
    provider: "stub",
    model: "stub-model",
    apiKey: "stub-key",
    async complete(messages) {
      if (!messages.some((m) => m.role === "tool")) {
        seen.push(JSON.stringify(messages));
        return call("list_directory", { path: "." });
      }
      return answer("目录读取完成。");
    },
  };
  const f = await fixture(t, { provider });
  const session = (await f.json("/api/sessions", "POST", {})).data;
  const detail = (await f.json(`/api/sessions/${session.id}`)).data;
  const run = await f.chat(session.id, "列出会话文件", {
    mode: "model",
    externalConsent: true,
    sessionRevision: detail.revision,
    requestId: "generic-1",
  });
  assert.ok(run.events.map((e) => e.type).includes("message.complete"));
  const toolFrame = run.events.find(
    (e) => e.type === "tool.complete" && e.payload?.tool === "list_directory",
  );
  assert.ok(toolFrame, "kernel file tool must be reachable from a session");
});

test("legacy sessions keep the old engine; both kinds appear in one list", async (t) => {
  const f = await fixture(t, { provider: stubProvider });
  const legacy = (
    await f.json("/api/sessions", "POST", { id: "legacy-abc123", title: "旧会话" })
  ).data;
  assert.equal(legacy.kind, undefined);
  const unified = (await f.json("/api/sessions", "POST", {})).data;
  assert.equal(unified.kind, "session");
  const list = (await f.json("/api/sessions")).data.sessions;
  const ids = list.map((s) => s.id);
  assert.ok(ids.includes("legacy-abc123"));
  assert.ok(ids.includes(unified.id));
  const localRun = await f.chat("legacy-abc123", "整理", {
    mode: "local",
    requestId: "legacy-local-1",
  });
  assert.ok(localRun.events.map((e) => e.type).includes("message.complete"));
});

test("patient sessions are unified workspaces and are removed with the patient", async (t) => {
  const f = await fixture(t, { provider: stubProvider });
  const patient = (
    await f.json("/api/patients", "POST", { name: "桥接测试" })
  ).data;
  assert.ok(patient.sessionId);
  const detail = await f.json(`/api/sessions/${patient.sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.kind, "session");
  assert.equal(detail.data.patientId, patient.id);
  const removed = await f.json(`/api/patients/${patient.id}`, "DELETE");
  assert.equal(removed.status, 200);
  const gone = await f.json(`/api/sessions/${patient.sessionId}`);
  assert.equal(gone.status, 404);
});
