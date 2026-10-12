import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// 同一资料任务重跑建档分析时，新提案应取代旧提案：托盘只留一张卡，
// 被取代的旧卡不再出现在待确认列表，审计里保留 supersededBy 指向。
test("re-proposing intake for the same session supersedes the stale pending proposal", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("patient_create_propose"));
  const service = f.server.runtime.toolPlugins.get("patient_create_propose");
  const source = await f.session("上传资料建档");

  const first = service.execute({
    name: "李xx",
    gender: "male",
    diagnoses: [{ name: "弥漫大B细胞淋巴瘤（GCB来源）", date: "2026-02-11" }],
    sourceSessionId: source.id,
    summary: "第一次分析给出的建档提案",
  });
  assert.equal(first.status, "pending");

  const second = service.execute({
    name: "李xx",
    gender: "male",
    diagnoses: [{ name: "弥漫大B细胞淋巴瘤（GCB来源）", date: "2026-02-11" }],
    sourceSessionId: source.id,
    summary: "重新分析后的建档提案",
  });
  assert.equal(second.status, "pending");

  const listed = (await f.json("/api/pending-actions?status=pending")).data;
  const mine = listed.actions.filter(
    (a) => a.type === "patient-create" && a.payload.sourceSessionId === source.id,
  );
  assert.equal(mine.length, 1, "同一任务只应留一张待确认卡");
  assert.equal(mine[0].id, second.id);

  const stale = (await f.json(`/api/pending-actions?status=superseded`)).data;
  const staleRow = stale.actions.find((a) => a.id === first.id);
  assert.ok(staleRow, "旧提案应标记为 superseded 而不是消失");
  assert.equal(staleRow.payload.supersededBy, second.id);

  // 被取代的提案不能再被确认。
  const late = await f.json(`/api/pending-actions/${first.id}/confirm`, "POST");
  assert.equal(late.status, 409);
});

// 跨任务的同名提案不合并（可能是真的两个人），由前端提示医生人工核对。
test("proposals from different sessions are not merged silently", async (t) => {
  const f = await fixture(t);
  const service = f.server.runtime.toolPlugins.get("patient_create_propose");
  const a = await f.session("上传资料建档 A");
  const b = await f.session("上传资料建档 B");
  service.execute({ name: "李xx", sourceSessionId: a.id, summary: "任务A" });
  service.execute({ name: "李xx", sourceSessionId: b.id, summary: "任务B" });
  const listed = (await f.json("/api/pending-actions?status=pending")).data;
  assert.equal(
    listed.actions.filter((x) => x.type === "patient-create").length,
    2,
  );
});

