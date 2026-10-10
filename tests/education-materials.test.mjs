import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { WecomAibotChannel } from "../server/chat-aibot.mjs";

const BODY = "术后一周内伤口保持干燥，出现发热超过 38.5 度请及时联系医生。";

async function setup(t, { wecom = { corpId: "ww1234567890" } } = {}) {
  const f = await fixture(t, { wecom, care: { intervalMs: 3600000 } });
  const patient = (await f.json("/api/patients", "POST", { name: "患教患者", groups: ["肝癌随访"] })).data;
  return { ...f, patient, care: f.server.care };
}
const createMaterial = async (f) =>
  (
    await f.json("/api/knowledge/education-materials", "POST", {
      title: "介入术后居家注意",
      body: BODY,
    })
  ).data;

test("education materials live in their own collection with the review loop", async (t) => {
  const f = await setup(t);
  // 内置患教素材库自动就位。
  const collections = (await f.json("/api/knowledge/collections")).data.collections;
  const education = collections.find((c) => c.name === "患教素材");
  assert.ok(education, "患教素材库应自动创建");
  assert.match(education.description, /患教/);
  const material = await createMaterial(f);
  assert.equal(material.kind, "患教");
  assert.equal(material.collection, "患教素材");
  assert.equal(material.reviewStatus, "unreviewed");
  // 未核对的素材不被检索命中;核对后命中。
  const unreviewed = (await f.json("/api/guidelines/search?q=伤口&collection=患教素材&reviewStatus=unreviewed")).data;
  assert.equal(unreviewed.hits.length, 1);
  let reviewed = (await f.json("/api/guidelines/search?q=伤口&collection=患教素材&reviewStatus=reviewed")).data;
  assert.equal(reviewed.hits.length, 0);
  const marked = await f.json(`/api/knowledge/${material.id}`, "PATCH", {
    expectedRevision: 0,
    reviewStatus: "reviewed",
    reviewNote: "医生逐句核对过",
  });
  assert.equal(marked.status, 200);
  reviewed = (await f.json("/api/guidelines/search?q=伤口&collection=患教素材&reviewStatus=reviewed")).data;
  assert.equal(reviewed.hits.length, 1);
  // 改正文撤销复核,重新计数。
  const updated = await f.json(`/api/knowledge/education-materials/${material.id}`, "PUT", {
    text: `${BODY}一周后门诊复查。`,
    expectedRevision: marked.data.revision,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.reviewStatus, "unreviewed");
  assert.equal(updated.data.revision, marked.data.revision + 1);
  const badRevision = await f.json(`/api/knowledge/education-materials/${material.id}`, "PUT", {
    text: "x",
    expectedRevision: 0,
  });
  assert.equal(badRevision.status, 409);
});

test("smart-reply drafting puts reviewed education material first in the prompt", async (t) => {
  const prompts = [];
  const channel = new WecomAibotChannel({
    provider: {
      apiKey: "test",
      model: "fake",
      async complete(messages) {
        prompts.push(messages);
        return { message: { content: "好的" } };
      },
    },
    guidelines: {
      async search({ collection, reviewStatus, limit }) {
        if (collection === "患教素材" && reviewStatus === "reviewed")
          return { hits: [{ docTitle: "介入术后居家注意", docId: "gl_edu", startLine: 1, endLine: 3, matches: [{ text: BODY }] }] };
        return { hits: [{ docTitle: "肝癌诊疗指南", docId: "gl_guide", startLine: 10, endLine: 20, matches: [{ text: "指南原文片段" }] }] };
      },
    },
  });
  const draft = await channel.modelDraft({ patientId: "p1", title: "会话" }, "术后要注意什么？");
  assert.equal(draft, "好的");
  assert.equal(prompts.length, 1);
  const user = JSON.parse(prompts[0].find((m) => m.role === "user").content);
  assert.ok(user.知识库[0].title.startsWith("[患教素材]"), "患教素材应排最前");
  assert.match(user.知识库[0].snippet, /伤口保持干燥/);
  const system = prompts[0].find((m) => m.role === "system").content;
  assert.match(system, /\[患教素材\]/);
});

function wecomFetch(log) {
  return async (url, init = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const reply = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/gettoken")) return reply({ errcode: 0, access_token: "tok", expires_in: 7200 });
    return reply({ errcode: 404 });
  };
}

test("education broadcast proposes from a material and applies per-patient wecom tasks", async (t) => {
  const log = [];
  const f = await fixture(t, {
    wecom: { corpId: "ww1234567890", corpSecret: "contactsecret123" },
    care: { fetch: wecomFetch(log), intervalMs: 3600000 },
  });
  const bound = (await f.json("/api/patients", "POST", { name: "已绑定患者", groups: ["肝癌随访"] })).data;
  const unbound = (await f.json("/api/patients", "POST", { name: "未绑定患者", groups: ["肝癌随访"] })).data;
  const material = await createMaterial(f);
  await f.json(`/api/knowledge/${material.id}`, "PATCH", { expectedRevision: 0, reviewStatus: "reviewed", reviewNote: "核对" });
  // 直接种一条有效企微关联(同步客户列表需要完整网络流程,与本测试无关)。
  const db = f.server.wecom.db;
  db.prepare("INSERT INTO wecom_contacts(corp,member,external,name,active,updated) VALUES (?,?,?,?,1,?)").run("ww1234567890", "assistant1", "wmEXT1", "已绑定客户", new Date().toISOString());
  db.prepare("INSERT INTO wecom_bindings VALUES (?,?,?,?,?,?,?)").run(randomUUID(), "ww1234567890", "assistant1", "wmEXT1", bound.id, "self", new Date().toISOString());
  // 拦截真实企微 API,记录 addMsgTemplate 调用。
  const calls = [];
  f.server.wecom.client = {
    async addMsgTemplate(input) {
      calls.push(input);
      return { errcode: 0, msgid: `msg-${calls.length}` };
    },
  };
  // 提案:正文从素材解析,托盘可见。
  const proposed = await f.json("/api/care/education-broadcast/propose", "POST", {
    materialId: material.id,
    materialTitle: material.title,
    patientIds: [bound.id, unbound.id],
  });
  assert.equal(proposed.status, 201);
  assert.equal(proposed.data.type, "care-education-broadcast");
  assert.equal(proposed.data.payload.text, BODY);
  assert.deepEqual(proposed.data.payload.recipients.map((r) => r.patientId), [bound.id, unbound.id]);
  // 医生确认 → 逐患者建任务,未绑定者跳过。
  const confirmed = await f.json(`/api/pending-actions/${proposed.data.id}/confirm`, "POST", {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.applied.broadcast.created, 1);
  assert.equal(confirmed.data.applied.broadcast.skipped.length, 1);
  assert.match(confirmed.data.applied.broadcast.skipped[0].reason, /企微客户关联/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat_type, "single");
  assert.equal(calls[0].external_userid[0], "wmEXT1");
  assert.equal(calls[0].text.content, BODY);
  const tasks = f.server.wecom.tasks(bound.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "awaiting_member");
  // 提案正文与素材不一致时走自定义内容;空患者列表被拒绝。
  const empty = await f.json("/api/care/education-broadcast/propose", "POST", { materialId: material.id, patientIds: [] });
  assert.equal(empty.status, 400);
});
