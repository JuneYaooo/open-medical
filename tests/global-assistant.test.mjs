// 全局聊天 Agent 底座 + 患者自动分组（迭代一）：
// - patient_scan 确定性匹配器（诊断/检验/年龄条件与依据行）
// - patient-grouping 提案生命周期（快照、确认合并、幂等、归档跳过、拒绝）
// - 全局助手会话单例、工作流路由与收窄工具面（合成脚本模型全链路）
// - 今日待办按分组联动过滤
// 全部使用合成数据与合成模型，无真实患者资料。
import test from "node:test";
import assert from "node:assert/strict";
import { scanPatients } from "../server/medical/patient-scan.mjs";
import { createMedicalWorkspaceDomain } from "../server/medical/medical-workspace-domain.mjs";
import { fixture } from "./helpers.mjs";

const answer = (content) => ({ message: { role: "assistant", content } });
const toolCall = (id, name, args) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args ?? {}) } }],
  },
});

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

test("patient_scan: diagnosis/lab/age conditions return matched patients with evidence", () => {
  const now = Date.parse("2026-10-10T12:00:00");
  const registry = {
    all: () => [
      {
        id: "p-recent", name: "术后近期", birthYear: 1970, gender: "male", groups: ["胆囊"],
        diagnoses: [{ name: "胆囊切除术后状态", date: iso(-30) }],
        labs: [{ item: "HbA1c", value: 8.2, unit: "%", date: iso(-10) }],
      },
      {
        id: "p-old", name: "术后已久", birthYear: 1940, gender: "female",
        diagnoses: [{ name: "胃大部切除术后状态", date: iso(-400) }],
        labs: [{ item: "HbA1c", value: 6.1, unit: "%", date: iso(-5) }],
      },
      { id: "p-archived", name: "已归档", archived: true, diagnoses: [{ name: "术后", date: iso(-1) }] },
      { id: "p-none", name: "无相关", birthYear: 1990 },
    ],
  };
  const recent = scanPatients(registry, { diagnosisContains: "术后", diagnosisWithinDays: 90 }, now);
  assert.equal(recent.total, 1);
  assert.equal(recent.matched[0].id, "p-recent");
  assert.match(recent.matched[0].evidence[0], /胆囊切除术后状态/);
  assert.match(recent.matched[0].evidence[0], /90 天内/);

  const uncontrolled = scanPatients(registry, { lab: { item: "HbA1c", op: ">", value: 7, withinDays: 90 } }, now);
  assert.equal(uncontrolled.total, 1);
  assert.equal(uncontrolled.matched[0].id, "p-recent");
  assert.match(uncontrolled.matched[0].evidence[0], /HbA1c 8\.2%/);

  const combined = scanPatients(registry, { diagnosisContains: "术后", diagnosisWithinDays: 90, lab: { item: "HbA1c", op: "<", value: 7 } }, now);
  assert.equal(combined.total, 0, "同一患者须同时满足全部条件");

  const elderly = scanPatients(registry, { ageMin: 75 }, now);
  assert.equal(elderly.total, 1);
  assert.equal(elderly.matched[0].id, "p-old");

  const byGroup = scanPatients(registry, { group: "胆囊" }, now);
  assert.equal(byGroup.total, 1);

  assert.throws(() => scanPatients(registry, {}), { code: "INVALID_INPUT" });
  assert.throws(() => scanPatients(registry, { lab: { item: "HbA1c", op: "~", value: 7 } }), { code: "INVALID_INPUT" });
});

