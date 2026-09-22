import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createServer } from "../server/agent.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { checkSoakContinuity } from "./soak-continuity.mjs";

const { values } = parseArgs({ options: { hours: { type: "string", default: "5" }, "interval-ms": { type: "string", default: "15000" }, iterations: { type: "string" }, directory: { type: "string" }, background: { type: "boolean" } } });
const hours = Number(values.hours), interval = Number(values["interval-ms"]), maximum = values.iterations ? Number(values.iterations) : Infinity;
assert.ok(hours > 0 && hours <= 8 && Number.isInteger(interval) && interval >= 0 && interval <= 60000 && (maximum === Infinity || Number.isInteger(maximum) && maximum > 0));
const directory = resolve(values.directory || `output/doctor-soak-${Date.now()}`); mkdirSync(directory, { recursive: true, mode: 0o700 });
if (values.background) {
  const log = openSync(join(directory, "worker.log"), "a", 0o600);
  const child = spawn(process.execPath, [process.argv[1], "--hours", String(hours), "--interval-ms", String(interval), "--directory", directory, ...(maximum !== Infinity ? ["--iterations", String(maximum)] : [])], { detached: true, stdio: ["ignore", log, log] });
  closeSync(log); await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); }); child.unref();
  console.log(JSON.stringify({ pid: child.pid, directory, report: join(directory, "report.json") }));
} else {
  const report = { status: "running", pid: process.pid, startedAt: Date.now(), sourceFingerprint: sourceFingerprint(), syntheticOnly: true, realModelValidated: false, targetHours: hours, iterations: 0, restarts: 0, maxRssBytes: 0, maxLatencyMs: 0, maxSchedulingGapMs: 0, patients: [], durationTargetMet: false };
  let server, origin, lastIteration = report.startedAt;
  const persist = () => { report.updatedAt = Date.now(); report.elapsedHours = (report.updatedAt - report.startedAt) / 3600000; writeFileSync(join(directory, "report.tmp"), JSON.stringify(report, null, 2), { mode: 0o600 }); renameSync(join(directory, "report.tmp"), join(directory, "report.json")); };
  const boot = async () => { server = createServer({ database: join(directory, "state.sqlite"), apiKey: "", followupOptions: { autoStart: false } }); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); }); origin = `http://127.0.0.1:${server.address().port}`; };
  const json = async (path, method = "GET", data) => { const response = await fetch(origin + path, { method, headers: { "content-type": "application/json", "x-medical-token": server.token }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000) }); const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body; };
  const controller = new AbortController(); for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
  persist();
  try {
    await boot();
    for (let i = 0; i < 12; i++) {
      const patient = await json("/api/patients", "POST", { name: `合成耐久患者${i}`, patientNumber: `SOAK-${i}`, medications: [{ name: "合成停用条目", status: "stopped" }] });
      report.patients.push(patient.id);
      for (let n = 0; n < 2; n++) await json(`/api/patients/${patient.id}/care-tasks`, "POST", { title: `合成长期跟进${n}`, kind: "referral", dueAt: new Date(Date.now() - 60000).toISOString() });
    }
    lastIteration = Date.now();
    while (!controller.signal.aborted && report.iterations < maximum && Date.now() < report.startedAt + hours * 3600000) {
      const start = Date.now(), index = report.iterations, id = report.patients[index % report.patients.length];
      report.maxSchedulingGapMs = Math.max(report.maxSchedulingGapMs, checkSoakContinuity(lastIteration, start, interval)); lastIteration = start;
      const care = { title: `合成第${index}次结果跟进`, kind: "test", dueAt: new Date().toISOString(), requestId: `soak-care-${index}` };
      const path = `/api/patients/${id}/care-tasks`, task = await json(path, "POST", care);
      assert.equal((await json(path, "POST", care)).id, task.id);
      await json(`${path}/${task.id}`, "PATCH", { expectedRevision: 0, action: "receive", source: "合成材料", note: "合成结果已收到" });
      await json(`${path}/${task.id}`, "PATCH", { expectedRevision: 1, action: "review", note: "合成记录已核对" });
      await json(`${path}/${task.id}`, "PATCH", { expectedRevision: 2, action: "complete", communication: "communicated", note: "合成沟通已记录" });
      const contact = { requestId: `soak-contact-${index}`, title: "合成随访", status: "completed", note: `合成联系内容${index}`, ...(index % 10 === 0 ? { nextDueAt: new Date(Date.now() + 86400000).toISOString() } : {}) };
      const outcome = await json(`/api/patients/${id}/followup-records`, "POST", contact);
      assert.equal((await json(`/api/patients/${id}/followup-records`, "POST", contact)).id, outcome.id);
      const brief = await json(`/api/patients/${id}/brief`);
      assert.equal(brief.outcomes[0].note, contact.note); assert.equal(brief.counts.careTasks, 2); assert.equal(brief.allergyStatus, "unknown"); assert.equal(brief.medications[0].status, "stopped");
      assert.equal((await json("/api/doctor/overview?kind=tracking")).total, 24);
      assert.equal((await json("/api/patients?summary=1")).patients.length, 12);
      assert.equal(server.store.db.prepare("SELECT count(*) n FROM care_tasks WHERE status='completed'").get().n, index + 1);
      assert.equal(server.store.db.prepare("SELECT count(*) n FROM reminders WHERE status='done'").get().n, index + 1);
      assert.equal(server.store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      report.iterations++; report.maxLatencyMs = Math.max(report.maxLatencyMs, Date.now() - start); report.maxRssBytes = Math.max(report.maxRssBytes, process.memoryUsage().rss);
      assert.ok(report.maxRssBytes < 768 * 1024 * 1024, "Medical soak RSS exceeded 768 MiB");
      if (report.iterations % 20 === 0) { await server.shutdown(); server = null; await boot(); report.restarts++; }
      persist();
      if (interval && report.iterations < maximum) await delay(Math.min(interval, Math.max(1, report.startedAt + hours * 3600000 - Date.now())), undefined, { signal: controller.signal }).catch((error) => { if (!controller.signal.aborted) throw error; });
    }
    if (!controller.signal.aborted) report.maxSchedulingGapMs = Math.max(report.maxSchedulingGapMs, checkSoakContinuity(lastIteration, Date.now(), interval));
    report.status = controller.signal.aborted ? "stopped" : "passed"; report.durationTargetMet = Date.now() >= report.startedAt + hours * 3600000;
    report.sourceUnchanged = sourceFingerprint() === report.sourceFingerprint;
    assert.ok(report.sourceUnchanged, "Frozen source changed during soak");
  } catch (error) { report.status = "failed"; report.error = error.message; process.exitCode = 1; }
  finally { await server?.shutdown(); report.endedAt = Date.now(); persist(); console.log(JSON.stringify({ status: report.status, iterations: report.iterations, report: join(directory, "report.json") })); }
}
