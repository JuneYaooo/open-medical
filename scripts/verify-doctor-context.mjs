import { parseArgs } from "node:util";
import { randomUUID, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "../server/agent.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const { values } = parseArgs({ options: { directory: { type: "string" }, repeat: { type: "string", default: "2" } } });
const directory = resolve(values.directory || `output/doctor-context-${Date.now()}`), repeats = Number(values.repeat);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = { status: "running", sourceFingerprint: sourceFingerprint(), startedAt: Date.now(), syntheticDataOnly: true, retries: 0, cases: [] };
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
save();
for (let round = 1; round <= repeats; round++) {
  const server = createServer({ database: join(directory, `round-${round}.sqlite`), followupOptions: { autoStart: false }, runtimeOptions: { maxRounds: 20 } });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", data) => fetch(origin + path, { method, headers: { "content-type": "application/json", "x-medical-token": server.token }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(240000) });
  const json = async (path, method, data) => { const r = await request(path, method, data); const body = await r.json(); assert.ok(r.ok, JSON.stringify(body)); return body; };
  const result = { round, status: "running", startedAt: Date.now() }; report.cases.push(result); save();
  try {
    const nonce = randomUUID().slice(0, 8), active = `合成在用-${nonce}`, stopped = `合成停用-${nonce}`, units = randomInt(100, 500), note = `合成联系记录-${nonce}`;
    const p = await json("/api/patients", "POST", { name: `合成验收-${nonce}`, allergyStatus: "unknown", medications: [{ name: active, status: "active" }, { name: stopped, status: "stopped" }], labs: [{ item: "合成数值", value: units, unit: "TEST", date: "2026-09-20" }] });
    await json(`/api/patients/${p.id}/followup-records`, "POST", { title: "合成主动联系", status: "completed", note });
    await json(`/api/patients/${p.id}/care-tasks`, "POST", { title: "合成待收报告", kind: "test", dueAt: new Date(Date.now() + 86400000).toISOString() });
    const original = await json(`/api/patients/${p.id}`);
    const message = '这位患者的当前档案是什么情况？请读取当前关联患者的最新资料后直接回答，不创建文书或提案。仅返回一个 JSON 对象：allergyStatus 为档案核对状态，activeMeds 为正在使用的药名数组，stoppedMeds 为已停用药名数组，latestLabValue 为最近合成数值，pendingCareCount 为尚未闭环的检查转诊数，lastContactNote 为最近联系记录原文。不要根据我的问题猜数据。';
    const response = await request(`/api/chat/${p.sessionId}`, "POST", { message, mode: "model", externalConsent: true });
    const eventsText = await response.text(); assert.ok(response.ok);
    const session = await json(`/api/sessions/${p.sessionId}`), run = session.runs.at(-1);
    result.runStatus = run?.status; result.model = server.runtime.provider.model; result.provider = server.runtime.provider.provider;
    assert.equal(run?.status, "completed", run?.error || "Run not complete");
    const events = (await json(`/api/workspaces/${p.sessionId}/events`)).events;
    const tools = events.filter((e) => e.run_id === run.id && e.type === "tool.complete").map((e) => e.payload.tool);
    result.tools = [...new Set(tools)]; assert.ok(tools.includes("read_patient_brief"), "No actual patient context read");
    const answer = session.messages.filter((m) => m.role === "assistant").at(-1)?.content || "";
    const match = answer.match(/\{[\s\S]*\}/); assert.ok(match, "No structured answer");
    const parsed = JSON.parse(match[0]);
    assert.equal(parsed.allergyStatus, "unknown"); assert.deepEqual(parsed.activeMeds, [active]); assert.deepEqual(parsed.stoppedMeds, [stopped]);
    assert.equal(parsed.latestLabValue, units); assert.equal(parsed.pendingCareCount, 1); assert.equal(parsed.lastContactNote, note);
    assert.equal(session.artifacts.length, 0); assert.deepEqual(await json(`/api/patients/${p.id}`), original);
    assert.equal((await json(`/api/pending-actions?patientId=${p.id}`)).actions.length, 0);
    writeFileSync(join(directory, `round-${round}-response.txt`), answer, { mode: 0o600 });
    result.status = "passed"; result.checks = ["actual current-patient tool", "randomized source values", "unknown allergy preserved", "stopped medication excluded from active", "contact and care tracking linked", "no chart mutation or unsolicited draft"];
    result.streamEvents = eventsText.split("\n").filter((line) => line.startsWith("data:")).length;
    const newValue = randomInt(501, 900);
    const source = await json(`/api/sessions/${p.sessionId}/files`, "POST", { name: "合成复查材料.txt", text: `这是合成验收数据，无临床含义。\n2026-09-21 合成数值：${newValue} TEST。\n这次材料只含新增记录，既往记录仍需保留。` });
    const updateResponse = await request(`/api/chat/${p.sessionId}`, "POST", { message: "请读取本次选中的复查材料，把新增检验用 patient_record_propose 提议补充到当前患者档案，保留既往记录，标注文件名与行号来源。只做资料整理，不做临床解释；由我核对后写入。", mode: "model", externalConsent: true, fileIds: [source.id] });
    await updateResponse.text(); assert.ok(updateResponse.ok);
    const proposals = (await json(`/api/pending-actions?patientId=${p.id}`)).actions.filter((action) => action.type === "patient-update" && action.status === "pending");
    assert.equal(proposals.length, 1, "Expected exactly one clinical proposal");
    const proposedLabs = proposals[0].payload.labs;
    assert.ok(proposedLabs.some((lab) => lab.value === units && lab.date === "2026-09-20"), "Proposal lost old lab");
    assert.ok(proposedLabs.some((lab) => lab.value === newValue && lab.unit === "TEST" && lab.date === "2026-09-21" && lab.source?.includes("合成复查材料")), "New lab lacks exact value or source");
    assert.deepEqual(await json(`/api/patients/${p.id}`), original, "Model wrote chart before review");
    // Synthetic fixture acceptance only, not a claim of clinical review.
    await json(`/api/pending-actions/${proposals[0].id}/confirm`, "POST", {});
    const confirmed = await json(`/api/patients/${p.id}`);
    assert.equal(confirmed.labs.length, 2); assert.equal(confirmed.medications.length, 2); assert.equal(confirmed.allergyStatus, "unknown");
    result.checks.push("actual material read and source-linked proposal", "old history retained", "chart unchanged before fixture approval", "approved clinical addition persisted");
  } catch (error) { result.status = "failed"; result.error = error.message; }
  finally { result.elapsedMs = Date.now() - result.startedAt; await server.shutdown(); save(); }
}
report.status = report.cases.every((item) => item.status === "passed") ? "passed" : "failed"; report.endedAt = Date.now(); save();
if (report.status === "failed") process.exitCode = 1;
console.log(`Doctor context acceptance ${report.status}; ${join(directory, "report.json")}`);