test("patient-grouping: propose snapshots patients, confirm merges groups idempotently", async (t) => {
  const f = await fixture(t);
  const first = f.server.patients.create({ name: "分组患者甲", groups: ["慢病"] });
  const second = f.server.patients.create({ name: "分组患者乙" });

  const proposal = f.server.pendingActions.propose({
    type: "patient-grouping",
    payload: {
      groupName: "术后三个月内",
      patients: [
        { patientId: first.id, reason: "诊断「胆囊切除术后状态」2026-09-15" },
        { patientId: second.id, reason: "就诊「术后复查」2026-09-20" },
        { patientId: first.id, reason: "重复条目应被去重" },
      ],
      note: "来自全局助手对话",
      sourceSessionId: "synthetic-session",
    },
    summary: "建议分组「术后三个月内」：2 位患者",
  });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.patientId, null, "多患者提案不绑定单一患者");
  assert.deepEqual(proposal.payload.patients.map((p) => p.name), ["分组患者甲", "分组患者乙"]);
  assert.deepEqual(proposal.payload.patients[0].groups, ["慢病"], "提案快照当前分组供托盘展示");

  assert.throws(
    () => f.server.pendingActions.propose({ type: "patient-grouping", payload: { groupName: "空", patients: [] }, summary: "空" }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () => f.server.pendingActions.propose({ type: "patient-grouping", payload: { groupName: "缺依据", patients: [{ patientId: first.id }] }, summary: "缺依据" }),
    { code: "INVALID_INPUT" },
  );

  const listed = (await f.json("/api/pending-actions?type=patient-grouping")).data;
  assert.equal(listed.actions.length, 1);

  const confirmed = await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST");
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.action.status, "applied");
  assert.deepEqual(confirmed.data.applied, { added: 2, already: 0, skipped: [] });
  assert.deepEqual(f.server.patients.row(first.id).groups, ["慢病", "术后三个月内"], "确认后合并且保留既有分组");
  assert.deepEqual(f.server.patients.row(second.id).groups, ["术后三个月内"]);

  assert.equal((await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST")).status, 409);

  // 医生确认前患者分组可能已变：重复确认同类提案按幂等处理，不产生重复分组。
  const again = f.server.pendingActions.propose({
    type: "patient-grouping",
    payload: { groupName: "术后三个月内", patients: [{ patientId: first.id, reason: "再次建议" }] },
    summary: "重复建议",
  });
  const retried = await f.json(`/api/pending-actions/${again.id}/confirm`, "POST");
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.data.applied, { added: 0, already: 1, skipped: [] });
  assert.deepEqual(f.server.patients.row(first.id).groups, ["慢病", "术后三个月内"]);

  // 提案生成后才归档的患者在确认时逐个跳过，其余照常生效（propose
  // 阶段已拒绝归档患者，这里模拟的是生成后的漂移）。
  const third = f.server.patients.create({ name: "分组患者丙" });
  const mixed = f.server.pendingActions.propose({
    type: "patient-grouping",
    payload: { groupName: "高血糖", patients: [{ patientId: second.id, reason: "HbA1c 8.2" }, { patientId: third.id, reason: "HbA1c 9.1" }] },
    summary: "混合建议",
  });
  const thirdRow = f.server.patients.row(third.id);
  f.server.patients.update(third.id, { expectedRevision: thirdRow.revision, archived: true });
  const mixedResult = await f.json(`/api/pending-actions/${mixed.id}/confirm`, "POST");
  assert.equal(mixedResult.status, 200);
  assert.equal(mixedResult.data.applied.added, 1);
  assert.equal(mixedResult.data.applied.skipped.length, 1);
  assert.equal(mixedResult.data.applied.skipped[0].reason, "已归档");
  assert.deepEqual(f.server.patients.row(third.id).groups, []);

  const rejected = f.server.pendingActions.propose({
    type: "patient-grouping",
    payload: { groupName: "被拒绝", patients: [{ patientId: second.id, reason: "演示" }] },
    summary: "拒绝演示",
  });
  await f.json(`/api/pending-actions/${rejected.id}/reject`, "POST");
  assert.equal(f.server.pendingActions.row(rejected.id).status, "rejected");
  assert.deepEqual(f.server.patients.row(second.id).groups, ["术后三个月内", "高血糖"], "拒绝后分组不变");
});

