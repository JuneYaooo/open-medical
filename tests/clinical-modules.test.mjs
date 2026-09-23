import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { knowledgeTools } from "../server/medical/guidelines.mjs";
import { briefDraft } from "../shared/patient-brief.mjs";

const protocol = {
  title: "合成试验",
  version: "测试版 2026-09",
  inclusion: "年龄至少18岁\n具有已记录诊断",
  exclusion: "正在参加另一干预试验",
  sourceUrl: "https://example.org/protocol",
};
test("trial screening separates exclusion triggers, missing evidence, patient records and concurrent edits", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "合成初筛甲" }))
    .data;
  const q = (await f.json("/api/patients", "POST", { name: "合成初筛乙" }))
    .data;
  const created = await f.json("/api/trials", "POST", protocol);
  assert.equal(created.status, 201);
  const trial = created.data,
    path = `/api/trials/${trial.id}/screenings/${p.id}`;
  const checks = trial.criteria.map((c) => ({
    id: c.id,
    value: "unknown",
    evidence: "",
  }));
  let saved = await f.json(path, "PUT", { expectedRevision: 0, checks });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.missing, 3);
  assert.equal(
    (await f.json(path, "PUT", { expectedRevision: 0, checks })).status,
    409,
  );
  assert.equal(
    (
      await f.json(path, "PUT", {
        expectedRevision: 1,
        checks: checks.map((c) => ({ ...c, value: "yes" })),
      })
    ).status,
    400,
  );
  const known = checks.map((c) => ({
    ...c,
    value: "yes",
    evidence: "合成原文 2026-09-01，第1行",
  }));
  saved = await f.json(path, "PUT", { expectedRevision: 1, checks: known });
  assert.equal(saved.data.conflicts, 1);
  assert.equal(saved.data.history.length, 1);
  known.at(-1).value = "no";
  saved = await f.json(path, "PUT", { expectedRevision: 2, checks: known });
  assert.equal(saved.data.conflicts, 0);
  assert.match(saved.data.summary, /待研究者/);
  assert.equal(
    (await f.json(`/api/trials/${trial.id}/screenings/${q.id}`)).data.revision,
    0,
  );
  await f.json(`/api/patients/${p.id}`, "PATCH", {
    expectedRevision: p.revision,
    archived: true,
  });
  assert.equal(
    (await f.json(path, "PUT", { expectedRevision: 3, checks: known })).status,
    409,
  );
});

test("trial creation and screening roll back when audit fails; unsafe sources rejected", async (t) => {
  const f = await fixture(t);
  for (const sourceUrl of [
    "javascript:alert(1)",
    "https://user:password@example.org",
  ])
    assert.equal(
      (await f.json("/api/trials", "POST", { ...protocol, sourceUrl })).status,
      400,
    );
  const audit = f.server.store.audit;
  f.server.store.audit = () => {
    throw Error("synthetic audit failure");
  };
  assert.equal((await f.json("/api/trials", "POST", protocol)).status, 500);
  f.server.store.audit = audit;
  assert.equal((await f.json("/api/trials")).data.trials.length, 0);
});

test("knowledge collections retain intended use and never silently escape explicit scope", async (t) => {
  const f = await fixture(t);
  const path = "/api/knowledge/collections/" + encodeURIComponent("合成门诊库");
  assert.equal(
    (await f.json(path, "PUT", { expectedRevision: 0, description: "资料" }))
      .status,
    400,
  );
  const meta = {
    expectedRevision: 0,
    description: "合成随访资料",
    whenToUse: "准备随访时",
    limitations: "仅用于软件测试",
  };
  assert.equal((await f.json(path, "PUT", meta)).status, 200);
  assert.equal((await f.json(path, "PUT", meta)).status, 409);
  const text = "合成复诊资料，不用于临床决策。".repeat(20);
  const a = await f.json("/api/knowledge", "POST", {
    title: "复诊资料",
    collection: "合成门诊库",
    text,
  });
  const b = await f.json("/api/knowledge", "POST", {
    title: "同文资料",
    collection: "另一库",
    text,
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.data.id, b.data.id);
  assert.equal(a.data.sha256, b.data.sha256);
  const catalog = (
    await f.json("/api/knowledge/collections")
  ).data.collections.find((c) => c.name === "合成门诊库");
  assert.equal(catalog.whenToUse, meta.whenToUse);
  assert.equal(catalog.documentCount, 1);
  const search = knowledgeTools(f.server.guidelines).find(
    (t) => t.definition.function.name === "knowledge_search",
  );
  const result = await search.execute({
    query: "复诊",
    collection: "不存在的库",
  });
  assert.equal(result.count, 0);
});

test("follow-up clinical feedback reaches patient context and filters history on the server", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "合成回访患者" }))
    .data;
  const path = `/api/patients/${p.id}/followup-records`;
  assert.equal(
    (
      await f.json(path, "POST", {
        status: "unreachable",
        note: "未接听",
        clinical: { symptoms: "已核实无不适" },
      })
    ).status,
    400,
  );
  const saved = await f.json(path, "POST", {
    requestId: "clinical-1",
    title: "合成用药反馈",
    status: "completed",
    note: "家属提供反馈",
    contactMethod: "phone",
    clinical: { medications: "药盒照片尚待核实", plan: "下次带来药盒" },
  });
  assert.equal(saved.status, 201);
  assert.equal(
    (
      await f.json(path, "POST", {
        requestId: "clinical-1",
        title: "合成用药反馈",
        status: "completed",
        note: "家属提供反馈",
        contactMethod: "phone",
        clinical: { medications: "不同内容" },
      })
    ).status,
    409,
  );
  await f.json(path, "POST", {
    status: "declined",
    title: "合成拒访",
    note: "本次不便联系",
  });
  const filtered = (
    await f.json(
      "/api/reminders?status=done&outcome=completed&q=" +
        encodeURIComponent("合成用药"),
    )
  ).data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.reminders[0].id, saved.data.id);
  const brief = (await f.json(`/api/patients/${p.id}/brief`)).data;
  assert.match(briefDraft(brief), /药盒照片尚待核实/);
});
