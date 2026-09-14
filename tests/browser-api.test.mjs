import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { api, bootstrap } from "../src/agent-runtime.js";

test("browser API preserves patient mutations, JSON payloads and context across token refresh", async (t) => {
  const f = await fixture(t);
  const realFetch = globalThis.fetch;
  let expireNext = false;
  t.mock.method(globalThis, "fetch", (path, options) => {
    if (expireNext && path !== "/api/bootstrap") {
      expireNext = false;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "expired" }), { status: 401 }),
      );
    }
    return realFetch(new URL(path, f.origin), options);
  });
  await bootstrap(true);
  const patient = await api("/api/patients", "POST", {
    name: "合成接口验证",
    groups: ["测试组"],
  });
  assert.equal(patient.name, "合成接口验证");
  const workspace = await api(`/api/sessions/${patient.sessionId}`);
  assert.equal(workspace.patientId, patient.id);
  assert.equal((await api("/api/sessions")).sessions[0].patientId, patient.id);
  expireNext = true;
  const updated = await api(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: patient.revision,
    note: "修改后仍属于同一患者",
  });
  assert.equal(updated.note, "修改后仍属于同一患者");
  const plan = await api(`/api/patients/${patient.id}/followups`, "POST", {
    name: "复核后的随访",
    intervalDays: 7,
    firstDueAt: new Date(Date.now() + 86400000).toISOString(),
    checklist: ["核对记录"],
  });
  assert.equal(plan.patientId, patient.id);
  const task = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "独立检索任务" }),
  });
  assert.equal(task.title, "独立检索任务");
  await api(`/api/patients/${patient.id}`, "DELETE");
  assert.equal((await api("/api/patients")).patients.length, 0);
  assert.equal((await api(`/api/sessions/${task.id}`)).title, "独立检索任务");
});