// 模型整理病历时自述「某文件不可读」，该文件的识别质量要被降为待核对：
// 统计评分对词汤式乱码会误判良好，模型的这份判断是最后一道兜底。
test("confirming a proposal flags materials the model said it could not read", async (t) => {
  const f = await fixture(t);
  const s = await f.session("上传资料建档");
  const added = (await f.json(`/api/sessions/${s.id}/files`, "POST", {
    name: "j3.jpg",
    image: PNG,
  })).data;
  const fileId = added.file?.id || added.id;
  assert.ok(fileId, "图片材料应创建成功");
  // 材料按真实路径应在 prepare 时写质量分；这里直接摆成「本地识别完成、
  // 评分良好」的成品形态，聚焦验证提案确认后的回写行为。
  f.server.sessionBridge.service.store.update(s.id, (w) => {
    w.materials[0].extraction.ocr = {
      status: "ready",
      method: "local-ocr",
      pages: 1,
      lines: 10,
      quality: { score: 92, level: "good" },
    };
  });

  const service = f.server.runtime.toolPlugins.get("patient_create_propose");
  const proposal = service.execute({
    name: "检测患者",
    gender: "male",
    visits: [
      {
        date: "2024-08-06",
        reason: "PET/CT 检查",
        note: "来源 j3.jpg 第4行；报告日期字段不可读。",
      },
    ],
    sourceSessionId: s.id,
    sourceFileIds: [fileId],
    summary: "带不可读标注的建档提案",
  });

  const confirmed = await f.json(
    `/api/pending-actions/${proposal.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);
  const made = confirmed.data.applied;
  assert.equal(made.name, "检测患者");

  // 患者工作区里的同名材料（建档时从任务复制过来）应带上待核对标注。
  const patientSession = (await f.json(`/api/sessions/${made.sessionId}`)).data;
  const copied = patientSession.files.find((x) => x.name === "j3.jpg");
  assert.ok(copied, "来源材料应随建档复制进患者工作区");
  assert.equal(copied.extraction?.ocr?.quality?.level, "fair");
  assert.equal(copied.extraction?.ocr?.quality?.flaggedBy, "agent-review");

  // 识别质量更差的材料不被升级：把患者工作区里的材料摆成 poor 再触发回写。
  f.server.sessionBridge.service.store.update(made.sessionId, (w) => {
    w.materials.find((x) => x.name === "j3.jpg").extraction.ocr.quality = {
      score: 30,
      level: "poor",
    };
  });
  const update = f.server.runtime.toolPlugins.get("patient_record_propose");
  const patch = update.execute({
    patientId: made.id,
    visits: [
      { date: "2024-09-30", reason: "复查", note: "来源 j3.jpg 缺字严重，无法辨认。" },
    ],
    summary: "补一条就诊",
  });
  const patched = await f.json(`/api/pending-actions/${patch.id}/confirm`, "POST");
  assert.equal(patched.status, 200);
  const after = (await f.json(`/api/sessions/${made.sessionId}`)).data;
  const still = after.files.find((x) => x.name === "j3.jpg");
  assert.equal(still.extraction?.ocr?.quality?.level, "poor", "已有 poor 评级不应被降级覆盖为 fair");
});

// 档案更新提案同样触发回写：模型在 note 里点名某文件不可读时生效。
test("patient-record update flags unreadable materials too", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "回写患者" }))
    .data;
  await f.json(`/api/sessions/${patient.sessionId}/files`, "POST", {
    name: "10.jpg",
    image: PNG,
  });
  f.server.sessionBridge.service.store.update(patient.sessionId, (w) => {
    w.materials[0].extraction.ocr = {
      status: "ready",
      method: "local-ocr",
      quality: { score: 88, level: "good" },
    };
  });
  const service = f.server.runtime.toolPlugins.get("patient_record_propose");
  const proposal = service.execute({
    patientId: patient.id,
    diagnoses: [
      {
        name: "内分泌科出院小结待核对",
        status: "needs_review",
        note: "10.jpg 第34行仅见标题，无法辨认正文。",
      },
    ],
    summary: "标注读不清的清单页",
  });
  const confirmed = await f.json(
    `/api/pending-actions/${proposal.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);
  const session = (await f.json(`/api/sessions/${patient.sessionId}`)).data;
  const flagged = session.files.find((x) => x.name === "10.jpg");
  assert.equal(flagged.extraction?.ocr?.quality?.level, "fair");
  assert.equal(flagged.extraction?.ocr?.quality?.flaggedBy, "agent-review");
});

// 全局助手必须能回答「我有几个患者」：patient_query 是只读名单入口，
// 模型不再因为缺工具而断言"本机没有患者"。
test("patient_query lists managed patients with diagnosis summaries", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("patient_query"));
  assert.ok(boot.tools.includes("patient_group_propose"));

  const made = (await f.json("/api/patients", "POST", {
    name: "王秀英",
    gender: "female",
    birthYear: 1952,
    groups: ["2型糖尿病"],
    diagnoses: [
      { code: "E11.9", name: "2型糖尿病", date: "2024-03-01" },
      { name: "高血压", date: "2024-03-01" },
    ],
  })).data;

  const query = f.server.runtime.toolPlugins.get("patient_query");
  const all = query.execute({});
  assert.equal(all.total, 1);
  assert.equal(all.patients[0].name, "王秀英");
  assert.equal(all.patients[0].id, made.id);
  assert.deepEqual(all.patients[0].mainDiagnoses, ["2型糖尿病", "高血压"]);

  const filtered = query.execute({ query: "秀英" });
  assert.equal(filtered.total, 1);
  const miss = query.execute({ query: "不存在" });
  assert.equal(miss.total, 0);
});

// 分组提案：指定名单直接成案；不指定名单时走规则引擎扫描。
test("patient_group_propose drafts grouping via ids or rule scan", async (t) => {
  const f = await fixture(t);
  const made = (await f.json("/api/patients", "POST", {
    name: "李雷霆",
    diagnoses: [{ code: "I10", name: "原发性高血压", date: "2025-01-01" }],
  })).data;

  const group = f.server.runtime.toolPlugins.get("patient_group_propose");

  const manual = group.execute({
    groupName: "随访重点",
    patientIds: [made.id],
    reason: "医生口头指定",
  });
  assert.equal(manual.status, "pending");
  const listed = (await f.json("/api/pending-actions?status=pending")).data;
  const draft = listed.actions.find((a) => a.type === "patient-group-suggest");
  assert.ok(draft, "分组提案应进入待确认托盘");
  const manualEntry = draft.payload.assignments.find((a) => a.patientId === made.id);
  assert.deepEqual(manualEntry?.addTags, ["随访重点"]);

  const scanned = group.execute({});
  assert.equal(scanned.status, "pending");
  const after = (await f.json("/api/pending-actions?status=pending")).data;
  const scanDraft = after.actions.find(
    (a) => a.type === "patient-group-suggest" && a.id !== draft.id,
  );
  assert.ok(scanDraft, "规则扫描应产出分组提案");
  const entry = scanDraft.payload.assignments.find((a) => a.patientId === made.id);
  assert.ok(entry, "规则扫描应覆盖到高血压患者");
  assert.ok((entry.addTags || []).includes("高血压"));
});