test("global assistant: singleton session, narrowed tool surface and full grouping chain", async (t) => {
  let sawTools = null;
  let step = 0;
  const f = await fixture(t, {
    provider: {
      apiKey: "synthetic",
      model: "synthetic",
      async complete(messages, tools) {
        sawTools = tools.map((tool) => tool.function.name);
        step++;
        if (step === 1) return toolCall("call-1", "patient_scan", { diagnosisContains: "术后", diagnosisWithinDays: 90 });
        if (step === 2) {
          const scan = messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
          const patientId = /"matched":\[\{[^}]*?"id":"([0-9a-f-]{36})"/.exec(scan)?.[1];
          return toolCall("call-2", "patient_grouping_propose", {
            groupName: "术后三个月内",
            patients: [{ patientId, reason: "诊断「术后」90 天内（patient_scan 证据）" }],
            note: "按你的要求整理",
          });
        }
        return answer("已生成分组提案，请在「待确认」面板核对。");
      },
    },
  });
  const patient = f.server.patients.create({
    name: "全局助手患者",
    diagnoses: [{ name: "胆囊切除术后状态", date: new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10) }],
  });

  const first = (await f.json("/api/assistant/session", "POST")).data;
  const second = (await f.json("/api/assistant/session", "POST")).data;
  assert.equal(first.id, second.id, "全局助手会话应是单例");
  assert.equal(first.title, "全局助手");
  const workspace = f.server.sessionBridge.workspace(first.id);
  assert.equal(workspace.modeFlags.global, true);
  assert.ok(!workspace.patientId, "全局会话不关联单一患者");

  const chat = await f.chat(first.id, "把术后三个月内的患者分成一组", { mode: "model", externalConsent: true });
  assert.equal(chat.status, 200);
  assert.ok(sawTools.includes("patient_scan"));
  assert.ok(sawTools.includes("patient_grouping_propose"));
  assert.ok(sawTools.includes("list_patients"));
  assert.ok(sawTools.includes("knowledge_collections"), "知识库工具应复用会话插件");
  assert.ok(!sawTools.includes("extract_clinical_timeline"), "全局会话不注册病历整理工作流工具");
  assert.ok(!sawTools.includes("draft_treatment_review"));

  const actions = (await f.json("/api/pending-actions?type=patient-grouping")).data.actions;
  assert.equal(actions.length, 1);
  assert.equal(actions[0].payload.groupName, "术后三个月内");
  assert.equal(actions[0].payload.sourceSessionId, first.id, "提案应能追溯到全局会话");

  const confirmed = await f.json(`/api/pending-actions/${actions[0].id}/confirm`, "POST");
  assert.equal(confirmed.status, 200);
  assert.deepEqual(f.server.patients.row(patient.id).groups, ["术后三个月内"]);

  // 上下文链式继承：第二轮对话能看到上一轮的助手答复。
  const followUp = f.server.workspaces.get(first.id);
  assert.ok(followUp.runs.length >= 1);
  const round2 = await f.chat(first.id, "刚才那个分组叫什么名字？", { mode: "model", externalConsent: true });
  assert.equal(round2.status, 200);
  const runs = f.server.workspaces.get(first.id).runs;
  assert.equal(runs.length, 2, "每条消息一个 run，上下文跨 run 继承");
  assert.equal(runs.every((run) => run.policy?.workflow === "global-assistant"), true);

  // 工作流路由：全局会话拒绝其他工作流。
  const refused = await f.chat(first.id, "整理材料", { mode: "model", externalConsent: true, workflow: "patient-intake" });
  assert.equal(refused.status, 400);
});

test("agenda: group filter keeps only that group's patients and hides unbound items", async (t) => {
  const f = await fixture(t);
  const grouped = f.server.patients.create({ name: "分组待办患者", groups: ["高血糖"] });
  const other = f.server.patients.create({ name: "普通待办患者" });
  f.server.pendingActions.propose({ type: "patient-update", patientId: grouped.id, payload: { allergies: ["青霉素"] }, summary: "分组患者的提案" });
  f.server.pendingActions.propose({ type: "patient-update", patientId: other.id, payload: { allergies: ["头孢"] }, summary: "普通患者的提案" });

  const all = (await f.json("/api/doctor/overview")).data;
  assert.equal(all.work.total, 2);
  const filtered = (await f.json("/api/doctor/overview?group=" + encodeURIComponent("高血糖"))).data;
  assert.equal(filtered.work.total, 1);
  assert.equal(filtered.work.items[0].patientId, grouped.id);
  const missing = (await f.json("/api/doctor/overview?group=" + encodeURIComponent("不存在"))).data;
  assert.equal(missing.work.total, 0);
  assert.equal(missing.counts.all, 0);
});

test("medical domain: global branch replaces the medical discipline without touching patient sessions", () => {
  const domain = createMedicalWorkspaceDomain({ readPatientBrief: () => ({ id: "x" }) });
  const globalWorkspace = { kind: "session", modeFlags: { global: true } };
  const plainSession = { kind: "session", patientId: "p-1" };
  const project = { kind: undefined };
  assert.match(domain.systemFor(globalWorkspace), /全局助手/);
  assert.ok(!domain.systemFor(globalWorkspace).includes("病历材料"));
  assert.match(domain.systemFor(plainSession), /医疗领域能力/);
  assert.equal(domain.systemFor(project), domain.systemFor(project));

  const registered = [];
  const registry = { register: (entry) => registered.push(entry.definition.function.name) };
  domain.registerTools({
    registry,
    workspace: { ...globalWorkspace, materials: [], runs: [{ id: "r1", policy: { workflow: "global-assistant" } }] },
    runId: "r1",
  });
  assert.ok(registered.includes("patient_scan"));
  assert.ok(registered.includes("patient_grouping_propose"));
  assert.ok(!registered.includes("extract_clinical_timeline"));
});
